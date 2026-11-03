# Local chat and review validation

Run `pnpm test:live:workflows` from the Moss checkout with Ollama already
running and `qwen2.5:3b-instruct` installed. Set `MOSS_LIVE_OLLAMA_MODEL` to
another exact installed model tag if needed. The ordinary `pnpm test` skips
these live checks; CI does not need Ollama.

The opt-in test executes two chat turns through Moss's session and routing
code, checking that the second turn carries the first turn's context and that
both dispatches stay on Ollama. It also runs the bundled `code-review` and
`security-review` workflows against a newly created, synthetic Git repository.
For each review, it verifies a real Ollama response and token counts, and
compares the target file, Git index, HEAD and status before and after. The
target repository is deleted when the test finishes.

The harness rejects any provider ID other than `ollama` and network requests
outside the local daemon's `/api/tags` and `/api/generate` endpoints. It
records usage in memory and does not write a report, start/stop Ollama,
download a model or contact a hosted provider. Existing deterministic CLI,
routing, context-boundary and target-integrity tests remain in the normal
suite; this live check adds evidence of local model interoperability.

## Observed result — 3 November 2026

On the maintainer's Mac, the two chat turns and both review workflows passed
against the installed `qwen2.5:3b-instruct` model. The review fixture's file,
index, HEAD and status were unchanged after each model call. The run with the
bundled skill instructions took about 21 seconds. This checks execution and
containment on one machine;
it does not judge the usefulness or security accuracy of the model's answer,
validate hosted providers, or establish release readiness.
