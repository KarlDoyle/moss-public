// Generation-failure taxonomy for the M11 fallback policy.
//
// When the router dispatches a task to a provider and that provider's
// `generate()` throws, the router must decide whether to fall back to the
// next eligible lane or to surface the error immediately. This module is
// the single, pure place that decision is made. It performs no I/O and
// imports no provider implementation — it classifies an already-thrown
// error.
//
// Two dispositions:
//   - "retryable" — an operational failure of THIS lane that another lane
//     might not share (daemon down, model missing, remote dispatch error).
//     The router may advance to the next eligible provider.
//   - "terminal"  — must NOT be routed around. Two kinds:
//       1. A safety-boundary violation (`NetworkBoundaryError`): a probe or
//          generate tried to reach a destination outside the allowlist.
//          D-0012 invariant 3 requires this to propagate verbatim, even
//          mid-cascade — never downgraded, never swallowed.
//       2. Anything unrecognised: we default to terminal rather than
//          cascading blindly, so a programming bug (e.g. the router calling
//          generate without a resolved model) surfaces instead of being
//          masked by a fallback attempt. This mirrors the router's
//          "never default-success" stance from D-0011.
//
// Retryable membership is matched by error NAME rather than `instanceof`
// so this module stays decoupled from every provider implementation: a new
// lane declares its dispatch error name here without failure.ts importing
// its module (which would drag subprocess/network code into a pure file and
// risk the import-boundary test). NetworkBoundaryError is the one exception
// — it is safety-critical, so we match it by type for certainty.

import { NetworkBoundaryError } from "../net.ts";

export type FailureDisposition = "retryable" | "terminal";

// The dispatch-error names a provider may throw from `generate()` that the
// router is allowed to route around. Keep this list in sync with provider
// implementations:
//   - OllamaDaemonUnavailableError / OllamaModelMissingError  (ollama.ts)
//   - LiteLlmDispatchError                                    (litellm.ts)
//   - ClaudeCodeDispatchError                                 (claude-code.ts)
//   - AnthropicApiDispatchError                               (anthropic-api.ts)
// A lane that adds a new operational dispatch error adds its `name` here.
export const RETRYABLE_GENERATE_ERROR_NAMES: readonly string[] = [
  "OllamaDaemonUnavailableError",
  "OllamaModelMissingError",
  "LiteLlmDispatchError",
  "ClaudeCodeDispatchError",
  "AnthropicApiDispatchError",
];

// Classify a thrown generation error. Pure; safe to call on any value.
export function classifyGenerateFailure(error: unknown): FailureDisposition {
  // Safety boundary always wins — propagate verbatim (D-0012 invariant 3).
  if (error instanceof NetworkBoundaryError) return "terminal";
  if (error instanceof Error && RETRYABLE_GENERATE_ERROR_NAMES.includes(error.name)) {
    return "retryable";
  }
  // Unknown → terminal. Never cascade around an error we don't understand.
  return "terminal";
}

export function isRetryableGenerateFailure(error: unknown): boolean {
  return classifyGenerateFailure(error) === "retryable";
}
