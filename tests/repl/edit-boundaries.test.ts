import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch } from "../../src/commands/chat-lanes.ts";
import { getProjectRoot, resolveInsideProject, setProjectRoot } from "../../src/lib/paths.ts";
import { type EditContext, runEdit, type SessionEditDeps } from "../../src/repl/edit.ts";

const patch = (name = "planned.txt", old = "old", next = "new") =>
  `--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${old}\n+${next}\n`;
const projectRoot = getProjectRoot();

describe("real Git edit approval boundary", () => {
  let root: string;
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  const snapshot = () => ({
    planned: readFileSync(join(repo, "planned.txt")),
    unrelated: readFileSync(join(repo, "unrelated.txt")),
    index: readFileSync(join(repo, ".git/index")),
    files: readdirSync(repo).sort(),
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "moss-edit-boundary-"));
    repo = join(root, "repo");
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-b", "main", repo], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    writeFileSync(join(repo, "planned.txt"), "old\n");
    writeFileSync(join(repo, "unrelated.txt"), "committed\n");
    git("add", ".");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    writeFileSync(join(repo, "unrelated.txt"), "staged\n");
    git("add", "unrelated.txt");
    writeFileSync(join(repo, "unrelated.txt"), "unstaged\n");
    setProjectRoot(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(projectRoot);
    rmSync(root, { recursive: true, force: true });
  });

  async function edit(answer: string | undefined, diff = patch(), stageOnly = false) {
    const messages: string[] = [];
    const nextLine = vi.fn(async () => answer);
    const apply = vi.fn(applyPatch);
    const deps: SessionEditDeps = {
      resolveRepo: async () => repo,
      trackedFiles: async () => ["planned.txt"],
      checkFiles: () => undefined,
      coderModel: () => "fixture",
      aider: async () => {
        throw new Error("Aider forbidden");
      },
      diffStat: async () => "planned.txt",
      buildPlanPrompt: () => "synthetic plan",
      parsePlan: () => ({ files: "planned.txt", plan: "change text" }),
      pickFiles: () => ["planned.txt"],
      route: async () => ({
        lane: "claude-code",
        model: "fixture",
        stageOnly,
        summary: "mock provider",
      }),
      claudeDiff: async () => ({ ok: true, diff }),
      applyPatch: apply,
    };
    const ctx: EditContext = {
      edit: deps,
      out: (s) => messages.push(s),
      err: (s) => messages.push(s),
      generate: async () => ({ ok: true, response: "synthetic" }),
      system: "",
      model: undefined,
      nextLine,
    };
    await runEdit(ctx, "change planned.txt");
    return { messages, apply, nextLine };
  }

  it.each(["n", undefined, "stage-only"])(
    "%s leaves target bytes/index and Moss artifacts unchanged",
    async (answer) => {
      const before = snapshot();
      const files = readdirSync(root).sort();
      const result = await edit(answer, patch(), answer === "stage-only");
      expect(snapshot()).toEqual(before);
      expect(readdirSync(root).sort()).toEqual(files);
      expect(result.apply.mock.calls.map((c) => c[2])).toEqual([true]);
      if (answer === "stage-only") expect(result.nextLine).not.toHaveBeenCalled();
    },
  );

  it("approved text changes only planned bytes and preserves a dirty unrelated file and index", async () => {
    const before = snapshot();
    const result = await edit("yes");
    expect(readFileSync(join(repo, "planned.txt"), "utf8")).toBe("new\n");
    expect(snapshot()).toEqual({ ...before, planned: Buffer.from("new\n") });
    expect(result.apply.mock.calls.map((c) => c[2])).toEqual([true, false]);
    expect(existsSync(join(root, "output"))).toBe(false);
  });

  it.each([
    patch("unrelated.txt", "unstaged"),
    "diff --git a/unrelated.txt b/unrelated.txt\nold mode 100644\nnew mode 100755\n",
    "diff --git a/unrelated.txt b/moved.txt\nsimilarity index 100%\nrename from unrelated.txt\nrename to moved.txt\n",
    "diff --git a/unrelated.txt b/unrelated.txt\nGIT binary patch\nliteral 1\nA\n",
    patch("../outside"),
    `${patch()}${patch("unrelated.txt", "unstaged")}`,
  ])("rejects out-of-plan or unsupported patch before asking approval: %j", async (diff) => {
    const before = snapshot();
    const result = await edit("yes", diff);
    expect(result.apply).not.toHaveBeenCalled();
    expect(result.nextLine).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it("Git applicability failure leaves all bytes/index unchanged", async () => {
    const before = snapshot();
    const result = await edit("yes", patch("planned.txt", "wrong"));
    expect(result.nextLine).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(result.messages.join("\n")).toContain("does not apply cleanly");
  });

  it("validates all files before a multiple-file application", async () => {
    writeFileSync(join(repo, "second.txt"), "second\n");
    const before = snapshot();
    expect(
      (
        await applyPatch(repo, `${patch()}${patch("second.txt", "wrong")}`, true, [
          "planned.txt",
          "second.txt",
        ])
      ).ok,
    ).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(repo, "second.txt"), "utf8")).toBe("second\n");
    const diff = `${patch()}${patch("second.txt", "second", "changed")}`;
    expect((await applyPatch(repo, diff, true, ["planned.txt", "second.txt"])).ok).toBe(true);
    expect((await applyPatch(repo, diff, false, ["planned.txt", "second.txt"])).ok).toBe(true);
    expect(readFileSync(join(repo, "second.txt"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(repo, ".git/index"))).toEqual(before.index);
  });

  it.each([false, true])(
    "Git applies the exact approved spaced path (quoted=%s)",
    async (quoted) => {
      const name = "two words.txt";
      writeFileSync(join(repo, name), "old\n");
      const index = readFileSync(join(repo, ".git/index"));
      const diff = quoted
        ? patch(name).replace(`a/${name}`, `"a/${name}"`).replace(`b/${name}`, `"b/${name}"`)
        : patch(name);
      expect((await applyPatch(repo, diff, true, [name])).ok).toBe(true);
      expect(readFileSync(join(repo, name), "utf8")).toBe("old\n");
      expect((await applyPatch(repo, diff, false, [name])).ok).toBe(true);
      expect(readFileSync(join(repo, name), "utf8")).toBe("new\n");
      expect(readFileSync(join(repo, ".git/index"))).toEqual(index);
    },
  );

  it("does not touch predictable output symlinks or filename collisions, including on check errors", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    mkdirSync(join(root, "output/edits"), { recursive: true });
    const outside = join(root, "outside-missing.diff");
    const legacy = join(root, "output/edits/edit-123.diff");
    symlinkSync(outside, legacy);
    await edit(undefined);
    expect(existsSync(outside)).toBe(false);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(() => resolveInsideProject("output/edits/edit-123.diff")).toThrow();
    rmSync(legacy);
    writeFileSync(legacy, "collision sentinel");
    await edit("yes", patch("planned.txt", "wrong"));
    expect(readFileSync(legacy, "utf8")).toBe("collision sentinel");
    expect(readdirSync(join(root, "output/edits"))).toEqual(["edit-123.diff"]);
  });

  it.each([false, true])(
    "refuses final-component symlinks (dangling=%s) without outside writes",
    async (dangling) => {
      const outside = join(root, "outside.txt");
      if (!dangling) writeFileSync(outside, "old\n");
      rmSync(join(repo, "planned.txt"));
      symlinkSync(outside, join(repo, "planned.txt"));
      const index = readFileSync(join(repo, ".git/index"));
      await expect(applyPatch(repo, patch(), true, ["planned.txt"])).rejects.toThrow(
        "symlink path",
      );
      expect(existsSync(outside)).toBe(!dangling);
      if (!dangling) expect(readFileSync(outside, "utf8")).toBe("old\n");
      expect(readFileSync(join(repo, ".git/index"))).toEqual(index);
    },
  );
});
