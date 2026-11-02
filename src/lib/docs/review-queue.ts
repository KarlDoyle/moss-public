import { readFile } from "node:fs/promises";
import { MOSS_VERSION } from "../../version.ts";
import { resolveReviewQueuePath } from "./config.ts";
import { type DocsOutputDeps, defaultDocsOutputDeps, writeDocsOutput } from "./output.ts";
import {
  type DocsConfig,
  type InventoryItem,
  type ReviewQueue,
  type ReviewQueueItem,
  ReviewQueueSchema,
} from "./types.ts";

export interface ReviewQueueDeps extends DocsOutputDeps {
  readonly readFile: (path: string) => Promise<string>;
  readonly now: () => Date;
}

export const defaultReviewQueueDeps: ReviewQueueDeps = {
  ...defaultDocsOutputDeps,
  readFile: (path) => readFile(path, "utf8"),
  now: () => new Date(),
};

function queueItemId(relativePath: string): string {
  return relativePath.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

async function readExistingQueue(
  config: DocsConfig,
  deps: ReviewQueueDeps,
): Promise<ReviewQueue | null> {
  const path = resolveReviewQueuePath(config);
  try {
    const raw = await deps.readFile(path);
    const parsed = ReviewQueueSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
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
}

export async function loadReviewQueue(
  config: DocsConfig,
  deps: ReviewQueueDeps = defaultReviewQueueDeps,
): Promise<ReviewQueue> {
  const existing = await readExistingQueue(config, deps);
  if (existing) return existing;
  return {
    schemaVersion: 1,
    generatedAt: deps.now().toISOString(),
    generatedBy: `moss-review-queue@${MOSS_VERSION}`,
    items: [],
  };
}

function upsertItem(items: ReviewQueueItem[], next: ReviewQueueItem): ReviewQueueItem[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

export async function syncReviewQueueFromInventory(
  config: DocsConfig,
  inventoryItems: readonly InventoryItem[],
  deps: ReviewQueueDeps = defaultReviewQueueDeps,
): Promise<ReviewQueue> {
  const existing = await loadReviewQueue(config, deps);
  const now = deps.now().toISOString();
  let items = existing.items.slice();

  for (const item of inventoryItems) {
    const id = queueItemId(item.relativePath);
    const prior = items.find((entry) => entry.id === id);
    const next: ReviewQueueItem = {
      id,
      sourceRelativePath: item.relativePath,
      classification: item.classification,
      status: prior?.status ?? "pending_review",
      updatedAt: now,
      ...(prior?.derivativeRelativePath
        ? { derivativeRelativePath: prior.derivativeRelativePath }
        : {}),
      ...(prior?.note ? { note: prior.note } : {}),
    };
    items = upsertItem(items, next);
  }

  const queue: ReviewQueue = {
    schemaVersion: 1,
    generatedAt: now,
    generatedBy: `moss-review-queue@${MOSS_VERSION}`,
    items,
  };

  await persistReviewQueue(config, queue, deps);
  return queue;
}

export async function markDerivativeInReviewQueue(
  config: DocsConfig,
  sourceRelativePath: string,
  derivativeRelativePath: string,
  deps: ReviewQueueDeps = defaultReviewQueueDeps,
): Promise<ReviewQueue> {
  const queue = await loadReviewQueue(config, deps);
  const now = deps.now().toISOString();
  const id = queueItemId(sourceRelativePath);
  const prior = queue.items.find((item) => item.id === id);
  const next: ReviewQueueItem = {
    id,
    sourceRelativePath,
    classification: prior?.classification ?? "unknown",
    derivativeRelativePath,
    status: prior?.status ?? "pending_review",
    updatedAt: now,
    ...(prior?.note ? { note: prior.note } : {}),
  };
  const items = upsertItem(queue.items, next);
  const updated: ReviewQueue = {
    schemaVersion: 1,
    generatedAt: now,
    generatedBy: `moss-review-queue@${MOSS_VERSION}`,
    items,
  };
  await persistReviewQueue(config, updated, deps);
  return updated;
}

export async function persistReviewQueue(
  config: DocsConfig,
  queue: ReviewQueue,
  deps: ReviewQueueDeps = defaultReviewQueueDeps,
): Promise<string> {
  const contents = `${JSON.stringify(queue, null, 2)}\n`;
  return writeDocsOutput(config.reviewQueuePath, contents, deps);
}
