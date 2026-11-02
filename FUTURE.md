# Future

Where Moss is heading. See [LIMITATIONS.md](LIMITATIONS.md) for current constraints.

## Next: v0.2 — interactive terminal interface

The focus is improving `moss chat` as a terminal AI interface: deterministic provider fallback, bounded optional workspace context, offline-first behaviour, cost/speed-aware routing, opt-in session persistence, and daily-driver polish.

Already landed toward v0.2:

- The first interactive `moss chat` session.
- Local usage logging for `ask` and `run` (metadata-only).
- A second diff-based skill, `security-review`, alongside `code-review`.
- Cost-aware routing across three lanes (local, subscription, metered API) by task type, with a daily API cap, `--explain` before any command, and `moss cost`.

Near-term follow-up: capture token counts from the LiteLLM lane (the first cut reads only Ollama's counts).

## Deferred (require an ADR or explicit approval)

- Semantic/RAG recall for memory (today: substring search only).
- OCR and PDF/image conversion.
- External (non-localhost) LiteLLM or MCP endpoints.
- Any further provider lane (OpenAI-compatible or otherwise) — each lands only with its own tests, like the three routed today.
- An automatic document-to-memory bridge.
- File-move execution after document review.
- A dedicated `moss usage --summary` reader.

## Non-goals

Agent loops on local models, hidden proxies, silent session watching, a web UI.
