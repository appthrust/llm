# LLM

LLM is AppThrust's Project-local, CPU-only OpenAI-compatible chat provider. The
Go server runs as PID 1, supervises `ollama serve`, and serves the baked
`gemma3:4b` model from `/models`. The Project's AI Gateway discovers and calls
this provider. No prompt or document content leaves the cluster.

Model selection belongs to the release artifact, not callers. The Dockerfile's
`LLM_MODEL` supplies both the build-time pull and runtime default; no runtime
model pull is performed. Model files are read-only to UID 65532. Project
publication supplies the authenticated edge; the internal service has no second
authentication layer. The app releases independently of the platform.

## Develop

Use Go 1.26 or newer and Bun 1.4.1. The public Go SDK is
[`github.com/appthrust/appserver-go`](https://github.com/appthrust/appserver-go),
pinned to `v0.1.0` without a local replacement. No platform checkout is needed.

```sh
go build ./...
go vet ./...
go test ./...
bun test hack/
```

The Go tests use fake HTTP upstreams and cover model validation/injection,
body and admission boundaries, incremental SSE, warm-up failure/recovery,
configuration, application health, and release identity precedence. Publisher
tests use mocked APIs and need no packages or live services. These tests do not
prove real CPU inference, image publication, or a live installation.

For a local server with an existing Ollama instance and model:

```sh
LLM_MODEL=gemma3:4b LLM_OLLAMA_BIN= go run ./cmd/server --listen :8080
```

Build the image on its native architecture (the final stage runs Ollama to bake
the model). A full build downloads the model; a builder-only check does not:

```sh
docker build --platform linux/amd64 -t llm-local .
docker build --platform linux/amd64 --target server-builder -t llm-builder .
```

The image preserves the pinned Ollama
`0.40.4@sha256:926d40fd6eeeebd346b5c358a63de2a10ec995371cd93dd22f1843200694b1a6`
base shared with Embedding. Temporary build-time Ollama identity files are
removed. The image exposes port 8080 and starts `/llm-server` as UID 65532.
Only `go.mod`, `go.sum`, and `cmd/server` enter the Go builder.

## HTTP contract

Only these routes are exposed on port 8080:

| Route | Behavior |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat; omitted `model` is filled with the baked model. Any supplied model must equal it (including rejecting empty/null values). Other JSON fields are preserved. |
| `GET /v1/models` | OpenAI model list containing exactly the baked model, with standard `id`, `object`, `created`, and `owned_by` fields plus `context_window: 16384` and `appthrust.io/maxPromptTokens` from `LLM_MAX_PROMPT_TOKENS`. Callers discover the name and prompt budget here instead of hard-coding them. |
| `GET /healthz` | Go process liveness, including during an Ollama outage. |
| `GET /readyz` | 503 until `/api/tags` succeeds and one short chat completion with the baked model succeeds; 200 afterward. |
| `GET /releasez` | Complete environment release identity, otherwise the mounted release file; 503 if neither is available. |
| `GET /` | Baked `model`, `context_window: 16384`, and `appthrust.io/maxPromptTokens`, matching the model-list metadata. |

GET routes also support HEAD through the standard Go mux. Other paths return
404; methods not registered on these paths return 405. Ollama management routes
such as `/api/pull`, `/api/delete`, and `/api/tags` are never proxied. Upstream
redirects are not followed. Client bearer tokens and URL queries are not
forwarded to Ollama.

Chat accepts exactly one JSON object, at most **4 MiB**, with at most **two
in-flight requests**. Admission is held until the entire response finishes,
including streamed bodies. Excess requests return 503 instead of queueing.
The upstream deadline is **300 seconds**, including the streamed body.
Non-stream responses preserve upstream status, content type and body. SSE
responses preserve `text/event-stream` (including parameters) and every byte,
flush each received chunk, and forward `[DONE]` unchanged. A transport failure
or deadline after headers have been sent terminates the stream; it cannot
replace an already-started response with a JSON error.

Local errors use the OpenAI shape:

```json
{"error":{"message":"model must match LLM_MODEL","type":"invalid_request_error","param":null,"code":"invalid_request"}}
```

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid JSON object or a supplied model that differs from the baked model. |
| 413 | `request_too_large` | Body exceeds 4 MiB. |
| 503 | `llm_unavailable` | Model not ready. |
| 503 | `llm_busy` | Two chat requests already in flight. |
| 504 | `llm_timeout` | Upstream deadline expired before response headers. |
| 502 | `llm_upstream_unavailable` | Upstream connection/request failed before response headers. |
| 503 | `release_unavailable` | Release identity unavailable. |

Upstream errors pass through unchanged. Local 4xx errors have type
`invalid_request_error`; local 5xx errors have type `server_error`.

## Configuration and process lifecycle

The shared application-health endpoint is also available internally and is hidden
on public routes. It reports inference health separately from readiness.

The only flag is `--listen` (default `:8080`); positional arguments are rejected.

| Environment | Meaning |
| --- | --- |
| `LLM_MODEL` | Baked model tag, set by the image build. An unset/empty value is rejected; a standalone source build must supply it explicitly. Changing it does not download another model. |
| `LLM_MAX_PROMPT_TOKENS` | Advertised prompt-token budget for the model and CPU shape; `3000` in the image and when unset. Must be a positive integer; empty, invalid, or non-positive values fail startup with `LLM_MAX_PROMPT_TOKENS must be a positive integer`. This guides consumers; it is not a server-side request limit. |
| `LLM_UPSTREAM` | `http://127.0.0.1:11434`; HTTP(S) origin with no credentials, path except a trailing slash, query or fragment. |
| `LLM_OLLAMA_BIN` | `ollama` when unset. An explicitly empty value disables spawning for tests/external upstreams; otherwise invoked with the argument `serve`. |
| `PLATFORM_PROJECT_ID` | Project identity included in the startup log; no Platform API calls are made. |
| `OLLAMA_MODELS` | `/models` in the image, inherited by the child. |
| `OLLAMA_NO_CLOUD` | Forced to `1` for the supervised Ollama child, overriding inherited values and `ExtraEnv`; disables cloud features, including background model-recommendation fetches. |
| `LLAMA_ARG_CACHE_RAM` | LLM child sets `1024` MiB for the llama-server prompt-cache cap, overriding its 8192 MiB default to reduce resident memory at 16k context. This is not a total process-memory limit; Embedding does not set this override. |
| `LLM_RELEASE_VERSION`, `LLM_SOURCE_REVISION`, `LLM_ARTIFACT_DIGEST` | Controller-injected artifact identity. |
| `LLM_RELEASE_FILE` | Optional JSON identity file, read verbatim on each request when the required version and artifact digest environment fields are not both populated. |

The shared `releaseidentity.NewHandler` gives an environment version plus artifact
digest precedence over the file. It returns `releaseVersion` and `artifactDigest`,
with optional `sourceRevision`, and disables caching, matching Embedding.

Delivery identity (closure digest) is not injected into built-in apps.

The child always binds `127.0.0.1:11434`. Its supervisor overrides inherited
`OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_NO_CLOUD=1`, `OLLAMA_NUM_PARALLEL=1`,
`OLLAMA_MAX_LOADED_MODELS=1`, and `LLAMA_ARG_THREADS`. Threads equal
`ceil(quota/period)` from cgroup v2 `/sys/fs/cgroup/cpu.max`, falling back to
cgroup v1 `cpu.cfs_quota_us`/`cpu.cfs_period_us`. Unlimited or unavailable quotas
use `runtime.NumCPU()`. Readiness logs the effective value as
`ollama model ready (threads=N)`. LLM additionally sets
`OLLAMA_CONTEXT_LENGTH=16384`, using the same constant as the HTTP
`context_window` metadata, plus `CUDA_VISIBLE_DEVICES=-1` and
`ROCR_VISIBLE_DEVICES=-1` for CPU-only inference. Embedding shares the quota and
resident-model settings but does not add a context-length override.

Health is checked every second with a two-second probe timeout. Warm-up sends
one user message (`Reply OK.`), `stream:false`, and `max_tokens:1`; success must
return one assistant completion. Health alone never makes the service ready.
The model is warmed once per healthy lifecycle, and re-warmed after an outage
or child crash. Child exits/failed starts retry with exponential backoff from
one to 30 seconds, reset after a minute of uptime.

SIGINT/SIGTERM clears HTTP readiness, stops accepting requests and permits up to
ten seconds of HTTP draining. Then the supervisor signals the entire Ollama
process group with SIGTERM, waits up to ten seconds, escalates to SIGKILL if
needed and reaps the child. Descendant model runners cannot outlive it. External
mode does not signal or configure the external process; that process's owner
must apply its environment settings.

## Release

Create and push a SemVer tag, starting with `v0.2.0` (the existing catalog floor
owns `0.1.0`):

```sh
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/publish.yml` builds amd64 and arm64 natively on the
corresponding Blacksmith runners. Each build pushes
`ghcr.io/appthrust/llm:<version>-<arch>` and uploads its immutable digest. The
publish job creates `ghcr.io/appthrust/llm:<version>` from those two digests,
resolves the index digest, and signs it with Sigstore keyless signing. No QEMU
or npm credentials are needed. `GITHUB_TOKEN` needs `packages:write`; OIDC needs
`id-token:write`. The GHCR package must be made public after its first push so
installations can pull it anonymously.

Configure repository secret `CLOUD_CATALOG_ADMIN_TOKEN` and variable
`CLOUD_API_URL` (default `https://api.appthrust.com`). Grant this repository
access to organization secrets `APPTHRUST_GITHUB_ACTIONS_APP_ID` and
`APPTHRUST_GITHUB_ACTIONS_APP_PRIVATE_KEY`. The GitHub App must be installed for
`appthrust/cloud` with Contents write permission to send repository dispatches.
Cloud's API needs no GitHub credential.

Publication has two phases:

```sh
bun hack/publish-entry.ts submit --version 0.2.0 --digest sha256:<image-index-digest>
# If submit reports state=snapshot, dispatch with an installation token for Cloud:
gh api -X POST repos/appthrust/cloud/dispatches -f event_type=catalog-publish -f 'client_payload[snapshot_id]=<snapshot-id>'
bun hack/publish-entry.ts await --version 0.2.0 --digest sha256:<image-index-digest>
```

`submit` merges Cloud's existing version history with `catalog/entry.yaml`, PUTs
the complete entry to `/api/v1/catalog/entries/llm`, and POSTs
`/api/v1/catalog/publish`. HTTP 202 `{id, state: "queued"}` means Cloud dispatched
the publication; HTTP 200 `{id, state: "snapshot"}` requires dispatch. It writes
`snapshot_id` and `state` to `$GITHUB_OUTPUT` without polling. For `snapshot`
only, the workflow mints a short-lived GitHub App installation token scoped to
`appthrust/cloud` and dispatches `catalog-publish` with the snapshot id. Cloud's
workflow requires `CLOUD_CATALOG_API_URL` and `CLOUD_CATALOG_ADMIN_TOKEN`.

`await` needs no Cloud admin token. Every 15 seconds for at most 10 minutes it
fetches layer 0 (`index.json`) from `ghcr.io/appthrust/catalog:latest` through
ORAS, checks the layer digest, and requires the exact LLM version and image
digest. It verifies the immutable catalog signature against issuer
`https://token.actions.githubusercontent.com` and identity
`https://github.com/appthrust/cloud/.github/workflows/catalog-publish.yml@refs/heads/main`.
Dispatch alone is not success. Timeout, API failure, dispatch failure, or an
unverified artifact fails the release. Manual publication also needs the
workflow's ORAS 1.3.0 and Cosign 3.1.3.

## Catalog and image contract

- `catalog/entry.yaml` is the complete ApplicationStackDefinition. The publisher
  appends versions, not mutable image tags.
- The seed `0.1.0` keeps its original image digest as the compatibility floor.
  New versions use `ghcr.io/appthrust/llm@sha256:<index-digest>`,
  `stream: <major.minor>`, `served: true`, and `default: true`. Earlier versions
  stay served with defaults cleared. Definition and catalog versions agree.
- Version images are immutable. Repeating a version/digest is idempotent;
  replacing its digest fails. The workflow serializes LLM catalog writers.
- Moving from the seed's image repository requires an explicit installation
  version update with `replaceRepository: true`. Afterwards `follow` tracks its
  stream; `pinned` requires an explicit version update.
- `/releasez` keeps the `LLM` prefix and catalog-rendered `LLM_RELEASE_VERSION`
  and `LLM_ARTIFACT_DIGEST`. No platform release closure is involved.

Original server source: platform `cmd/llm-server/`. Catalog definition: Cloud's
LLM seed. Repository and publication layout follow the Directory app template.
