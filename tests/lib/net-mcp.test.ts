import { afterEach, describe, expect, it } from "vitest";
import { NetworkBoundaryError, setMcpEndpoints } from "../../src/lib/net.ts";

afterEach(() => {
  setMcpEndpoints([]);
});

describe("setMcpEndpoints (M6)", () => {
  it("accepts localhost MCP server policies", () => {
    expect(() =>
      setMcpEndpoints([
        { host: "127.0.0.1", port: 3001, protocol: "http:" },
        { host: "localhost", port: 3002, protocol: "http:" },
      ]),
    ).not.toThrow();
  });

  it("rejects non-localhost hosts", () => {
    expect(() => setMcpEndpoints([{ host: "10.0.0.5", port: 3001, protocol: "http:" }])).toThrow(
      NetworkBoundaryError,
    );
  });
});
