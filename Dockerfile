# syntax=docker/dockerfile:1.18.0@sha256:dabfc0969b935b2080555ace70ee69a5261af8a8f1b4df97b9e7fbcf6722eddf

FROM --platform=$BUILDPLATFORM docker.io/golang:1.27.3 AS server-builder
WORKDIR /workspace
ARG TARGETOS
ARG TARGETARCH
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY cmd/server ./cmd/server
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags='-s -w' -o /out/llm-server ./cmd/server

# Stable release and multi-architecture index shared with Embedding.
FROM ollama/ollama:0.40.4@sha256:926d40fd6eeeebd346b5c358a63de2a10ec995371cd93dd22f1843200694b1a6 AS ollama-base
ENV LLM_MODEL=gemma3:4b \
    LLM_MAX_PROMPT_TOKENS=3000 \
    OLLAMA_MODELS=/models \
    OLLAMA_HOST=127.0.0.1:11434 \
    HOME=/home/nonroot

FROM ollama-base AS model-builder
# Export only the model and runtime home, never daemon identity or temporary
# directory metadata. Verify the manifest so a moved upstream tag fails closed.
RUN set -eu; \
    export HOME=/tmp/ollama-build OLLAMA_MODELS=/image-root/models; \
    ollama serve >/tmp/ollama-build.log 2>&1 & server=$!; \
    trap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT; \
    attempts=0; \
    until ollama list >/dev/null 2>&1; do \
        kill -0 "$server"; \
        attempts=$((attempts + 1)); \
        test "$attempts" -lt 120; \
        sleep 1; \
    done; \
    ollama pull "$LLM_MODEL"; \
    printf '%s  %s\n' \
        '68ceab7e468a31c988b44d5a4984a0e21f58c4f7158c6ce29c1804babac38df7' \
        "$OLLAMA_MODELS/manifests-v2/ollama.com/library/gemma3/4b" | sha256sum -c -; \
    kill "$server"; \
    wait "$server" || true; \
    trap - EXIT; \
    rm -rf /tmp/ollama-build /tmp/ollama-build.log; \
    mkdir -p /image-root/home/nonroot; \
    chown 65532:65532 /image-root/home/nonroot; \
    find /image-root/models -type d -exec chmod 0555 {} +; \
    find /image-root/models -type f -exec chmod 0444 {} +; \
    chmod 0755 /image-root /image-root/home /image-root/home/nonroot; \
    find /image-root -exec touch -h -d '@0' {} +

FROM ollama-base
# A sorted COPY of a fixed-content, fixed-metadata tree is independent of the
# pull time and server revision, even with a cold build cache.
COPY --link --from=model-builder /image-root/ /
COPY --from=server-builder /out/llm-server /llm-server
USER 65532
EXPOSE 8080
ENTRYPOINT ["/llm-server"]
