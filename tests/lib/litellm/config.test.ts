import { describe, expect, it } from "vitest";
import {
  enabledLocalhostEndpoint,
  LiteLlmConfigInvalidError,
  LiteLlmConfigSchema,
  loadLiteLlmConfig,
} from "../../../src/lib/litellm/config.ts";

describe("LiteLlmConfigSchema", () => {
  it("accepts a valid localhost http config", () => {
    const result = LiteLlmConfigSchema.safeParse({
      enabled: true,
      endpointUrl: "http://127.0.0.1:4000",
      models: [{ name: "gpt-4o-mini", viaLiteLLM: true }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts the `localhost` alias and ::1", () => {
    for (const url of ["http://localhost:4000", "http://[::1]:4000", "https://127.0.0.1:8443"]) {
      const result = LiteLlmConfigSchema.safeParse({
        enabled: true,
        endpointUrl: url,
        models: [],
      });
      expect(result.success, `expected ${url} to parse`).toBe(true);
    }
  });

  it("rejects any non-localhost URL (D-0015)", () => {
    for (const url of [
      "http://api.openai.com",
      "https://example.com:4000",
      "http://192.168.1.1:4000",
      "http://10.0.0.1:4000",
    ]) {
      const result = LiteLlmConfigSchema.safeParse({
        enabled: true,
        endpointUrl: url,
        models: [],
      });
      expect(result.success, `expected ${url} to be rejected`).toBe(false);
    }
  });

  it("rejects non-http(s) protocols", () => {
    const result = LiteLlmConfigSchema.safeParse({
      enabled: true,
      endpointUrl: "ftp://127.0.0.1:21",
      models: [],
    });
    expect(result.success).toBe(false);
  });

  it("requires `viaLiteLLM: true` on every model entry (no accidental enabling)", () => {
    const result = LiteLlmConfigSchema.safeParse({
      enabled: true,
      endpointUrl: "http://127.0.0.1:4000",
      models: [{ name: "gpt-4o-mini", viaLiteLLM: false }],
    });
    expect(result.success).toBe(false);
  });

  it("treats `enabled: false` configs as valid (M5 default-off)", () => {
    const result = LiteLlmConfigSchema.safeParse({
      enabled: false,
      endpointUrl: "http://127.0.0.1:4000",
      models: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level keys (strict schema)", () => {
    const result = LiteLlmConfigSchema.safeParse({
      enabled: false,
      endpointUrl: "http://127.0.0.1:4000",
      models: [],
      enableExternal: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("loadLiteLlmConfig", () => {
  it("returns null when the file is absent (ENOENT)", async () => {
    const result = await loadLiteLlmConfig({
      readFile: async () => {
        const err = new Error("ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      },
    });
    expect(result).toBeNull();
  });

  it("parses valid JSON via the schema", async () => {
    const result = await loadLiteLlmConfig({
      readFile: async () =>
        JSON.stringify({
          enabled: true,
          endpointUrl: "http://127.0.0.1:4000",
          models: [],
        }),
    });
    expect(result?.enabled).toBe(true);
    expect(result?.endpointUrl).toBe("http://127.0.0.1:4000");
  });

  it("throws LiteLlmConfigInvalidError on bad JSON", async () => {
    await expect(
      loadLiteLlmConfig({
        readFile: async () => "{not valid json",
      }),
    ).rejects.toBeInstanceOf(LiteLlmConfigInvalidError);
  });

  it("throws LiteLlmConfigInvalidError on schema mismatch", async () => {
    await expect(
      loadLiteLlmConfig({
        readFile: async () => '{"enabled":true,"endpointUrl":"http://evil.example.com"}',
      }),
    ).rejects.toBeInstanceOf(LiteLlmConfigInvalidError);
  });
});

describe("enabledLocalhostEndpoint", () => {
  it("returns null when config is null or disabled", () => {
    expect(enabledLocalhostEndpoint(null)).toBeNull();
    expect(
      enabledLocalhostEndpoint({
        enabled: false,
        endpointUrl: "http://127.0.0.1:4000",
        models: [],
      }),
    ).toBeNull();
  });

  it("extracts host, port, and protocol for an enabled config", () => {
    const policy = enabledLocalhostEndpoint({
      enabled: true,
      endpointUrl: "http://127.0.0.1:4000",
      models: [],
    });
    expect(policy).toEqual({ host: "127.0.0.1", port: 4000, protocol: "http:" });
  });

  it("uses 80/443 as the default port for http/https", () => {
    expect(
      enabledLocalhostEndpoint({
        enabled: true,
        endpointUrl: "http://localhost",
        models: [],
      }),
    ).toEqual({ host: "localhost", port: 80, protocol: "http:" });
    expect(
      enabledLocalhostEndpoint({
        enabled: true,
        endpointUrl: "https://127.0.0.1",
        models: [],
      }),
    ).toEqual({ host: "127.0.0.1", port: 443, protocol: "https:" });
  });
});
