import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactMemoryByTag } from "../../../src/lib/memory/compact.ts";
import { memoryAuditPath, memoryEntryPath } from "../../../src/lib/memory/paths.ts";
import { recallMemory } from "../../../src/lib/memory/recall.ts";
import {
  createMemoryEntry,
  forgetMemoryEntry,
  listMemoryEntries,
  MemoryStoreError,
  updateMemoryEntry,
} from "../../../src/lib/memory/store.ts";
import { MemoryEntrySchema } from "../../../src/lib/memory/types.ts";
import { getProjectRoot, setProjectRoot } from "../../../src/lib/paths.ts";

describe("memory paths", () => {
  it("rejects traversal-like ids", () => {
    expect(() => memoryEntryPath("../escape")).toThrow(/safe memory path/i);
    expect(() => memoryEntryPath("bad/name")).toThrow(/safe memory path/i);
  });
});

describe("memory pipeline", () => {
  const realRoot = getProjectRoot();
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "moss-memory-"));
    setProjectRoot(sandbox);
  });

  afterEach(() => {
    setProjectRoot(realRoot);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("remember creates a valid memory entry under output/memory", async () => {
    const entry = await createMemoryEntry({
      content: "Moss release checklist",
      type: "note",
      tags: ["release"],
      confidence: "verified",
    });
    const parsed = MemoryEntrySchema.parse(entry);
    expect(parsed.status).toBe("active");
    expect(parsed.privacyLevel).toBe("local");
    expect(readFileSync(memoryEntryPath(parsed.id), "utf8")).toContain("Moss release checklist");
  });

  it("recall finds explicit entries by query and tag", async () => {
    await createMemoryEntry({ content: "alpha note", tags: ["work"] });
    await createMemoryEntry({ content: "beta note", tags: ["personal"] });
    const byQuery = await recallMemory({ query: "alpha" });
    expect(byQuery.count).toBe(1);
    expect(byQuery.entries[0]?.content).toBe("alpha note");

    const byTag = await recallMemory({ tag: "personal" });
    expect(byTag.count).toBe(1);
    expect(byTag.entries[0]?.tags).toContain("personal");
  });

  it("recall returns stable JSON shape", async () => {
    await createMemoryEntry({ content: "stable", tags: ["json"] });
    const result = await recallMemory({ query: "stable" });
    expect(result).toEqual({
      ok: true,
      query: "stable",
      count: 1,
      entries: [expect.objectContaining({ content: "stable", status: "active" })],
    });
  });

  it("compact creates a summary artifact with provenance", async () => {
    await createMemoryEntry({ content: "one", tags: ["milestone"] });
    await createMemoryEntry({ content: "two", tags: ["milestone"] });
    const result = await compactMemoryByTag({ tag: "milestone", outputName: "milestone-summary" });
    expect(result.outputRelativePath).toBe("output/memory/summaries/milestone-summary.md");
    const summary = readFileSync(join(sandbox, result.outputRelativePath), "utf8");
    expect(summary).toContain("generatedBy:");
    expect(summary).toContain("sourceEntryIds:");
    expect(summary).toContain("one");
    expect(summary).toContain("two");
  });

  it("forget tombstones an entry and recall excludes it", async () => {
    const entry = await createMemoryEntry({ content: "temporary", tags: ["tmp"] });
    await forgetMemoryEntry(entry.id);
    const recalled = await recallMemory({ query: "temporary" });
    expect(recalled.count).toBe(0);
    const stored = await listMemoryEntries();
    expect(stored.find((row) => row.id === entry.id)?.status).toBe("forgotten");
  });

  it("update edits an existing entry", async () => {
    const entry = await createMemoryEntry({ content: "old", tags: ["edit"] });
    const updated = await updateMemoryEntry({ id: entry.id, content: "new" });
    expect(updated.content).toBe("new");
    expect(updated.createdAt).toBe(entry.createdAt);
  });

  it("audit log records remember, recall, compact, and forget", async () => {
    const entry = await createMemoryEntry({ content: "audited", tags: ["audit"] });
    await recallMemory({ tag: "audit" });
    await compactMemoryByTag({ tag: "audit", outputName: "audit-summary" });
    await forgetMemoryEntry(entry.id);

    const auditRaw = await readFile(memoryAuditPath(), "utf8");
    const lines = auditRaw.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const actions = lines.map((line) => (JSON.parse(line) as { action: string }).action);
    expect(actions).toContain("remember");
    expect(actions).toContain("recall");
    expect(actions).toContain("compact");
    expect(actions).toContain("forget");
  });

  it("rejects invalid memory schema on read", async () => {
    const badPath = memoryEntryPath("mem-bad-entry");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(sandbox, "output/memory/entries"), { recursive: true });
    writeFileSync(badPath, JSON.stringify({ schemaVersion: 1, id: "mem-bad-entry" }), "utf8");
    await expect(listMemoryEntries()).rejects.toBeInstanceOf(MemoryStoreError);
  });

  it("stores entries only under output/memory", async () => {
    await createMemoryEntry({ content: "scoped", tags: ["scope"] });
    const entriesDir = join(sandbox, "output/memory/entries");
    const files = readdirSync(entriesDir);
    expect(files.every((name) => name.endsWith(".json"))).toBe(true);
    expect(files.some((name) => name.includes(".."))).toBe(false);
  });

  it("does not auto-ingest M7 document outputs", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(sandbox, "output/docs"), { recursive: true });
    writeFileSync(
      join(sandbox, "output/docs/inventory.json"),
      JSON.stringify({ schemaVersion: 1, items: [{ relativePath: "sample.txt" }] }),
      "utf8",
    );
    const entries = await listMemoryEntries();
    expect(entries).toEqual([]);
  });
});
