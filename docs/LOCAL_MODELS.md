# Rico local model runtime

Rico's preferred local route is the LM Studio model
`lmstudio/qwen/qwen3.6-35b-a3b`, backed by the loaded GGUF identifier
`qwen3.6-35b-a3b-gguf-local`. Local memory search uses
`text-embedding-nomic-embed-text-v1.5`.

## Required boundary

- LM Studio listens only on `127.0.0.1:1234` with CORS disabled.
- Sensitive and verbose request logging are disabled.
- The generation model runs with reasoning disabled and a 131,072-token
  active context. Studio does not assume the catalog maximum is loaded.
- The embedding canary must return exactly 768 dimensions.
- Studio admits the otherwise credential-free `lmstudio` provider only after
  an exact live inventory check, a visible `LOCAL_OK` generation canary, and
  the embedding canary pass.
- If the local proof fails, Studio excludes LM Studio and uses the next
  already-reviewed configured fallback. It never treats a missing local API
  key as a cloud authentication failure.

## Boot ownership

`~/Library/LaunchAgents/ai.openclaw.lmstudio-local.plist` invokes the private
`~/.lmstudio/bin/openclaw-lmstudio-start` helper at login and every five
minutes. The helper idempotently starts the LM Studio daemon, loads the exact
generation and embedding models if absent, and starts the loopback server.

The launcher is a one-shot health/recovery job, not the model process itself;
`state = not running` after an exit code of zero is normal. `StartInterval =
300` provides crash recovery without a busy keepalive loop.

## Verification

Before Rico Communications resumes, Studio verifies all of the following:

1. OpenClaw's LM Studio provider has the exact loopback Responses API config.
2. LM Studio's private server config disables CORS and sensitive/verbose logs.
3. Both exact models are loaded.
4. `/v1/responses` returns visible `LOCAL_OK` with thinking off.
5. `/v1/embeddings` returns one 768-dimensional vector.
6. OpenClaw's applied `rico-shared` route exactly matches the verified ordered
   default candidates.

The LM Studio server log directory and files are private (`0700`/`0600`).
Configuration backups created during the August 15 hardening are adjacent to
their source files and are not automatically deleted.
