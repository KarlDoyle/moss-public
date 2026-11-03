# Ollama-only live validation

Run `pnpm test:live:ollama` from the Moss checkout after starting Ollama and
installing `qwen2.5:3b-instruct`. To use another installed model, set
`MOSS_LIVE_OLLAMA_MODEL` to its exact tag. The command runs only
`tests/live/ollama.live.test.ts`; the ordinary `pnpm test` skips that test.

The test pins `moss ask` to `ollama`, permits network requests only to the
local daemon's `/api/tags` and `/api/generate` endpoints, and checks the
returned model, nonempty answer, JSON output and real input/output token
counts. It records usage in memory rather than writing the operator's usage
log. It does not probe or invoke Claude Code or Anthropic API, and it does not
download a model or start/stop Ollama.

The older combined live-test flag, `MOSS_LIVE=1`, no longer enables hosted
probes. The hosted tests require `MOSS_LIVE_HOSTED=1` separately and are not
part of `pnpm test:live:ollama` or normal CI. Do not set that flag for local
validation.

## Observed result — 3 November 2026

On the maintainer's Mac, the already-running local Ollama daemon served
`qwen2.5:3b-instruct`. `pnpm test:live:ollama` passed: one routed request,
one nonempty answer, and positive Ollama-reported input and output token
counts. The test itself took approximately 1.7 seconds. This is live local
interoperability evidence for one model and one `ask` path, not a claim about
other machines, model quality, chat, review workflows, hosted providers or
release readiness.

Deterministic error-path coverage remains in
`tests/lib/providers/ollama.test.ts`,
`tests/lib/providers/ollama.provider.test.ts` and
`tests/regression/provider-intent.test.ts`: daemon outage, missing model,
malformed responses, provider pinning and refusal/fallback behavior use
fixtures so CI does not depend on a running model.
