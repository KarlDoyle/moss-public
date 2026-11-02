// PATH-based binary detection shared by the M3-T06 detection-only
// lanes (`codex`, `copilot-cli`, `opencode`).
//
// Safety surface:
//   - Reads only `process.env.PATH`. No other env vars are touched.
//   - Performs `fs.existsSync` on each PATH directory + the binary
//     name. No reads of contents, no writes, no symlink following
//     beyond what node's existsSync already does.
//   - No subprocess invocation. Stays well clear of the Moss exec
//     allowlist; adding new CLIs to that allowlist would be a
//     deliberate scope expansion and is intentionally NOT done here.
//   - The detection result is boolean. We never extract a CLI's
//     version, never call the CLI, never read its config.
//
// This is the entire I/O footprint of every detection-only lane in
// M3. The lanes do NOT implement `generate` — they exist so that
// `moss auth` can honestly report whether the underlying tool is
// present on the operator's box, not so that Moss can drive it. T06
// is detection only; integration belongs to M4+ (per the M3 memo).

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface DetectionEnv {
  // `process.env.PATH` by default. Injectable so tests can pin the
  // search list to a deterministic, hermetic value.
  readonly path: string | undefined;
}

export const defaultDetectionEnv: DetectionEnv = {
  path: process.env.PATH,
};

// Returns true iff a file with the given name exists in any directory
// listed in `env.path`. Falsy/empty PATH yields false. Errors from
// `existsSync` (very rare; usually permission-denied at a parent
// directory) are NOT swallowed silently here — the caller wraps this
// in its own try/catch and reports the resulting probe as `unknown`.
export function binaryOnPath(name: string, env: DetectionEnv = defaultDetectionEnv): boolean {
  const pathValue = env.path;
  if (pathValue === undefined || pathValue.length === 0) return false;
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue;
    if (existsSync(join(dir, name))) return true;
  }
  return false;
}
