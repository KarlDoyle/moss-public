import { describe, expect, it } from "vitest";
import { runLiteLlmCommand } from "../../src/commands/litellm.ts";

describe("runLiteLlmCommand", () => {
  it("prints a starter config with --print-config", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runLiteLlmCommand({
      mode: "print-config",
      emitJson: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(exit).toBe(0);
    expect(err).toEqual([]);
    const printed = out.join("\n");
    expect(printed).toContain('"enabled": false');
    expect(printed).toContain('"endpointUrl": "http://127.0.0.1:4000"');
    expect(printed).toContain('"viaLiteLLM": true');
    expect(printed).toContain("D-0015");
  });

  it("--check exits non-zero when no config is present", async () => {
    // The default loader will return null on a fresh repo (no
    // config/litellm.json). The probe should report not_configured
    // and the command should exit with a non-zero status.
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runLiteLlmCommand({
      mode: "check",
      emitJson: true,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(exit).toBe(1);
    const parsed = JSON.parse(out[0] ?? "{}");
    expect(parsed.id).toBe("litellm");
    expect(parsed.status).toBe("not_configured");
  });

  it("--check prints a human-readable status when --json is not set", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runLiteLlmCommand({
      mode: "check",
      emitJson: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(exit).toBe(1);
    expect(out.some((line) => line.startsWith("LiteLLM lane status:"))).toBe(true);
    expect(out.some((line) => line.startsWith("Reason:"))).toBe(true);
  });
});
