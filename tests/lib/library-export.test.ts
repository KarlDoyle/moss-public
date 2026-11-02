import { describe, expect, it } from "vitest";
import * as moss from "../../src/index.ts";

/**
 * The public library surface (M-lib): other tools import moss's router directly
 * instead of shelling out. This asserts the barrel exposes a stable, usable
 * surface. It is offline + deterministic — no provider probing, no generation.
 */
describe("library export surface", () => {
  it("exposes the core routing functions", () => {
    expect(typeof moss.routeAndGenerate).toBe("function");
    expect(typeof moss.explainProviderRoute).toBe("function");
    expect(typeof moss.loadRegistry).toBe("function");
  });

  it("exposes the provider/task vocabulary", () => {
    expect(Array.isArray(moss.PROVIDER_IDS)).toBe(true);
    expect(moss.PROVIDER_IDS.length).toBeGreaterThan(0);
    expect(moss.TASK_IDS).toContain("ask");
    expect(moss.ProviderIdSchema.parse(moss.PROVIDER_IDS[0])).toBe(moss.PROVIDER_IDS[0]);
  });

  it("exposes default router dependencies and the no-provider error", () => {
    expect(moss.defaultRouterDependencies).toBeDefined();
    expect(typeof moss.NoProviderAvailableError).toBe("function");
  });
});
