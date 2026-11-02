// LiteLLM config schema + loader for M5.
//
// Operator-facing contract:
//   - The config file lives at `config/litellm.json` inside the
//     project root. Moss never reads configs from outside the project.
//   - `enabled: false` means the default M1-M4 flow is preserved
//     verbatim — no allowlist changes, no provider lane visible.
//   - `endpointUrl` MUST be a localhost URL (127.0.0.1, ::1, or
//     localhost). External endpoints are out of scope for M5 and are
//     rejected at schema parse time (D-0015). A future ADR is required
//     to widen this.
//   - Pure schema + loader. No I/O at module-load time. The session
//     bootstrap calls `loadLiteLlmConfig()` exactly once and caches.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { joinInsideProject } from "../paths.ts";

const CONFIG_RELATIVE = "config/litellm.json";

const LOCALHOST_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const localhostUrl = z.string().refine(
  (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!LOCALHOST_HOSTS.has(url.hostname)) return false;
    return true;
  },
  {
    message:
      "endpointUrl must be a localhost http(s) URL — 127.0.0.1, ::1, or localhost (D-0015). External endpoints require a future ADR.",
  },
);

export const LiteLlmModelSchema = z
  .object({
    // The model name as exposed by the LiteLLM proxy. The receiving
    // proxy decides how to translate to an upstream model id.
    name: z.string().min(1),
    // Optional human-readable family hint (informational; not enforced).
    family: z.string().optional(),
    // Acknowledgement that this model is dispatched via LiteLLM. The
    // literal-true requirement makes the operator's intent explicit
    // and prevents a stray entry from accidentally enabling a lane.
    viaLiteLLM: z.literal(true),
  })
  .strict();

export const LiteLlmConfigSchema = z
  .object({
    enabled: z.boolean(),
    endpointUrl: localhostUrl,
    // Optional list of models the proxy can serve. Informational — the
    // router does NOT route to specific models via this list yet;
    // that's reserved for a future milestone with an ADR.
    models: z.array(LiteLlmModelSchema).default([]),
    // Optional operator note. Pinned by tests as a "non-enforced"
    // field (M5 acceptance criterion: non-enforced fields clearly
    // marked). The schema accepts any string and Moss never acts on it.
    notes: z.string().optional(),
  })
  .strict();

export type LiteLlmConfig = z.infer<typeof LiteLlmConfigSchema>;
export type LiteLlmModel = z.infer<typeof LiteLlmModelSchema>;

export class LiteLlmConfigInvalidError extends Error {
  constructor(path: string, detail: string) {
    super(
      `LiteLLM config at ${path} is malformed or violates the localhost-only safety bound (D-0015): ${detail}.`,
    );
    this.name = "LiteLlmConfigInvalidError";
  }
}

export interface LiteLlmConfigLoaderDeps {
  readonly readFile: (path: string) => Promise<string>;
}

export const defaultLiteLlmConfigLoaderDeps: LiteLlmConfigLoaderDeps = {
  readFile: (path) => readFile(path, "utf8"),
};

export function liteLlmConfigPath(): string {
  return joinInsideProject(CONFIG_RELATIVE);
}

// Returns `null` when the config file is absent. `enabled: false`
// configs are parsed and returned as-is — callers MUST check
// `config.enabled` before treating LiteLLM as wired.
export async function loadLiteLlmConfig(
  deps: LiteLlmConfigLoaderDeps = defaultLiteLlmConfigLoaderDeps,
): Promise<LiteLlmConfig | null> {
  const path = liteLlmConfigPath();
  let raw: string;
  try {
    raw = await deps.readFile(path);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LiteLlmConfigInvalidError(path, message);
  }

  const result = LiteLlmConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new LiteLlmConfigInvalidError(path, result.error.message);
  }
  return result.data;
}

// Resolves the localhost host:port from an enabled config. Returns
// `null` when the config is null or disabled. Used by `src/lib/net.ts`
// to extend the allowlist for this session ONLY when the operator
// has explicitly opted in. The returned tuple is used to construct
// a UrlPolicy entry — never echoed back into prose/logs to avoid
// leaking the operator's port choice in error messages.
export function enabledLocalhostEndpoint(config: LiteLlmConfig | null): {
  host: string;
  port: number;
  protocol: "http:" | "https:";
} | null {
  if (config === null || config.enabled !== true) return null;
  const url = new URL(config.endpointUrl);
  return {
    host: url.hostname,
    port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number.parseInt(url.port, 10),
    protocol: url.protocol === "https:" ? "https:" : "http:",
  };
}
