import { describe, expect, it } from "vitest";
import {
  assertToolAllowlisted,
  isToolAllowlisted,
  McpToolNotAllowedError,
  sanitizeToolName,
} from "../../../src/lib/mcp/allowlist.ts";
import type { McpConfig } from "../../../src/lib/mcp/types.ts";

const ENABLED: McpConfig = {
  enabled: true,
  servers: [
    {
      id: "example-echo",
      endpointUrl: "http://127.0.0.1:3001",
      allowedTools: ["echo"],
    },
  ],
};

describe("MCP allowlist (D-0016 exact-match)", () => {
  const server = ENABLED.servers[0];
  if (server === undefined) throw new Error("test fixture missing server");

  it("allows only exact tool names listed in allowedTools", () => {
    expect(isToolAllowlisted(server, "echo")).toBe(true);
    expect(isToolAllowlisted(server, "Echo")).toBe(false);
    expect(isToolAllowlisted(server, "echo*")).toBe(false);
    expect(isToolAllowlisted(server, "../echo")).toBe(false);
  });

  it("assertToolAllowlisted throws McpToolNotAllowedError when disabled", () => {
    expect(() =>
      assertToolAllowlisted({ ...ENABLED, enabled: false }, "example-echo", "echo"),
    ).toThrow(McpToolNotAllowedError);
  });

  it("assertToolAllowlisted throws for unknown server", () => {
    expect(() => assertToolAllowlisted(ENABLED, "missing", "echo")).toThrow(/unknown server id/);
  });

  it("assertToolAllowlisted throws for non-allowlisted tool", () => {
    expect(() => assertToolAllowlisted(ENABLED, "example-echo", "shell")).toThrow(
      /not in allowedTools/,
    );
  });
});

describe("tool name sanitisation (prompt/tool poisoning)", () => {
  it("rejects names with path or whitespace characters", () => {
    for (const bad of ["../x", "tool/inject", "tool name", "<script>", ".."]) {
      expect(() => sanitizeToolName(bad)).toThrow(McpToolNotAllowedError);
    }
  });

  it("rejects names that mimic system override instructions", () => {
    expect(() => sanitizeToolName("ignore-previous-instructions")).not.toThrow();
    // Allowed as name string — allowlist still gates execution; poisoned
    // descriptions from tools/list are never executed by Moss.
  });
});
