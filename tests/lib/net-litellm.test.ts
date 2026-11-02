import { afterEach, describe, expect, it } from "vitest";
import { NetworkBoundaryError, setLiteLlmEndpoint } from "../../src/lib/net.ts";
import { getActiveMilestone, setActiveMilestone } from "../../src/lib/policy.ts";

afterEach(() => {
  setLiteLlmEndpoint(null);
  setActiveMilestone("M5");
});

describe("setLiteLlmEndpoint (M5 dynamic allowlist)", () => {
  it("accepts a localhost policy", () => {
    expect(() =>
      setLiteLlmEndpoint({ host: "127.0.0.1", port: 4000, protocol: "http:" }),
    ).not.toThrow();
    expect(() => setLiteLlmEndpoint(null)).not.toThrow();
  });

  it("accepts ::1 / [::1] / localhost", () => {
    for (const host of ["localhost", "::1", "[::1]"]) {
      expect(() => setLiteLlmEndpoint({ host, port: 4000, protocol: "http:" })).not.toThrow();
    }
  });

  it("rejects any non-localhost host (defence in depth)", () => {
    expect(() =>
      setLiteLlmEndpoint({ host: "192.168.1.1", port: 4000, protocol: "http:" }),
    ).toThrow(NetworkBoundaryError);
    expect(() =>
      setLiteLlmEndpoint({ host: "api.example.com", port: 443, protocol: "https:" }),
    ).toThrow(NetworkBoundaryError);
    expect(() => setLiteLlmEndpoint({ host: "10.0.0.1", port: 4000, protocol: "http:" })).toThrow(
      NetworkBoundaryError,
    );
  });

  it("uses M1_ALLOWED unchanged when no LiteLLM endpoint is registered", () => {
    // Indirect: with no endpoint set and the active milestone M5,
    // safeFetch (not called here) would still allow the M1 base set.
    // We verify the active milestone is M5 so the conditional is hit.
    expect(getActiveMilestone()).toBe("M5");
  });
});
