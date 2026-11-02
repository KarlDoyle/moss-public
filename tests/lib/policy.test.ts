import { afterEach, describe, expect, it } from "vitest";
import {
  assertCapability,
  CapabilityOutOfScopeError,
  getActiveMilestone,
  isCapabilityAllowed,
  listAllowedCapabilities,
  setActiveMilestone,
} from "../../src/lib/policy.ts";

describe("policy", () => {
  const original = getActiveMilestone();

  afterEach(() => {
    setActiveMilestone(original);
  });

  it("allows ollama-local and github in M1", () => {
    setActiveMilestone("M1");
    expect(isCapabilityAllowed("ollama-local")).toBe(true);
    expect(isCapabilityAllowed("github")).toBe(true);
  });

  it("rejects future capabilities in M1", () => {
    setActiveMilestone("M1");
    expect(isCapabilityAllowed("skills")).toBe(false);
    expect(isCapabilityAllowed("mcp")).toBe(false);
    expect(isCapabilityAllowed("memory")).toBe(false);
  });

  it("assertCapability throws for out-of-scope capability", () => {
    setActiveMilestone("M1");
    expect(() => assertCapability("memory")).toThrowError(CapabilityOutOfScopeError);
  });

  it("assertCapability does not throw for in-scope capability", () => {
    setActiveMilestone("M1");
    expect(() => assertCapability("ollama-local")).not.toThrow();
  });

  it("includes earlier capabilities once a later milestone is active", () => {
    setActiveMilestone("M3");
    expect(isCapabilityAllowed("ollama-local")).toBe(true);
    expect(isCapabilityAllowed("skills")).toBe(true);
    expect(isCapabilityAllowed("multi-provider")).toBe(true);
    expect(isCapabilityAllowed("evals")).toBe(false);
  });

  it("listAllowedCapabilities matches the active milestone", () => {
    setActiveMilestone("M1");
    expect(listAllowedCapabilities().sort()).toEqual(["github", "ollama-local"]);
  });

  it("M2 active scope allows skills and rooms but not multi-provider", () => {
    setActiveMilestone("M2");
    expect(isCapabilityAllowed("skills")).toBe(true);
    expect(isCapabilityAllowed("rooms")).toBe(true);
    expect(isCapabilityAllowed("multi-provider")).toBe(false);
    expect(isCapabilityAllowed("evals")).toBe(false);
  });

  it("M3 active scope allows multi-provider on top of skills and rooms", () => {
    setActiveMilestone("M3");
    expect(isCapabilityAllowed("multi-provider")).toBe(true);
    expect(isCapabilityAllowed("skills")).toBe(true);
    expect(isCapabilityAllowed("rooms")).toBe(true);
    // The next-milestone capability remains out of scope until M4.
    expect(isCapabilityAllowed("evals")).toBe(false);
  });

  it("M6 active scope allows mcp on top of earlier capabilities", () => {
    setActiveMilestone("M6");
    expect(isCapabilityAllowed("mcp")).toBe(true);
    expect(isCapabilityAllowed("litellm")).toBe(true);
    expect(isCapabilityAllowed("documents")).toBe(false);
    expect(isCapabilityAllowed("memory")).toBe(false);
  });

  it("M7 active scope allows documents on top of earlier capabilities", () => {
    setActiveMilestone("M7");
    expect(isCapabilityAllowed("documents")).toBe(true);
    expect(isCapabilityAllowed("mcp")).toBe(true);
    expect(isCapabilityAllowed("memory")).toBe(false);
  });

  it("M8 active scope allows memory on top of earlier capabilities", () => {
    setActiveMilestone("M8");
    expect(isCapabilityAllowed("memory")).toBe(true);
    expect(isCapabilityAllowed("documents")).toBe(true);
  });

  it("default active milestone is the most recently gated milestone (M8)", () => {
    expect(original).toBe("M8");
  });
});
