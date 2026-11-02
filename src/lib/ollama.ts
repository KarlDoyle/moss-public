// Ollama safety defaults — the ONE place they live.
//
// Three gotchas have each cost a whole session on this machine, and every one of them fails
// silently (Taisce System/fallback-ladder.md, Tier 3):
//
//   1. num_ctx left unset → the daemon's default window (4096 here) silently drops whatever
//      does not fit. Found 2026-07-06, still live in moss until 2026-09-18.
//   2. A reasoning model (qwen3:*, deepseek-r1:*, qwq) with thinking on and no output cap
//      emits thinking tokens until the timeout — indistinguishable from a hung daemon.
//   3. No num_predict cap → one runaway reply holds the model for minutes.
//
// So every request moss sends to Ollama carries an explicit num_ctx, `think: false` and a
// num_predict cap, built here, and chat refuses a reasoning model outright. Nothing else in
// moss should set these values; import them.

// 16k holds the largest Taisce-skill prompt in use (standup with System/pulse.md, ~11k
// tokens) with room for the answer, and fits an 8B Q4 model on a 16GB Mac. Override with
// MOSS_OLLAMA_NUM_CTX for a bigger model or a bigger machine.
export const DEFAULT_NUM_CTX = 16_384;

// ~2k tokens is a long answer for a local model: at a measured ~20 tok/s that is under two
// minutes, well inside the five-minute generate timeout. Override with MOSS_OLLAMA_NUM_PREDICT.
export const DEFAULT_NUM_PREDICT = 2_048;

// Never ask a model to think. Sent on every request: harmless for a model without thinking,
// essential for one with it.
export const OLLAMA_THINK = false;

function intFromEnv(raw: string | undefined, min: number, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function resolveNumCtx(env: NodeJS.ProcessEnv = process.env): number {
  return intFromEnv(env.MOSS_OLLAMA_NUM_CTX, 2048, DEFAULT_NUM_CTX);
}

export function resolveNumPredict(env: NodeJS.ProcessEnv = process.env): number {
  return intFromEnv(env.MOSS_OLLAMA_NUM_PREDICT, 64, DEFAULT_NUM_PREDICT);
}

// Reasoning families. estate-mode (mac-setup) skips the same set; the two must agree.
const REASONING_MODEL = /^(qwen3|deepseek-r1|qwq)([:-]|$)/i;

export function isReasoningModel(name: string): boolean {
  return REASONING_MODEL.test(name);
}

export class ReasoningModelRefusedError extends Error {
  public readonly model: string;
  constructor(model: string) {
    super(
      `'${model}' is a reasoning model; moss never uses one for chat (it emits thinking tokens until the timeout and looks like a hung daemon). Pick another with /model, or pull a non-reasoning model such as llama3.1 or qwen2.5.`,
    );
    this.name = "ReasoningModelRefusedError";
    this.model = model;
  }
}

// Throws for a reasoning model. Chat calls this before every turn and on /model.
export function assertChatModel(name: string): void {
  if (isReasoningModel(name)) throw new ReasoningModelRefusedError(name);
}

export interface OllamaRequestSafety {
  readonly think: boolean;
  readonly options: Record<string, unknown>;
}

// The `think` flag and `options` block for an /api/generate or /api/chat body. `numCtx`
// and `numPredict` override the window and the cap for one call (a routing.yaml task row);
// everything else comes from the defaults above.
export function ollamaSafety(
  overrides: {
    readonly numCtx?: number;
    readonly numPredict?: number;
    readonly temperature?: number;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
): OllamaRequestSafety {
  const options: Record<string, unknown> = {
    num_ctx: overrides.numCtx ?? resolveNumCtx(env),
    num_predict: overrides.numPredict ?? resolveNumPredict(env),
  };
  if (overrides.temperature !== undefined) options.temperature = overrides.temperature;
  return { think: OLLAMA_THINK, options };
}

// The coder model Aider edits with (`/edit`). qwen2.5-coder:7b, 4.7GB Q4_K_M, chosen
// 2026-09-18 from the Ollama library: the best-established ~5GB coder, and one Aider already
// ships edit-format settings for. Measured on this Mac the same day at ~20 tok/s generation.
// Override with MOSS_CODER_MODEL.
export const DEFAULT_CODER_MODEL = "qwen2.5-coder:7b";

export function resolveCoderModel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MOSS_CODER_MODEL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_CODER_MODEL;
}

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
