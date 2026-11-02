# moss

## Project
Local-first AI CLI providing model routing, skills, MCP tool access, document
intelligence, and opt-in memory. TypeScript and pnpm.

## Rules
- Route subprocess calls through `src/lib/exec.ts`.
- Route filesystem access through `src/lib/paths.ts`.
- Route network calls through `src/lib/net.ts` and preserve its host allowlist.
- Never store or print secrets; keep provider credentials in the configured secure store.
- Keep tests and typechecking green before changes are proposed for merge.

## Reader-facing docs
Keep README, FIRST_RUN, OPERATOR_GUIDE, LIMITATIONS, and FUTURE accurate and
free of internal planning notes. Keep the command list and flags aligned with
`src/cli.ts`.
