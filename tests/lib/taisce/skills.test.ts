import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TaisceGuardedPathError } from "../../../src/lib/paths.ts";
import {
  buildTaisceSkillPrompt,
  defaultContextFor,
  findTaisceSkill,
  listLiveTaisceSkills,
  loadTaisceGuardrails,
  PRIVACY_CHECK_LINE,
  readGuardedTaisceFile,
  resolveTaisceSkillId,
  skillOneLiner,
  TAISCE_SKILL_ALIASES,
} from "../../../src/lib/taisce/skills.ts";

// A minimal fake Taisce checkout: just enough structure for guard-reads and
// skill lookup to exercise every branch, without depending on the real
// ~/context-workspace checkout (which may or may not exist, and must never be
// mutated by a test run).
const root = mkdtempSync(join(tmpdir(), "moss-taisce-test-"));

function write(relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

write(
  "Library/skills/capture/SKILL.md",
  "---\ntitle: Capture\n---\n\n# Capture\n\nRoute a fact to the right file.\n",
);
write(
  "Library/skills/standup/SKILL.md",
  "---\ntitle: Standup\n---\n\n# Standup\n\nOpen the day.\n",
);
write(
  "Library/skills/context-router/SKILL.md",
  "---\ntitle: Context router\n---\n\n# Context router\n\nWhich file handles X.\n",
);
write(
  "System/04-privacy-and-sensitivity-rules.md",
  "# Privacy rules\n\nNever route a raw balance outside Domains/Finance distilled files.\n",
);
write("Sources/Inbox/2026-09-17.md", "Fact: paid the gas bill.\n");
write("Sources/Family/secret.md", "family stuff");
write("Domains/Career/highly-private-note.md", '---\nsensitivity: "highly_private"\n---\n\nnope\n');
write(
  "Library/skills/explicit-only-skill/SKILL.md",
  '---\nload_policy: "explicit_only"\n---\n\n# should never load\n',
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findTaisceSkill", () => {
  it("returns null for a missing checkout", () => {
    expect(findTaisceSkill("capture", join(root, "does-not-exist"))).toBeNull();
  });

  it("returns null when the id has no matching skill", () => {
    expect(findTaisceSkill("no-such-skill", root)).toBeNull();
  });

  it("finds a skill under Library/skills and reads its content", () => {
    const skill = findTaisceSkill("capture", root);
    expect(skill).not.toBeNull();
    expect(skill?.id).toBe("capture");
    expect(skill?.content).toContain("Route a fact to the right file");
  });

  it("refuses a skill file whose own frontmatter is explicit_only", () => {
    expect(() => findTaisceSkill("explicit-only-skill", root)).toThrowError(TaisceGuardedPathError);
  });
});

describe("loadTaisceGuardrails", () => {
  it("returns null when the privacy-rules file is absent", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "moss-taisce-empty-"));
    try {
      expect(loadTaisceGuardrails(emptyRoot)).toBeNull();
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("reads the privacy rules content", () => {
    const rules = loadTaisceGuardrails(root);
    expect(rules).toContain("Never route a raw balance");
  });
});

describe("readGuardedTaisceFile", () => {
  it("allows Sources/Inbox/** (capture needs it readable)", () => {
    expect(readGuardedTaisceFile("Sources/Inbox/2026-09-17.md", root)).toContain(
      "paid the gas bill",
    );
  });

  it("denies Sources/Family/** by path, regardless of frontmatter", () => {
    expect(() => readGuardedTaisceFile("Sources/Family/secret.md", root)).toThrowError(
      TaisceGuardedPathError,
    );
  });

  it("denies a file whose frontmatter is sensitivity: highly_private", () => {
    expect(() => readGuardedTaisceFile("Domains/Career/highly-private-note.md", root)).toThrowError(
      TaisceGuardedPathError,
    );
  });

  it("honours TAISCE_ALLOW_SENSITIVE as an explicit escape hatch", () => {
    process.env.TAISCE_ALLOW_SENSITIVE = "1";
    try {
      expect(readGuardedTaisceFile("Sources/Family/secret.md", root)).toContain("family stuff");
    } finally {
      Reflect.deleteProperty(process.env, "TAISCE_ALLOW_SENSITIVE");
    }
  });
});

describe("buildTaisceSkillPrompt", () => {
  it("prepends guardrails, includes the skill body, and the input", () => {
    const skill = findTaisceSkill("capture", root);
    if (skill === null) throw new Error("fixture skill missing");
    const guardrails = loadTaisceGuardrails(root);
    const prompt = buildTaisceSkillPrompt(skill, guardrails, "paid the gas bill, £84, 2026-09-17");

    expect(prompt.indexOf("PRIVACY AND SENSITIVITY RULES")).toBeLessThan(
      prompt.indexOf("SKILL 'capture'"),
    );
    expect(prompt).toContain("Route a fact to the right file");
    expect(prompt).toContain("paid the gas bill, £84, 2026-09-17");
  });

  it("omits the guardrails block when none are available", () => {
    const skill = findTaisceSkill("capture", root);
    if (skill === null) throw new Error("fixture skill missing");
    const prompt = buildTaisceSkillPrompt(skill, null, "");
    expect(prompt).not.toContain("PRIVACY AND SENSITIVITY RULES");
  });
});

describe("short names for the fallback-ladder skills", () => {
  it("defines exactly capture, standup, route and the session's council, week and reconcile", () => {
    expect(Object.keys(TAISCE_SKILL_ALIASES).sort()).toEqual([
      "capture",
      "council",
      "reconcile",
      "route",
      "standup",
      "week",
    ]);
  });

  it("maps route to context-router and leaves the others as themselves", () => {
    expect(resolveTaisceSkillId("route")).toBe("context-router");
    expect(resolveTaisceSkillId("capture")).toBe("capture");
    expect(resolveTaisceSkillId("standup")).toBe("standup");
  });

  it("passes any other id through unchanged", () => {
    expect(resolveTaisceSkillId("week-planner")).toBe("week-planner");
  });

  it("finds all three by short name, with no path", () => {
    expect(findTaisceSkill("capture", root)?.id).toBe("capture");
    expect(findTaisceSkill("standup", root)?.content).toContain("Open the day");
    const route = findTaisceSkill("route", root);
    expect(route?.id).toBe("context-router");
    expect(route?.content).toContain("Which file handles X");
  });
});

describe("standup gets its first input, and the prompt asks for the skill, not a route", () => {
  it("gives standup System/pulse.md by default, via its short name too", () => {
    expect(defaultContextFor("standup")).toBe("System/pulse.md");
  });

  it("gives capture and route no default — their input is what Karl types", () => {
    expect(defaultContextFor("capture")).toBeUndefined();
    expect(defaultContextFor("route")).toBeUndefined();
  });

  it("no longer tells every skill it is a router", () => {
    const skill = findTaisceSkill("standup", root);
    if (skill === null) throw new Error("fixture missing");
    const prompt = buildTaisceSkillPrompt(skill, null, "");
    expect(prompt).not.toContain("read-only router");
    expect(prompt).toContain("Carry out the skill above");
    expect(prompt).toContain("never invent it");
  });
});

describe("the prompt puts the skill last and asks the privacy question", () => {
  it("orders rules, then input, then the skill, then the closing instruction", () => {
    const skill = findTaisceSkill("capture", root);
    if (skill === null) throw new Error("fixture missing");
    const prompt = buildTaisceSkillPrompt(skill, "RULES", "THE FACT");
    const at = (text: string) => prompt.indexOf(text);
    expect(at("RULES")).toBeLessThan(at("THE FACT"));
    expect(at("THE FACT")).toBeLessThan(at("Route a fact to the right file"));
    expect(at("Route a fact to the right file")).toBeLessThan(
      at("Now carry out the skill 'capture'"),
    );
  });

  it("asks for a Privacy: line whenever the rules are in the prompt, or on request", () => {
    const skill = findTaisceSkill("capture", root);
    if (skill === null) throw new Error("fixture missing");
    expect(buildTaisceSkillPrompt(skill, "RULES", "x")).toContain(PRIVACY_CHECK_LINE);
    expect(buildTaisceSkillPrompt(skill, null, "x")).not.toContain(PRIVACY_CHECK_LINE);
    expect(buildTaisceSkillPrompt(skill, null, "x", { privacyCheck: true })).toContain(
      PRIVACY_CHECK_LINE,
    );
  });
});

describe("live skills — Claude Code's own rule, read from .claude/settings.json", () => {
  const live = mkdtempSync(join(tmpdir(), "moss-live-skills-"));
  const put = (rel: string, content: string) => {
    const abs = join(live, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  };
  const skillMd = (description: string) =>
    `---\nname: x\ndescription: >\n  ${description}\n---\n\nbody\n`;
  put(".claude/skills/standup/SKILL.md", skillMd("Standup — the PA brief. Use whenever."));
  put(".claude/skills/context-router/SKILL.md", skillMd("Context-router — answer where X lives."));
  put(".claude/skills/grilling/SKILL.md", skillMd("One question at a time."));
  put(".claude/skills/repo-audit/SKILL.md", skillMd("Audit a repo."));
  put(".claude/skills/finance-loop/SKILL.md", skillMd("Money."));
  put(".claude/skills/secret/SKILL.md", '---\nload_policy: "explicit_only"\n---\n');
  put(".claude/skills/no-skill-file/README.md", "not a skill");
  put(
    ".claude/settings.json",
    JSON.stringify({
      skillOverrides: {
        "repo-audit": "name-only",
        "finance-loop": "off",
        grilling: "user-invocable-only",
      },
    }),
  );
  afterAll(() => rmSync(live, { recursive: true, force: true }));

  it("drops off and name-only, keeps user-invocable-only, and skips gated or empty dirs", () => {
    const ids = listLiveTaisceSkills(live).map((s) => s.id);
    expect(ids).toEqual(["context-router", "grilling", "standup"]);
  });

  it("uses the short alias as the slash name and a one-line description", () => {
    const byId = Object.fromEntries(listLiveTaisceSkills(live).map((s) => [s.id, s]));
    expect(byId["context-router"]?.command).toBe("route");
    expect(byId["context-router"]?.description).toBe("answer where X lives");
    expect(byId.standup?.command).toBe("standup");
    expect(byId.standup?.description).toBe("the PA brief");
    expect(byId.grilling?.description).toBe("One question at a time");
  });

  it("returns nothing for a checkout without .claude/skills", () => {
    expect(listLiveTaisceSkills(join(live, "nope"))).toEqual([]);
  });
});

describe("skillOneLiner", () => {
  it("reads an inline description and truncates long ones", () => {
    expect(skillOneLiner('---\ndescription: "Short one."\n---\n')).toBe("Short one");
    const long = `---\ndescription: ${"word ".repeat(40)}\n---\n`;
    expect(skillOneLiner(long, 20).length).toBeLessThanOrEqual(20);
  });

  it("returns empty without frontmatter or a description", () => {
    expect(skillOneLiner("# no frontmatter")).toBe("");
    expect(skillOneLiner("---\nname: x\n---\n")).toBe("");
  });
});
