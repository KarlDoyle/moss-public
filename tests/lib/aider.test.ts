import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAiderArgs,
  buildEditPlanPrompt,
  canonicalAiderFiles,
  parseEditPlan,
  pickFiles,
  runAiderConfined,
  tidyAiderOutput,
} from "../../src/lib/aider.ts";

describe("buildAiderArgs", () => {
  const base = { message: "do it", model: "qwen2.5-coder:7b", files: ["a.ts"] };

  it("dry run passes --dry-run and never --no-dry-run", () => {
    const args = buildAiderArgs({ ...base, dryRun: true });
    expect(args).toContain("--dry-run");
    expect(args).not.toContain("--no-dry-run");
  });

  it("apply passes --no-dry-run explicitly (Taisce's .aider.conf.yml defaults to dry-run)", () => {
    const args = buildAiderArgs({ ...base, dryRun: false });
    expect(args).toContain("--no-dry-run");
    expect(args).not.toContain("--dry-run");
  });

  it("switches off everything a --yes-always run would otherwise act on", () => {
    const args = buildAiderArgs({ ...base, dryRun: false });
    for (const flag of [
      "--yes-always",
      "--no-auto-commits",
      "--no-dirty-commits",
      "--no-auto-lint",
      "--no-suggest-shell-commands",
      "--no-detect-urls",
      "--no-gitignore",
    ]) {
      expect(args, flag).toContain(flag);
    }
    expect(args.join(" ")).toContain("--map-tokens 0");
    expect(args.join(" ")).toContain("--chat-history-file /dev/null");
  });

  it("targets the Ollama model and ends with message then files", () => {
    const args = buildAiderArgs({ ...base, files: ["a.ts", "b.ts"], dryRun: true });
    expect(args.slice(0, 2)).toEqual(["--model", "ollama_chat/qwen2.5-coder:7b"]);
    expect(args.slice(-4)).toEqual(["--message", "do it", "a.ts", "b.ts"]);
  });

  it("rejects option-like filenames before constructing child argv", () => {
    expect(() =>
      buildAiderArgs({ ...base, files: ["--config=fixture.yml"], dryRun: true }),
    ).toThrow(/looks like an option/);
  });
});

describe("Aider path confinement", () => {
  let root: string | undefined;
  let outside: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (outside) rmSync(outside, { recursive: true, force: true });
  });

  it("passes a canonical in-repository regular file to a controlled adapter", async () => {
    root = mkdtempSync(join(tmpdir(), "moss-aider-root-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "file.ts"), "fixture\n");
    const runner = vi.fn(async (_args: readonly string[], _cwd: string) => ({
      exitCode: 0,
      output: "controlled",
    }));
    await expect(
      runAiderConfined(
        root,
        {
          message: "synthetic edit",
          model: "fixture-model",
          files: ["src/file.ts"],
          dryRun: true,
        },
        runner,
      ),
    ).resolves.toEqual({ exitCode: 0, output: "controlled" });
    expect(runner.mock.calls[0]?.[0].slice(-1)).toEqual(["src/file.ts"]);
    expect(runner.mock.calls[0]?.[1]).toBe(realpathSync(root));
  });

  it("resolves an in-root symlink to its canonical file path", () => {
    root = mkdtempSync(join(tmpdir(), "moss-aider-root-"));
    writeFileSync(join(root, "real.ts"), "fixture\n");
    symlinkSync(join(root, "real.ts"), join(root, "alias.ts"));
    expect(canonicalAiderFiles(root, ["alias.ts"])).toEqual(["real.ts"]);
  });

  it("refuses traversal and symlink escapes", () => {
    const repo = mkdtempSync(join(tmpdir(), "moss-aider-root-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "moss-aider-outside-"));
    root = repo;
    outside = outsideRoot;
    writeFileSync(join(outsideRoot, "secret.ts"), "fixture\n");
    symlinkSync(join(outsideRoot, "secret.ts"), join(repo, "link.ts"));
    expect(() => canonicalAiderFiles(repo, ["../outside.ts"])).toThrow(/canonical relative path/);
    expect(() => canonicalAiderFiles(repo, ["link.ts"])).toThrow(/outside the target repository/);
  });
});

describe("pickFiles", () => {
  const tracked = ["src/lib/paths.ts", "paths.ts", "README.md", "src/cli.ts"];

  it("only returns files that are really tracked", () => {
    expect(pickFiles("FILES: src/cli.ts, src/invented.ts", tracked)).toEqual(["src/cli.ts"]);
  });

  it("prefers the longest match and does not double-count its basename", () => {
    expect(pickFiles("change `src/lib/paths.ts`", tracked)).toEqual(["src/lib/paths.ts"]);
  });

  it("caps the number of files", () => {
    expect(pickFiles("README.md src/cli.ts paths.ts", tracked, 2)).toHaveLength(2);
  });
});

describe("edit plan", () => {
  it("parses FILES and PLAN", () => {
    expect(parseEditPlan("FILES: a.ts, b.ts\nPLAN: rename x to y\nin both")).toEqual({
      files: "a.ts, b.ts",
      plan: "rename x to y\nin both",
    });
  });

  it("falls back to the whole reply as the plan", () => {
    expect(parseEditPlan("just do the thing").plan).toBe("just do the thing");
  });

  it("the planning prompt lists the files and the request", () => {
    const prompt = buildEditPlanPrompt("fix it", ["a.ts"]);
    expect(prompt).toContain("a.ts");
    expect(prompt).toContain("REQUEST: fix it");
    expect(prompt).toContain("Never name a file that is not in the list");
  });
});

describe("tidyAiderOutput", () => {
  it("drops the banner and token lines but keeps the diff and the dry-run proof", () => {
    const raw = [
      "Warning: Input is not a terminal (fd=0).",
      "Aider v0.86.2",
      "Model: ollama_chat/qwen2.5-coder:7b with whole edit format",
      "Git repo: .git with 1 files",
      "Added calc.py to the chat.",
      "+def sub(a, b):",
      "Tokens: 766 sent, 31 received.",
      "Did not apply edit to calc.py (--dry-run)",
    ].join("\n");
    expect(tidyAiderOutput(raw)).toBe("+def sub(a, b):\nDid not apply edit to calc.py (--dry-run)");
  });
});

describe("buildAiderArgs — architect/editor (unified router)", () => {
  it("adds --architect and the editor model only when one is given", async () => {
    const { buildAiderArgs } = await import("../../src/lib/aider.ts");
    const split = buildAiderArgs({
      message: "m",
      model: "llama3.1:latest",
      editorModel: "qwen2.5-coder:7b",
      files: ["a"],
      dryRun: true,
    });
    expect(split.slice(0, 5)).toEqual([
      "--model",
      "ollama_chat/llama3.1:latest",
      "--architect",
      "--editor-model",
      "ollama_chat/qwen2.5-coder:7b",
    ]);
    expect(buildAiderArgs({ message: "m", model: "x", files: [], dryRun: true })).not.toContain(
      "--architect",
    );
  });
});
