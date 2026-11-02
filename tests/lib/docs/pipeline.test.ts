import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyByExtension, isConvertible } from "../../../src/lib/docs/classify.ts";
import { parseDocsConfigJson, resolveApprovedFolder } from "../../../src/lib/docs/config.ts";
import {
  convertAllFromManifest,
  convertSinglePath,
  DocumentConvertError,
} from "../../../src/lib/docs/convert.ts";
import { runInventory } from "../../../src/lib/docs/inventory.ts";
import { loadReviewQueue } from "../../../src/lib/docs/review-queue.ts";
import { getProjectRoot, setProjectRoot } from "../../../src/lib/paths.ts";

describe("docs classify", () => {
  it("maps known extensions and falls back to unknown", () => {
    expect(classifyByExtension("readme.md")).toBe("markdown");
    expect(classifyByExtension("data.json")).toBe("json");
    expect(classifyByExtension("file.xyz")).toBe("unknown");
  });

  it("marks only text-like formats as convertible", () => {
    expect(isConvertible("markdown")).toBe(true);
    expect(isConvertible("pdf")).toBe(false);
    expect(isConvertible("unknown")).toBe(false);
  });
});

describe("docs config", () => {
  const realRoot = getProjectRoot();

  afterEach(() => {
    setProjectRoot(realRoot);
  });

  it("rejects approved folders outside the project", () => {
    setProjectRoot(realRoot);
    expect(() =>
      parseDocsConfigJson(
        JSON.stringify({
          enabled: true,
          approvedFolder: "/tmp/outside",
          outputFolder: "output/docs",
          reviewQueuePath: "output/review/queue.json",
        }),
      ),
    ).toThrow(/outside the project root/);
  });

  it("rejects iCloud-like paths", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "moss-docs-config-"));
    setProjectRoot(sandbox);
    mkdirSync(join(sandbox, "Mobile Documents", "docs"), { recursive: true });
    expect(() =>
      parseDocsConfigJson(
        JSON.stringify({
          enabled: true,
          approvedFolder: "Mobile Documents/docs",
          outputFolder: "output/docs",
          reviewQueuePath: "output/review/queue.json",
        }),
      ),
    ).toThrow(/blocked/i);
    rmSync(sandbox, { recursive: true, force: true });
  });
});

describe("docs inventory + convert (fixture corpus)", () => {
  const realRoot = getProjectRoot();
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "moss-docs-flow-"));
    setProjectRoot(sandbox);

    const fixtureRoot = join(sandbox, "tests/fixtures/docs");
    mkdirSync(join(fixtureRoot, "nested"), { recursive: true });
    writeFileSync(join(fixtureRoot, "sample.txt"), "hello\n", "utf8");
    writeFileSync(join(fixtureRoot, "readme.md"), "# Hi\n", "utf8");
    writeFileSync(join(fixtureRoot, "unknown.xyz"), "???\n", "utf8");
    writeFileSync(join(fixtureRoot, "nested/note.txt"), "nested\n", "utf8");

    mkdirSync(join(sandbox, "config"), { recursive: true });
    writeFileSync(
      join(sandbox, "config/docs.json"),
      JSON.stringify({
        enabled: true,
        approvedFolder: "tests/fixtures/docs",
        outputFolder: "output/docs",
        reviewQueuePath: "output/review/queue.json",
      }),
      "utf8",
    );
  });

  afterEach(() => {
    setProjectRoot(realRoot);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("inventories only the approved folder and writes manifest + review queue", async () => {
    const config = parseDocsConfigJson(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(join(sandbox, "config/docs.json"), "utf8"),
      ),
    );
    const result = await runInventory(config);
    expect(result.manifest.items.length).toBe(4);
    expect(result.manifest.items.map((item) => item.classification)).toContain("unknown");
    expect(result.manifest.generatedBy).toMatch(/^moss-inventory@/);

    const queue = await loadReviewQueue(config);
    expect(queue.items.length).toBe(4);
    expect(queue.items.every((item) => item.status === "pending_review")).toBe(true);
  });

  it("converts text-like fixtures with provenance and skips unknown/OCR types", async () => {
    const config = parseDocsConfigJson(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(join(sandbox, "config/docs.json"), "utf8"),
      ),
    );
    await runInventory(config);
    const batch = await convertAllFromManifest(config);
    expect(batch.converted.length).toBe(3);
    expect(batch.skipped.some((row) => row.sourceRelativePath === "unknown.xyz")).toBe(true);

    const derivative = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(sandbox, "output/docs/sample.txt.md"), "utf8"),
    );
    expect(derivative).toContain("sourceSha256:");
    expect(derivative).toContain('sourceExtension: ".txt"');
    expect(derivative).toContain("generatedBy:");
    expect(derivative).toContain("moveStatus: pending_review");

    const markdownDerivative = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(sandbox, "output/docs/readme.converted.md"), "utf8"),
    );
    expect(markdownDerivative).toContain('sourcePath: "readme.md"');
    expect(markdownDerivative).toContain('sourceExtension: ".md"');

    await expect(convertSinglePath(config, "unknown.xyz")).rejects.toBeInstanceOf(
      DocumentConvertError,
    );
  });

  it("never resolves approved folder outside sandbox", () => {
    const config = parseDocsConfigJson(
      JSON.stringify({
        enabled: true,
        approvedFolder: "tests/fixtures/docs",
        outputFolder: "output/docs",
        reviewQueuePath: "output/review/queue.json",
      }),
    );
    const approved = resolveApprovedFolder(config);
    expect(approved.startsWith(sandbox)).toBe(true);
  });
});
