import { readFile } from "node:fs/promises";
import { joinInsideProject } from "../paths.ts";
import { KarlContextPathError, resolveKarlContextRoot } from "./confine.ts";
import { type KarlContextConfig, KarlContextConfigSchema } from "./types.ts";

// Loader for config/karl-context.json (M12), mirroring src/lib/docs/config.ts.
// The config FILE lives inside the Moss project; its `path` field points at an
// EXTERNAL workspace and is validated by resolveKarlContextRoot (confine.ts).

const CONFIG_RELATIVE = "config/karl-context.json";

export const STARTER_KARL_CONTEXT_CONFIG = `{
  "enabled": false,
  "path": "~/context-workspace",
  "profiles": {
    "career": ["Domains/Career/**", "System/00-context-map.md"],
    "writing": ["System/03-writing-style.md"],
    "project": ["Domains/Ventures/**"]
  },
  "alwaysExclude": ["Sources/**", ".git/**"],
  "maxBytes": 32768
}
`;

export class KarlContextConfigInvalidError extends Error {
  constructor(path: string, detail: string) {
    super(`karl-context config at ${path} is malformed: ${detail}.`);
    this.name = "KarlContextConfigInvalidError";
  }
}

export interface KarlContextConfigLoaderDeps {
  readonly readFile: (path: string) => Promise<string>;
}

export const defaultKarlContextConfigLoaderDeps: KarlContextConfigLoaderDeps = {
  readFile: (path) => readFile(path, "utf8"),
};

export function karlContextConfigPath(): string {
  return joinInsideProject(CONFIG_RELATIVE);
}

function parse(raw: string, label: string): KarlContextConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new KarlContextConfigInvalidError(label, "file is not valid JSON");
  }
  const result = KarlContextConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new KarlContextConfigInvalidError(label, result.error.message);
  }
  // Validate the external root eagerly when enabled, so a broken path is a
  // load-time error rather than a surprise at dispatch. A disabled config is
  // allowed to name a not-yet-existent path.
  if (result.data.enabled) {
    try {
      resolveKarlContextRoot(result.data.path);
    } catch (error) {
      if (error instanceof KarlContextPathError) {
        throw new KarlContextConfigInvalidError(label, error.message);
      }
      throw error;
    }
  }
  return result.data;
}

export async function loadKarlContextConfig(
  deps: KarlContextConfigLoaderDeps = defaultKarlContextConfigLoaderDeps,
): Promise<KarlContextConfig | null> {
  const path = karlContextConfigPath();
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
  return parse(raw, path);
}

export function parseKarlContextConfigJson(raw: string, label = "inline"): KarlContextConfig {
  return parse(raw, label);
}
