// The `claude -p` command line moss runs, and the JSON it prints back. Pure — no I/O.
// Every call is isolated: no tools, no setting sources (so no hooks), no MCP servers, no slash
// commands, no saved session, and moss's own system prompt instead of Claude Code's.

export const CLAUDE_ISOLATION_ARGS: readonly string[] = [
  "--tools",
  "",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--exclude-dynamic-system-prompt-sections",
];

const DEFAULT_SYSTEM =
  "You are answering inside moss, a terminal tool. You have no tools. Answer directly.";
export function buildClaudeArgs(model: string, system: string | undefined): string[] {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    ...CLAUDE_ISOLATION_ARGS,
    "--system-prompt",
    system !== undefined && system.trim().length > 0 ? system : DEFAULT_SYSTEM,
  ];
}

export interface ClaudeJson {
  readonly isError: boolean;
  readonly result: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

// `claude -p --output-format json` prints one result object. Cache reads and writes count as
// input: they are tokens the model read.
export function parseClaudeJson(stdout: string): ClaudeJson | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).is_error !== "boolean" ||
    typeof (value as Record<string, unknown>).result !== "string"
  ) {
    return null;
  }
  const d = value as Record<string, unknown>;
  const usage = (d.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const input =
    num(usage.input_tokens) +
    num(usage.cache_read_input_tokens) +
    num(usage.cache_creation_input_tokens);
  return {
    isError: d.is_error === true,
    result: typeof d.result === "string" ? d.result : "",
    ...(d.usage !== undefined
      ? { inputTokens: input, outputTokens: num(usage.output_tokens) }
      : {}),
    ...(typeof d.total_cost_usd === "number" ? { costUsd: d.total_cost_usd } : {}),
  };
}
