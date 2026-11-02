import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { getProjectRoot, joinInsideProject, resolveInsideProject } from "../paths.ts";
import { type DocsConfig, DocsConfigSchema } from "./types.ts";

const CONFIG_RELATIVE = "config/docs.json";

const BLOCKED_PATH_MARKERS: readonly string[] = ["Mobile Documents", "iCloud", "CloudDocs"];

export const STARTER_DOCS_CONFIG = `{
  "enabled": false,
  "approvedFolder": "tests/fixtures/docs",
  "outputFolder": "output/docs",
  "reviewQueuePath": "output/review/queue.json",
  "notes": "M7 conservative contract (D-0017): fixture corpus first; approved folder must stay inside the Moss project; raw sources are read-only; derivatives land only under output/; no automatic moves."
}
`;

export class DocsConfigInvalidError extends Error {
  constructor(path: string, detail: string) {
    super(`Document config at ${path} is malformed: ${detail}.`);
    this.name = "DocsConfigInvalidError";
  }
}

export class DocsConfigBlockedPathError extends Error {
  constructor(path: string, marker: string) {
    super(
      `Document config path '${path}' is blocked (contains '${marker}'). M7 does not scan personal or iCloud folders. Point approvedFolder at a Moss fixture corpus or another explicit in-project folder.`,
    );
    this.name = "DocsConfigBlockedPathError";
  }
}

export class DocsConfigOutsideProjectError extends Error {
  constructor(path: string) {
    super(
      `Document config path '${path}' resolves outside the Moss project root '${getProjectRoot()}'. M7 only reads from folders inside ~/.local/share/moss.`,
    );
    this.name = "DocsConfigOutsideProjectError";
  }
}

export interface DocsConfigLoaderDeps {
  readonly readFile: (path: string) => Promise<string>;
}

export const defaultDocsConfigLoaderDeps: DocsConfigLoaderDeps = {
  readFile: (path) => readFile(path, "utf8"),
};

export function docsConfigPath(): string {
  return joinInsideProject(CONFIG_RELATIVE);
}

function assertNotBlocked(absolutePath: string): void {
  for (const marker of BLOCKED_PATH_MARKERS) {
    if (absolutePath.includes(marker)) {
      throw new DocsConfigBlockedPathError(absolutePath, marker);
    }
  }
}

export function resolveApprovedFolder(config: DocsConfig): string {
  const absolute = resolveInsideProject(config.approvedFolder);
  assertNotBlocked(absolute);
  return absolute;
}

export function resolveOutputFolder(config: DocsConfig): string {
  return joinInsideProject(config.outputFolder);
}

export function resolveReviewQueuePath(config: DocsConfig): string {
  return joinInsideProject(config.reviewQueuePath);
}

export function relativeApprovedPath(config: DocsConfig): string {
  const absolute = resolveApprovedFolder(config);
  const root = getProjectRoot();
  const rel = relative(root, absolute);
  return rel.split("\\").join("/");
}

export async function loadDocsConfig(
  deps: DocsConfigLoaderDeps = defaultDocsConfigLoaderDeps,
): Promise<DocsConfig | null> {
  const path = docsConfigPath();
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
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DocsConfigInvalidError(path, "file is not valid JSON");
  }

  const result = DocsConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new DocsConfigInvalidError(path, result.error.message);
  }

  try {
    resolveApprovedFolder(result.data);
    resolveOutputFolder(result.data);
    resolveReviewQueuePath(result.data);
  } catch (error) {
    if (error instanceof DocsConfigOutsideProjectError) {
      throw new DocsConfigInvalidError(path, error.message);
    }
    throw error;
  }

  return result.data;
}

export function parseDocsConfigJson(raw: string, label = "inline"): DocsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DocsConfigInvalidError(label, "content is not valid JSON");
  }
  const result = DocsConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new DocsConfigInvalidError(label, result.error.message);
  }
  resolveApprovedFolder(result.data);
  resolveOutputFolder(result.data);
  resolveReviewQueuePath(result.data);
  return result.data;
}
