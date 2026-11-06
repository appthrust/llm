package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/apphealth"
	"github.com/appthrust/appserver-go/appserver/health"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/releaseidentity"
)

const (
	maxRequestBytes = 4 << 20
	maxInFlight     = 2
	requestTimeout  = 300 * time.Second
)

// Redirects must not turn a completion into a request to a management endpoint
// or another host. The deadline includes the entire streamed response.
func upstreamClient() *http.Client {
	return &http.Client{
		Timeout: requestTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func newHandler(model string, maxPromptTokens int, upstream *url.URL, ready func() bool, outcomes *health.Outcomes) http.Handler {
	client := upstreamClient()
	slots := make(chan struct{}, maxInFlight)
	modelJSON, _ := json.Marshal(model)
	endpoint := upstream.String() + "/v1/chat/completions"
	var applicationHealth health.Registry
	applicationHealth.Capability("inference", true, health.CheckFunc(func(context.Context) health.Status {
		if !ready() {
			if outcomes.Last().State != apphealth.StateUnknown {
				return health.Status{State: apphealth.StateFailing, Reason: apphealth.ReasonDependencyUnavailable, Message: "The inference process is unavailable"}
			}
			return health.Status{State: apphealth.StateUnknown, Reason: apphealth.ReasonInitialising, Message: "The inference process has not completed model warmup"}
		}
		if last := outcomes.Last(); last.State != apphealth.StateUnknown {
			return last
		}
		// Supervisor.Ready requires a successful inference with the current model.
		return health.Status{State: apphealth.StateServing}
	}))
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if !ready() {
			outcomes.Record(false, apphealth.ReasonDependencyUnavailable)
			writeError(w, http.StatusServiceUnavailable, "llm_unavailable", "The chat model is not ready")
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			outcomes.Record(false, apphealth.ReasonResourceExhausted)
			writeError(w, http.StatusServiceUnavailable, "llm_busy", "At most two chat requests may run at once")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
		decoder := json.NewDecoder(r.Body)
		var body map[string]json.RawMessage
		err := decoder.Decode(&body)
		if err == nil {
			var extra json.RawMessage
			if next := decoder.Decode(&extra); next != io.EOF {
				err = next
				if err == nil {
					err = errors.New("multiple JSON values")
				}
			}
		}
		if err != nil || body == nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "Chat request body must not exceed 4 MiB")
			} else {
				writeError(w, http.StatusBadRequest, "invalid_request", "Chat request must be one JSON object")
			}
			return
		}
		if raw, ok := body["model"]; ok {
			var requested string
			if err := json.Unmarshal(raw, &requested); err != nil || requested != model {
				writeError(w, http.StatusBadRequest, "invalid_request", "model must match LLM_MODEL")
				return
			}
		}
		body["model"] = modelJSON
		payload, err := json.Marshal(body)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "The chat request could not be encoded")
			return
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "The chat request could not be created")
			return
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			outcomes.Record(false, apphealth.ReasonUpstreamUnavailable)
			if errors.Is(err, context.DeadlineExceeded) {
				writeError(w, http.StatusGatewayTimeout, "llm_timeout", "Chat request exceeded 300 seconds")
			} else {
				writeError(w, http.StatusBadGateway, "llm_upstream_unavailable", "The chat upstream could not complete this request")
			}
			return
		}
		defer response.Body.Close()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
		w.WriteHeader(response.StatusCode)
		var copyErr error
		if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
			// Copy bytes without parsing SSE: preserve deltas, usage, and [DONE].
			// Each upstream read is flushed before waiting for the next chunk.
			_, copyErr = io.Copy(flushWriter{w: w, controller: http.NewResponseController(w)}, response.Body)
		} else {
			_, copyErr = io.Copy(w, response.Body)
		}
		class := apphealth.ReasonUpstreamUnavailable
		if response.StatusCode == http.StatusTooManyRequests {
			class = apphealth.ReasonResourceExhausted
		}
		outcomes.Record(copyErr == nil && response.StatusCode >= 200 && response.StatusCode < 300, class)
	})
	mux.HandleFunc("GET /v1/models", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"object": "list",
			"data": []any{map[string]any{
				"id": model, "object": "model", "created": 0, "owned_by": "appthrust",
				"context_window": contextWindow, "appthrust.io/maxPromptTokens": maxPromptTokens,
			}},
		})
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !ready() {
			writeError(w, http.StatusServiceUnavailable, "llm_unavailable", "The chat model is not ready")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("GET "+health.Path, applicationHealth.Handler(releaseidentity.HealthIdentity("LLM")))
	mux.Handle("GET /releasez", releaseidentity.NewHandler("LLM", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusServiceUnavailable, "release_unavailable", "LLM release status unavailable")
	}))
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"model": model, "context_window": contextWindow, "appthrust.io/maxPromptTokens": maxPromptTokens,
		})
	})
	return mux
}

type flushWriter struct {
	w          http.ResponseWriter
	controller *http.ResponseController
}

func (w flushWriter) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	if err != nil {
		return n, err
	}
	return n, w.controller.Flush()
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	kind := "server_error"
	if status >= 400 && status < 500 {
		kind = "invalid_request_error"
	}
	httpx.WriteJSON(w, status, map[string]any{
		"error": map[string]any{"message": message, "type": kind, "param": nil, "code": code},
	})
}
