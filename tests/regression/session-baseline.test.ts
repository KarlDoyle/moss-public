// M1 baseline (unified router, 2026-09-18): the moss session as it stood before the lane
// router, driven end to end through the REAL wiring — buildTaisceSessionDeps against a fake
// Taisce checkout with real (tiny) hook scripts run through bash — with only the model and
// Aider stubbed. If any of these break, the router changed something it promised not to.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runBench } from "../../src/commands/bench.ts";
import { buildTaisceSessionDeps } from "../../src/commands/chat.ts";
import type { DoctorDependencies } from "../../src/commands/doctor.ts";
import { registerEstate } from "../../src/commands/estate.ts";
import type { BenchRecord } from "../../src/lib/bench.ts";
import { lastBench } from "../../src/lib/bench.ts";
import { PRIVACY_CHECK_LINE } from "../../src/lib/taisce/skills.ts";
import { readTelemetry } from "../../src/lib/taisce/telemetry.ts";
import {
  type ChatGenerateParams,
  type ChatGenerateResult,
  runChatSession,
} from "../../src/repl/session.ts";

const root = mkdtempSync(join(tmpdir(), "moss-baseline-"));
function put(rel: string, content: string, exec = false): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  if (exec) chmodSync(abs, 0o755);
}
const skill = (d: string) => `---\nname: x\ndescription: >\n  ${d}\n---\n\n# body of ${d}\n`;
for (const id of ["standup", "capture"]) {
  put(`.claude/skills/${id}/SKILL.md`, skill(`${id} skill.`));
  put(`Library/skills/${id}/SKILL.md`, skill(`${id} skill.`));
}
put(".claude/settings.json", "{}");
put("System/04-privacy-and-sensitivity-rules.md", "# Rules\n\nRaw balances stay local.\n");
put("System/pulse.md", "PULSE ROW overdue\n");
put(
  "scripts/hooks/session-start.sh",
  `#!/usr/bin/env bash\necho '{"hookSpecificOutput":{"additionalContext":"BRIEF: 2 due"}}'\n`,
  true,
);
put(
  "scripts/hooks/front-door.sh",
  "#!/usr/bin/env bash\ncat >/dev/null\necho 'Domains: finance'\necho 'Tier: Sonnet 5'\n",
  true,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function* linesOf(lines: readonly string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function session(lines: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: ChatGenerateParams[] = [];
  const aider = vi.fn(async (_repo: string, o: { dryRun: boolean }) => ({
    exitCode: 0,
    output: o.dryRun ? "+x = 1\nDid not apply edit (--dry-run)" : "Applied edit to a.py",
  }));
  const wired = buildTaisceSessionDeps(root);
  const edit = wired.edit;
  if (edit === undefined) throw new Error("edit not wired");
  const generate = async (p: ChatGenerateParams): Promise<ChatGenerateResult> => {
    prompts.push(p);
    return { ok: true, response: "FILES: a.py\nPLAN: set x to 1 in a.py", model: "stub" };
  };
  const run = runChatSession({
    ...wired,
    lines: linesOf(lines),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    generate,
    edit: {
      ...edit,
      resolveRepo: async () => "/tmp/repo",
      trackedFiles: async () => ["a.py", "b.py"],
      checkFiles: () => undefined,
      aider,
      diffStat: async () => " a.py | 1 +",
      // The pre-router /edit: the local lane, one model. Also keeps the real lane probes
      // (a live `claude -p`) out of the test.
      route: async () => ({ lane: "ollama", model: null, stageOnly: false, summary: "local lane" }),
    },
  });
  return { run, out, err, prompts, aider };
}

describe("baseline: the session opens", () => {
  it("prints the banner and the session-start brief from the real hook", async () => {
    const s = session(["/exit"]);
    await s.run;
    expect(s.out[0]).toContain("moss — Taisce session");
    expect(s.out.join("\n")).toContain("BRIEF: 2 due");
    expect(s.out.at(-1)).toBe("bye.");
  });
});

describe("baseline: /standup and /capture", () => {
  it("/standup sends the skill with the Pulse, privacy rules as system, and the check line", async () => {
    const s = session(["/standup", "/exit"]);
    await s.run;
    const sent = s.prompts[0];
    expect(sent?.prompt).toContain("PULSE ROW overdue");
    expect(sent?.prompt).toContain("SKILL 'standup'");
    expect(sent?.prompt).toContain(PRIVACY_CHECK_LINE);
    expect(sent?.system).toContain("Raw balances stay local.");
    expect(sent?.system).toContain("BRIEF: 2 due");
    const text = s.out.join("\n");
    expect(text).toContain("privacy rules applied");
    expect(text).toContain("a prompt to check, never a record");
  });

  it("/capture carries what was typed and the front-door lines", async () => {
    const s = session(["/capture paid the gas bill", "/exit"]);
    await s.run;
    expect(s.prompts[0]?.prompt).toContain("paid the gas bill");
    expect(s.prompts[0]?.system).toContain("Domains: finance");
    expect(s.out.join("\n")).toContain("front door: finance");
  });
});

describe("baseline: deprecated local editing", () => {
  it("refuses local edits without invoking Aider or prompting for approval", async () => {
    const s = session(["/edit set x in a.py", "/exit"]);
    await s.run;
    expect(s.aider).not.toHaveBeenCalled();
    expect(s.err.join("\n")).toContain("deprecated and disabled");
    expect(s.out.join("\n")).not.toContain("go? [y/N]");
  });
});

describe("baseline: moss status", () => {
  it("prints the fallback-ladder rows", async () => {
    const doctor: DoctorDependencies = {
      execRun: async (command, args) => ({
        command,
        args,
        exitCode: 0,
        stdout: "10.0.0",
        stderr: "",
      }),
      gitVersion: async () => "git version 2.50",
      netFetch: async () => ({
        status: 200,
        ok: true,
        body: '{"models":[{"name":"llama3.1:latest"}]}',
      }),
      cwd: () => "/m",
      nodeVersion: () => "22.0.0",
      projectRoot: () => "/m",
      hasApiKey: () => false,
      taisceRoot: () => root,
      taisceDivergence: async () => ({ left: 0, right: 0 }),
    };
    const program = new Command().exitOverride();
    registerEstate(program, doctor);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(["node", "moss", "status"]);
      const text = write.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("moss status");
      expect(text).toContain("ollama:          running");
      expect(text).toContain("models pulled:   llama3.1:latest");
    } finally {
      write.mockRestore();
    }
  });
});

describe("baseline: moss bench", () => {
  it("benches pulled models, skips the rest, and appends one line each", async () => {
    const file = join(root, "bench.jsonl");
    const out: string[] = [];
    const err: string[] = [];
    const ok = (model: string, role: string): BenchRecord => ({
      ts: "2026-09-18T10:00:00.000Z",
      role,
      model,
      ok: true,
      tok_s: 20,
      load_ms: 900,
      by: "moss bench",
    });
    const { appendTelemetry } = await import("../../src/lib/taisce/telemetry.ts");
    const records = await runBench(
      [
        { role: "brief", model: "llama3.1:latest" },
        { role: "edit", model: "not-pulled:7b" },
        { role: "chat", model: "qwen3:4b" },
      ],
      (l) => out.push(l),
      (l) => err.push(l),
      {
        pulled: async () => ["llama3.1:latest", "qwen3:4b"],
        bench: async (t) => ok(t.model, t.role),
        append: (r) => appendTelemetry(file, r),
        now: () => new Date("2026-09-18T10:00:00Z"),
      },
    );
    expect(records.map((r) => r.model)).toEqual(["llama3.1:latest"]);
    expect(err.join("\n")).toContain("not-pulled:7b (edit) is not pulled");
    expect(err.join("\n")).toContain("reasoning models are never benched");
    expect(out.join("\n")).toContain("PASS");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    expect(lastBench(readTelemetry(file))).toEqual({
      ts: "2026-09-18T10:00:00.000Z",
      models: 1,
      passed: 1,
    });
  });

  it("says so when Ollama has nothing", async () => {
    const err: string[] = [];
    const records = await runBench(
      [],
      () => undefined,
      (l) => err.push(l),
      {
        pulled: async () => [],
        bench: vi.fn(),
        append: vi.fn(),
        now: () => new Date(),
      },
    );
    expect(records).toEqual([]);
    expect(err[0]).toContain("moss local");
  });
});
