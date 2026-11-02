import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { MOSS_VERSION } from "../../version.ts";
import { joinInsideProject } from "../paths.ts";
import { classifyByExtension } from "./classify.ts";
import { relativeApprovedPath, resolveApprovedFolder } from "./config.ts";
import { type DocsOutputDeps, defaultDocsOutputDeps, writeDocsOutput } from "./output.ts";
import { syncReviewQueueFromInventory } from "./review-queue.ts";
import {
  type DocsConfig,
  type InventoryItem,
  type InventoryManifest,
  InventoryManifestSchema,
} from "./types.ts";

const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".DS_Store"]);

export interface InventoryDeps extends DocsOutputDeps {
  readonly readdir: typeof readdir;
  readonly stat: typeof stat;
  readonly readFile: (path: string) => Promise<string>;
  readonly readFileBytes: (path: string) => Promise<Buffer>;
  readonly now: () => Date;
}

export const defaultInventoryDeps: InventoryDeps = {
  ...defaultDocsOutputDeps,
  readdir,
  stat,
  readFile: (path) => readFile(path, "utf8"),
  readFileBytes: (path) => readFile(path),
  now: () => new Date(),
};

async function hashFile(path: string, deps: InventoryDeps): Promise<string> {
  const bytes = await deps.readFileBytes(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function walkApprovedFolder(
  root: string,
  current: string,
  deps: InventoryDeps,
  items: InventoryItem[],
): Promise<void> {
  const entries = await deps.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walkApprovedFolder(root, fullPath, deps, items);
      continue;
    }
    if (!entry.isFile()) continue;

    const rel = relative(root, fullPath).split("\\").join("/");
    const fileStat = await deps.stat(fullPath);
    const sha256 = await hashFile(fullPath, deps);
    items.push({
      relativePath: rel,
      sizeBytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      classification: classifyByExtension(rel),
      sha256,
    });
  }
}

export interface RunInventoryResult {
  readonly manifest: InventoryManifest;
  readonly manifestRelativePath: string;
  readonly reviewQueueRelativePath: string;
}

function inventoryManifestRelative(config: DocsConfig): string {
  return join(config.outputFolder, "inventory.json").split("\\").join("/");
}

export async function runInventory(
  config: DocsConfig,
  deps: InventoryDeps = defaultInventoryDeps,
): Promise<RunInventoryResult> {
  const approvedRoot = resolveApprovedFolder(config);
  const items: InventoryItem[] = [];
  await walkApprovedFolder(approvedRoot, approvedRoot, deps, items);
  items.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const manifest: InventoryManifest = {
    schemaVersion: 1,
    generatedAt: deps.now().toISOString(),
    generatedBy: `moss-inventory@${MOSS_VERSION}`,
    approvedFolder: relativeApprovedPath(config),
    items,
  };

  const manifestRelativePath = inventoryManifestRelative(config);
  await writeDocsOutput(manifestRelativePath, `${JSON.stringify(manifest, null, 2)}\n`, deps);
  await syncReviewQueueFromInventory(config, items, deps);

  return {
    manifest,
    manifestRelativePath,
    reviewQueueRelativePath: config.reviewQueuePath,
  };
}

export async function loadInventoryManifest(
  config: DocsConfig,
  deps: Pick<InventoryDeps, "readFile"> = defaultInventoryDeps,
): Promise<InventoryManifest | null> {
  const manifestRelativePath = inventoryManifestRelative(config);
  const absolute = joinInsideProject(manifestRelativePath);
  try {
    const raw = await deps.readFile(absolute);
    const parsed = InventoryManifestSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
