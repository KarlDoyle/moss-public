import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildCli } from "../../src/cli.ts";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

async function readText(path: string): Promise<string> {
  return readFile(`${REPO_ROOT}/${path}`, "utf8");
}

async function readOperatorGuide(): Promise<string> {
  return readFile(`${REPO_ROOT}/docs/OPERATOR_GUIDE.md`, "utf8");
}

describe("docs-surface consistency", () => {
  it("every registered command is named in README.md", async () => {
    const program = buildCli();
    const commandNames = program.commands.map((c) => c.name());
    const readme = await readText("README.md");
    for (const name of commandNames) {
      expect(readme).toContain(`\`${name}\``);
    }
  });

  it("every registered command is documented in docs/OPERATOR_GUIDE.md", async () => {
    const program = buildCli();
    const commandNames = program.commands.map((c) => c.name());
    const allMilestones = await readOperatorGuide();
    for (const name of commandNames) {
      expect(allMilestones).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
