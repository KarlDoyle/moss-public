import { describe, expect, it } from "vitest";
import {
  KarlContextConfigInvalidError,
  parseKarlContextConfigJson,
} from "../../../src/lib/karl-context/config.ts";

const REAL_DIR = process.cwd();

describe("src/lib/karl-context/config.ts", () => {
  it("parses a valid disabled config and applies defaults", () => {
    const cfg = parseKarlContextConfigJson(
      JSON.stringify({
        enabled: false,
        path: "~/Dev/KARL_CONTEXT",
        profiles: { career: ["x/**"] },
      }),
    );
    expect(cfg.enabled).toBe(false);
    expect([...cfg.alwaysExclude]).toEqual(["Sources/**", ".git/**"]);
    expect(cfg.maxBytes).toBe(32_768);
  });

  it("allows a disabled config to name a not-yet-existent path", () => {
    expect(() =>
      parseKarlContextConfigJson(
        JSON.stringify({ enabled: false, path: "/nope/not/here", profiles: {} }),
      ),
    ).not.toThrow();
  });

  it("validates the external root when enabled (rejects a bad path)", () => {
    expect(() =>
      parseKarlContextConfigJson(
        JSON.stringify({ enabled: true, path: "/definitely/not/here/xyz", profiles: {} }),
      ),
    ).toThrow(KarlContextConfigInvalidError);
  });

  it("accepts an enabled config pointing at a real directory", () => {
    expect(() =>
      parseKarlContextConfigJson(
        JSON.stringify({ enabled: true, path: REAL_DIR, profiles: { p: ["**"] } }),
      ),
    ).not.toThrow();
  });

  it("rejects unknown keys (strict schema) and non-JSON", () => {
    expect(() =>
      parseKarlContextConfigJson(
        JSON.stringify({ enabled: false, path: "x", profiles: {}, bogus: 1 }),
      ),
    ).toThrow(KarlContextConfigInvalidError);
    expect(() => parseKarlContextConfigJson("not json")).toThrow(/not valid JSON/);
  });

  it("rejects profile budgets above the bounded maximum", () => {
    expect(() =>
      parseKarlContextConfigJson(
        JSON.stringify({
          enabled: false,
          path: "~/fixture",
          profiles: { all: ["**"] },
          maxBytes: 32_769,
        }),
      ),
    ).toThrow(KarlContextConfigInvalidError);
  });
});
