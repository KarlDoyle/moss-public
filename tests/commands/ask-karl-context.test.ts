import { describe, expect, it } from "vitest";
import { runAskCommand } from "../../src/commands/ask.ts";

// M12 wiring: `ask --context <profile>` runs BEFORE provider routing, so a
// missing/disabled karl-context config fails cleanly without dispatching.
// (The success path is covered by the karl-context reader unit tests and a
// live demo; there is intentionally no config/karl-context.json in the repo.)
describe("runAskCommand --context (karl-context wiring)", () => {
  it("fails clearly when karl-context is not configured", async () => {
    const err: string[] = [];
    const result = await runAskCommand({
      prompt: "hello",
      karlContextProfile: "career",
      emitJson: false,
      out: () => undefined,
      err: (l) => err.push(l),
    });
    expect(result.ok).toBe(false);
    expect(err.join("\n")).toMatch(/karl-context is (not configured|disabled)/);
  });
});
