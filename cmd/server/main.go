package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/appthrust/appserver-go/apphealth"
	"github.com/appthrust/appserver-go/appserver/health"
	"github.com/appthrust/appserver-go/appserver/ollamasupervisor"
)

const (
	contextWindow          = 16384
	defaultMaxPromptTokens = 3000
)

type config struct {
	model           string
	maxPromptTokens int
	upstream        *url.URL
	ollamaBin       string
	projectID       string
}

func configFromEnv() (config, error) {
	cfg := config{model: os.Getenv("LLM_MODEL"), maxPromptTokens: defaultMaxPromptTokens, ollamaBin: "ollama", projectID: os.Getenv("PLATFORM_PROJECT_ID")}
	if cfg.model == "" {
		return config{}, errors.New("LLM_MODEL must identify the baked model")
	}
	if raw, set := os.LookupEnv("LLM_MAX_PROMPT_TOKENS"); set {
		budget, err := strconv.Atoi(raw)
		if err != nil || budget <= 0 {
			return config{}, errors.New("LLM_MAX_PROMPT_TOKENS must be a positive integer")
		}
		cfg.maxPromptTokens = budget
	}
	if bin, set := os.LookupEnv("LLM_OLLAMA_BIN"); set {
		cfg.ollamaBin = bin
	}
	upstream := os.Getenv("LLM_UPSTREAM")
	if upstream == "" {
		upstream = "http://127.0.0.1:11434"
	}
	u, err := url.Parse(upstream)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return config{}, errors.New("LLM_UPSTREAM must be an HTTP(S) origin without credentials, a path, query, or fragment")
	}
	u.Path, u.RawPath = "", ""
	cfg.upstream = u
	return cfg, nil
}

func main() {
	listen := flag.String("listen", ":8080", "HTTP listen address")
	flag.Parse()
	if flag.NArg() != 0 {
		log.Fatal("usage: llm-server [--listen :8080]")
	}
	cfg, err := configFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := serve(ctx, *listen, cfg); err != nil {
		log.Fatal(err)
	}
}

func serve(ctx context.Context, listen string, cfg config) error {
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	var outcomes health.Outcomes
	warmModel := warmup(cfg.model)
	s := ollamasupervisor.New(ollamasupervisor.Config{
		Bin: cfg.ollamaBin, Upstream: cfg.upstream.String(), Client: upstreamClient(),
		ExtraEnv: []string{"OLLAMA_CONTEXT_LENGTH=" + strconv.Itoa(contextWindow), "LLAMA_ARG_CACHE_RAM=1024", "CUDA_VISIBLE_DEVICES=-1", "ROCR_VISIBLE_DEVICES=-1"},
		Warmup: func(ctx context.Context, client *http.Client, upstream string) error {
			err := warmModel(ctx, client, upstream)
			if ctx.Err() == nil {
				outcomes.Record(err == nil, apphealth.ReasonDependencyUnavailable)
			}
			return err
		},
	})
	var draining atomic.Bool
	childCtx, cancelChild := context.WithCancel(context.Background())
	defer cancelChild()
	childDone := make(chan struct{})
	go func() {
		defer close(childDone)
		s.Run(childCtx)
	}()
	server := &http.Server{
		Handler:           newHandler(cfg.model, cfg.maxPromptTokens, cfg.upstream, func() bool { return !draining.Load() && s.Ready() }, &outcomes),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: requestTimeout,
		WriteTimeout: requestTimeout + 5*time.Second, IdleTimeout: 60 * time.Second,
	}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	log.Printf("llm-server listening on %s (project %s, model %s)", listener.Addr(), cfg.projectID, cfg.model)
	select {
	case <-ctx.Done():
	case err = <-served:
	}
	draining.Store(true)
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if shutdownErr := server.Shutdown(shutdown); shutdownErr != nil {
		log.Printf("HTTP shutdown: %v", shutdownErr)
		_ = server.Close()
	}
	cancelChild()
	<-childDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
