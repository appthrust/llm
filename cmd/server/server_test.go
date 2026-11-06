package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/apphealth"
	"github.com/appthrust/appserver-go/appserver/health"
	"github.com/appthrust/appserver-go/appserver/ollamasupervisor"
	"github.com/stretchr/testify/require"
)

const testModel = "baked-chat-model"
const completion = `{"id":"chat-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"Hello"},"finish_reason":"stop"}]}`

func handlerForTest(t *testing.T, upstream string, ready func() bool) http.Handler {
	t.Helper()
	u, err := url.Parse(upstream)
	require.NoError(t, err)
	return newHandler(testModel, defaultMaxPromptTokens, u, ready, &health.Outcomes{})
}

func requestForTest(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
	return w
}

func chatResponse(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, completion)
}

func TestProxyInjectsModelAndOnlyForwardsChat(t *testing.T) {
	requests := make(chan *http.Request, 4)
	bodies := make(chan map[string]any, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode forwarded body: %v", err)
		}
		requests <- r
		bodies <- body
		chatResponse(w)
	}))
	defer upstream.Close()
	h := handlerForTest(t, upstream.URL, func() bool { return true })
	for _, model := range []string{"", `,"model":"` + testModel + `"`} {
		r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions?ignored=1", strings.NewReader(`{"messages":[{"role":"user","content":"hello"}],"temperature":0.5,"stream":false`+model+`}`))
		r.Header.Set("Authorization", "Bearer private-user-token")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		require.Equal(t, "application/json", w.Header().Get("Content-Type"))
		require.Equal(t, completion, w.Body.String())
		forwarded, body := <-requests, <-bodies
		require.Equal(t, http.MethodPost, forwarded.Method)
		require.Equal(t, "/v1/chat/completions", forwarded.URL.Path)
		require.Empty(t, forwarded.URL.RawQuery)
		require.Empty(t, forwarded.Header.Get("Authorization"))
		require.Equal(t, testModel, body["model"])
		require.Equal(t, []any{map[string]any{"role": "user", "content": "hello"}}, body["messages"])
		require.Equal(t, 0.5, body["temperature"])
		require.Equal(t, false, body["stream"])
	}
	for _, path := range []string{"/api/tags", "/api/pull", "/api/delete", "/v1/embeddings", "/v1/chat/completions/extra", "/other"} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
			require.Equal(t, http.StatusNotFound, requestForTest(h, method, path, `{}`).Code, path)
		}
	}
	require.Equal(t, http.StatusMethodNotAllowed, requestForTest(h, http.MethodGet, "/v1/chat/completions", "").Code)
	require.Equal(t, http.StatusMethodNotAllowed, requestForTest(h, http.MethodPost, "/v1/models", "").Code)
	require.Empty(t, requests)
	require.JSONEq(t, `{"model":"`+testModel+`","context_window":16384,"appthrust.io/maxPromptTokens":3000}`, requestForTest(h, http.MethodGet, "/", "").Body.String())
	models := requestForTest(h, http.MethodGet, "/v1/models", "")
	require.Equal(t, http.StatusOK, models.Code)
	require.JSONEq(t, `{"object":"list","data":[{"id":"`+testModel+`","object":"model","created":0,"owned_by":"appthrust","context_window":16384,"appthrust.io/maxPromptTokens":3000}]}`, models.Body.String())
}

func TestProxyRejectsInvalidModelAndOversizedRequests(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		chatResponse(w)
	}))
	defer upstream.Close()
	h := handlerForTest(t, upstream.URL, func() bool { return true })
	for _, body := range []string{``, `null`, `[]`, `{`, `{} {}`, `{"model":"other"}`, `{"model":""}`, `{"model":null}`, `{"model":42}`} {
		w := requestForTest(h, http.MethodPost, "/v1/chat/completions", body)
		require.Equal(t, http.StatusBadRequest, w.Code, body)
		var result struct {
			Error struct {
				Message string `json:"message"`
				Type    string `json:"type"`
				Param   any    `json:"param"`
				Code    string `json:"code"`
			} `json:"error"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
		require.NotEmpty(t, result.Error.Message)
		require.Equal(t, "invalid_request_error", result.Error.Type)
		require.Equal(t, "invalid_request", result.Error.Code)
		require.Nil(t, result.Error.Param)
	}
	prefix, suffix := `{"messages":[{"role":"user","content":"`, `"}]}`
	body := prefix + strings.Repeat("x", maxRequestBytes-len(prefix)-len(suffix)) + suffix
	require.Equal(t, http.StatusOK, requestForTest(h, http.MethodPost, "/v1/chat/completions", body).Code)
	w := requestForTest(h, http.MethodPost, "/v1/chat/completions", body+" ")
	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code)
	require.Contains(t, w.Body.String(), "request_too_large")
	require.Equal(t, int32(1), calls.Load())
}

func TestStreamFlushesEachChunkAndPreservesDone(t *testing.T) {
	const first = "data: {\"choices\":[{\"delta\":{\"content\":\"こんにちは\"}}]}\n\n"
	const last = "data: {\"choices\":[],\"usage\":{\"completion_tokens\":1}}\n\ndata: [DONE]\n\n"
	release := make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["stream"] != true || body["model"] != testModel {
			t.Errorf("invalid streaming request: %v %v", body, err)
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		_, _ = io.WriteString(w, first)
		_ = http.NewResponseController(w).Flush()
		select {
		case <-release:
			_, _ = io.WriteString(w, last)
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	defer unblock()
	server := httptest.NewServer(handlerForTest(t, upstream.URL, func() bool { return true }))
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(server.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"stream":true,"messages":[{"role":"user","content":"hello"}]}`))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "text/event-stream; charset=utf-8", resp.Header.Get("Content-Type"))
	reader := bufio.NewReader(resp.Body)
	line, err := reader.ReadString('\n')
	require.NoError(t, err, "first chunk must arrive before upstream completes")
	blank, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, first, line+blank)
	unblock()
	rest, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.Equal(t, last, string(rest))
}

func TestProxyRejectsThirdInFlightStream(t *testing.T) {
	entered, release := make(chan struct{}, 2), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {}\n\n")
		_ = http.NewResponseController(w).Flush()
		entered <- struct{}{}
		<-release
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	h := handlerForTest(t, upstream.URL, func() bool { return true })
	results := make(chan int, 2)
	for range 2 {
		go func() { results <- requestForTest(h, http.MethodPost, "/v1/chat/completions", `{"stream":true}`).Code }()
	}
	for range 2 {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("two requests did not reach upstream")
		}
	}
	w := requestForTest(h, http.MethodPost, "/v1/chat/completions", `{}`)
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.Contains(t, w.Body.String(), "llm_busy")
	unblock()
	for range 2 {
		select {
		case status := <-results:
			require.Equal(t, http.StatusOK, status)
		case <-time.After(5 * time.Second):
			t.Fatal("admitted stream did not complete")
		}
	}
	require.Equal(t, http.StatusOK, requestForTest(h, http.MethodPost, "/v1/chat/completions", `{}`).Code)
}

func TestProxyDoesNotFollowRedirectsAndPreservesErrors(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected management request: %s", r.URL.Path)
		}
		if calls.Load() == 1 {
			http.Redirect(w, r, "/api/pull", http.StatusTemporaryRedirect)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"message":"messages are required"}}`)
	}))
	defer upstream.Close()
	h := handlerForTest(t, upstream.URL, func() bool { return true })
	w := requestForTest(h, http.MethodPost, "/v1/chat/completions", `{}`)
	require.Equal(t, http.StatusTemporaryRedirect, w.Code)
	require.Equal(t, int32(1), calls.Load())
	w = requestForTest(h, http.MethodPost, "/v1/chat/completions", `{}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.JSONEq(t, `{"error":{"message":"messages are required"}}`, w.Body.String())
}

func TestProxyDeadlineAndUnavailable(t *testing.T) {
	h := handlerForTest(t, "http://127.0.0.1:1", func() bool { return true })
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`)).WithContext(ctx)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request)
	require.Equal(t, http.StatusGatewayTimeout, w.Code)
	require.Contains(t, w.Body.String(), "llm_timeout")
	require.Equal(t, 300*time.Second, upstreamClient().Timeout)
	w = requestForTest(h, http.MethodPost, "/v1/chat/completions", `{}`)
	require.Equal(t, http.StatusBadGateway, w.Code)
	require.Contains(t, w.Body.String(), "llm_upstream_unavailable")
}

func TestReadinessRequiresSuccessfulChatWarmupAndRecovers(t *testing.T) {
	var available atomic.Bool
	warming, respond := make(chan struct{}, 8), make(chan bool, 8)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/tags":
			if !available.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_, _ = io.WriteString(w, `{"models":[]}`)
		case "/v1/chat/completions":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["model"] != testModel || body["stream"] != false || body["max_tokens"] != float64(1) {
				t.Errorf("invalid warm-up: %v %v", body, err)
			}
			warming <- struct{}{}
			select {
			case success := <-respond:
				if !success {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				chatResponse(w)
			case <-r.Context().Done():
			}
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer upstream.Close()
	s := ollamasupervisor.New(ollamasupervisor.Config{
		Upstream: upstream.URL, Client: upstreamClient(), Warmup: warmup(testModel),
		PollInterval: 5 * time.Millisecond,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); s.Run(ctx) }()
	defer func() { cancel(); <-done }()
	h := handlerForTest(t, upstream.URL, s.Ready)
	require.Equal(t, http.StatusOK, requestForTest(h, http.MethodGet, "/healthz", "").Code)
	require.Equal(t, http.StatusServiceUnavailable, requestForTest(h, http.MethodGet, "/readyz", "").Code)
	require.Equal(t, http.StatusServiceUnavailable, requestForTest(h, http.MethodPost, "/v1/chat/completions", `{}`).Code)
	awaitWarm := func() {
		t.Helper()
		select {
		case <-warming:
		case <-time.After(5 * time.Second):
			t.Fatal("warm-up never started")
		}
		require.False(t, s.Ready(), "health alone must not make the model ready")
	}
	available.Store(true)
	awaitWarm()
	respond <- false
	awaitWarm()
	respond <- true
	require.Eventually(t, s.Ready, 5*time.Second, time.Millisecond)
	require.Equal(t, http.StatusOK, requestForTest(h, http.MethodGet, "/readyz", "").Code)
	available.Store(false)
	require.Eventually(t, func() bool { return !s.Ready() }, 5*time.Second, time.Millisecond)
	available.Store(true)
	awaitWarm()
	respond <- true
	require.Eventually(t, s.Ready, 5*time.Second, time.Millisecond)
	cancel()
	<-done
	require.False(t, s.Ready())
}

func TestWarmupRejectsInvalidCompletion(t *testing.T) {
	for _, response := range []string{`{}`, `{"choices":[]}`, `{"choices":[{"message":{"role":"user"}}]}`, `not json`} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, response)
		}))
		require.Error(t, warmup(testModel)(context.Background(), upstreamClient(), upstream.URL))
		upstream.Close()
	}
}

func TestReleaseIdentityEnvironmentAndFile(t *testing.T) {
	values := map[string]string{
		"LLM_RELEASE_VERSION": "release", "LLM_SOURCE_REVISION": "",
		"LLM_ARTIFACT_DIGEST": "digest",
		"LLM_RELEASE_FILE":    "",
	}
	for key := range values {
		t.Setenv(key, "")
	}
	handler := func() http.Handler { return handlerForTest(t, "http://127.0.0.1:1", func() bool { return false }) }
	require.Equal(t, http.StatusServiceUnavailable, requestForTest(handler(), http.MethodGet, "/releasez", "").Code)
	file := filepath.Join(t.TempDir(), "release.json")
	stamp := `{"releaseVersion":"file","sourceRevision":"file-revision","artifactDigest":"file-digest"}`
	require.NoError(t, os.WriteFile(file, []byte(stamp), 0600))
	t.Setenv("LLM_RELEASE_FILE", file)
	t.Setenv("LLM_RELEASE_VERSION", "partial-env")
	w := requestForTest(handler(), http.MethodGet, "/releasez", "")
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	require.JSONEq(t, stamp, w.Body.String())
	for key, value := range values {
		if key != "LLM_RELEASE_FILE" {
			t.Setenv(key, value)
		}
	}
	w = requestForTest(handler(), http.MethodGet, "/releasez", "")
	require.JSONEq(t, `{"releaseVersion":"release","artifactDigest":"digest"}`, w.Body.String())
	t.Setenv("LLM_ARTIFACT_DIGEST", "")
	t.Setenv("LLM_RELEASE_FILE", file+".missing")
	require.Equal(t, http.StatusServiceUnavailable, requestForTest(handler(), http.MethodGet, "/releasez", "").Code)
}

func TestEnvironmentDefaultsAndOverrides(t *testing.T) {
	for _, name := range []string{"LLM_MODEL", "LLM_MAX_PROMPT_TOKENS", "LLM_UPSTREAM", "LLM_OLLAMA_BIN", "PLATFORM_PROJECT_ID"} {
		t.Setenv(name, "")
		require.NoError(t, os.Unsetenv(name))
	}
	t.Setenv("LLM_MODEL", testModel)
	cfg, err := configFromEnv()
	require.NoError(t, err)
	require.Equal(t, testModel, cfg.model)
	require.Equal(t, 3000, cfg.maxPromptTokens)
	require.Equal(t, "http://127.0.0.1:11434", cfg.upstream.String())
	require.Equal(t, "ollama", cfg.ollamaBin)
	require.Empty(t, cfg.projectID)
	t.Setenv("LLM_OLLAMA_BIN", "")
	t.Setenv("LLM_MODEL", "another-baked-model")
	t.Setenv("LLM_MAX_PROMPT_TOKENS", "2400")
	t.Setenv("LLM_UPSTREAM", "http://127.0.0.1:11435/")
	t.Setenv("PLATFORM_PROJECT_ID", "pj-test")
	cfg, err = configFromEnv()
	require.NoError(t, err)
	require.Empty(t, cfg.ollamaBin)
	require.Equal(t, "another-baked-model", cfg.model)
	require.Equal(t, 2400, cfg.maxPromptTokens)
	require.Equal(t, "http://127.0.0.1:11435", cfg.upstream.String())
	require.Equal(t, "pj-test", cfg.projectID)
	for _, raw := range []string{"file:///tmp/socket", "http://user:password@localhost", "http://localhost/api", "http://localhost?x=1", "http://localhost?", "http://localhost#fragment"} {
		t.Setenv("LLM_UPSTREAM", raw)
		_, err := configFromEnv()
		require.ErrorContains(t, err, "LLM_UPSTREAM must be an HTTP(S) origin")
	}
	t.Setenv("LLM_MODEL", "")
	_, err = configFromEnv()
	require.ErrorContains(t, err, "LLM_MODEL must identify the baked model")
}

func TestModelMetadataUsesConfiguredPromptBudget(t *testing.T) {
	t.Setenv("LLM_MODEL", testModel)
	t.Setenv("LLM_UPSTREAM", "")
	for _, budget := range []string{"1", "2400"} {
		t.Run(budget, func(t *testing.T) {
			t.Setenv("LLM_MAX_PROMPT_TOKENS", budget)
			cfg, err := configFromEnv()
			require.NoError(t, err)
			h := newHandler(cfg.model, cfg.maxPromptTokens, cfg.upstream, func() bool { return false }, &health.Outcomes{})
			root := requestForTest(h, http.MethodGet, "/", "")
			require.Equal(t, http.StatusOK, root.Code)
			require.JSONEq(t, `{"model":"`+testModel+`","context_window":16384,"appthrust.io/maxPromptTokens":`+budget+`}`, root.Body.String())
			models := requestForTest(h, http.MethodGet, "/v1/models", "")
			require.Equal(t, http.StatusOK, models.Code)
			require.JSONEq(t, `{"object":"list","data":[{"id":"`+testModel+`","object":"model","created":0,"owned_by":"appthrust","context_window":16384,"appthrust.io/maxPromptTokens":`+budget+`}]}`, models.Body.String())
		})
	}
}

func TestEnvironmentRejectsInvalidMaxPromptTokens(t *testing.T) {
	t.Setenv("LLM_MODEL", testModel)
	t.Setenv("LLM_UPSTREAM", "")
	for _, raw := range []string{"", "invalid", "1.5", "0", "-1", " 3000 ", "999999999999999999999999999999"} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv("LLM_MAX_PROMPT_TOKENS", raw)
			_, err := configFromEnv()
			require.EqualError(t, err, "LLM_MAX_PROMPT_TOKENS must be a positive integer")
		})
	}
}

func TestApplicationHealthTracksInferenceWithoutChangingReadiness(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer upstream.Close()
	h := handlerForTest(t, upstream.URL, func() bool { return true })
	for range 3 {
		require.Equal(t, http.StatusBadGateway, requestForTest(h, http.MethodPost, "/v1/chat/completions", `{"messages":[]}`).Code)
	}
	w := requestForTest(h, http.MethodGet, health.Path, "")
	require.Equal(t, http.StatusOK, w.Code)
	var report apphealth.Report
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &report))
	require.NoError(t, report.Validate([]string{"inference"}))
	require.Equal(t, apphealth.StateFailing, report.Capabilities[0].State)
	require.Equal(t, apphealth.ReasonUpstreamUnavailable, report.Capabilities[0].Reason)
	require.Equal(t, http.StatusOK, requestForTest(h, http.MethodGet, "/readyz", "").Code)
	r := httptest.NewRequest(http.MethodGet, health.Path, nil)
	r.Header.Set(apphealth.PublicRouteHeader, "true")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	require.Equal(t, http.StatusNotFound, w.Code)
}
