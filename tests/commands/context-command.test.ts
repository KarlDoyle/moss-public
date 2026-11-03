import { describe, expect, it } from "vitest";
import { runContextCommand } from "../../src/commands/context.ts";
import type { KarlContextReaderDeps } from "../../src/lib/karl-context/reader.ts";
import type { KarlContextConfig } from "../../src/lib/karl-context/types.ts";

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, o: (l: string) => out.push(l), e: (l: string) => err.push(l) };
}

const readerDeps: KarlContextReaderDeps = {
  listDir: async (dir) =>
    dir.endsWith("root") || dir === ROOT ? [{ name: "a.md", isDir: false }] : [],
  readFile: async () => ({ content: "hello", truncated: false }),
};
const ROOT = process.cwd();

const enabledConfig: KarlContextConfig = {
  enabled: true,
  path: process.cwd(),
  profiles: { career: ["**"] },
  alwaysExclude: ["Sources/**", ".git/**"],
  maxBytes: 32_768,
};

describe("runContextCommand", () => {
  it("print-config emits the starter config", async () => {
    const h = harness();
    const code = await runContextCommand({
      mode: "print-config",
      emitJson: false,
      out: h.o,
      err: h.e,
    });
    expect(code).toBe(0);
    expect(h.out.join("\n")).toContain('"enabled": false');
  });

  it("reports a clear error when no config exists", async () => {
    const h = harness();
    const code = await runContextCommand({
      mode: "status",
      emitJson: false,
      out: h.o,
      err: h.e,
      loadConfig: async () => null,
    });
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("No karl-context config");
  });

  it("reports disabled config without reading anything", async () => {
    const h = harness();
    const code = await runContextCommand({
      mode: "status",
      emitJson: false,
      out: h.o,
      err: h.e,
      loadConfig: async () => ({ ...enabledConfig, enabled: false }),
    });
    expect(code).toBe(0);
    expect(h.out.join("\n")).toContain("disabled");
    expect(h.out.join("\n")).toContain("career");
  });

  it("summarises each profile when enabled", async () => {
    const h = harness();
    const code = await runContextCommand({
      mode: "status",
      emitJson: true,
      out: h.o,
      err: h.e,
      loadConfig: async () => enabledConfig,
      readerDeps,
    });
    expect(code).toBe(0);
    const body = JSON.parse(h.out.join("\n"));
    expect(body.enabled).toBe(true);
    expect(body.profiles[0].profile).toBe("career");
    expect(body.profiles[0].files).toBe(1);
  });
});
