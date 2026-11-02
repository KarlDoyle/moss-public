// The Anthropic API key — from the macOS Keychain, never a file.
//
// Two sources, in order:
//   1. ANTHROPIC_API_KEY in the environment, which the mac-setup `moss api` shell function
//      exports from the same Keychain item (Tier 2 of the fallback ladder).
//   2. The Keychain item itself: `security find-generic-password -w -s <service> -a <account>`
//      (exec.ts only admits that argv shape). Service and account default to the ones
//      `moss api` uses, and honour the same ESTATE_MODE_API_KEY_* overrides.
//
// The key is returned to the one caller that sends it (anthropic-api.ts) and is never
// logged, printed, written, or put in an error message.
import { run } from "../exec.ts";

export type ApiKeySource = "env" | "keychain";

export interface ApiKey {
  readonly value: string;
  readonly source: ApiKeySource;
}

export interface KeychainDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly readKeychain: (service: string, account: string) => Promise<string | null>;
}

export const defaultKeychainDeps: KeychainDeps = {
  env: process.env,
  readKeychain: async (service, account) => {
    try {
      const result = await run(
        "security",
        ["find-generic-password", "-w", "-s", service, "-a", account],
        {
          allowFailure: true,
          timeoutMs: 10_000,
        },
      );
      const value = result.stdout.trim();
      return result.exitCode === 0 && value.length > 0 ? value : null;
    } catch {
      return null; // not macOS, or `security` missing: no key
    }
  },
};

export function keychainItem(env: NodeJS.ProcessEnv): { service: string; account: string } {
  return {
    service: env.ESTATE_MODE_API_KEY_SERVICE?.trim() || "anthropic-api-key",
    account: env.ESTATE_MODE_API_KEY_ACCOUNT?.trim() || env.USER || "",
  };
}

export async function resolveApiKey(
  deps: KeychainDeps = defaultKeychainDeps,
): Promise<ApiKey | null> {
  const fromEnv = deps.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return { value: fromEnv, source: "env" };
  const { service, account } = keychainItem(deps.env);
  const fromKeychain = await deps.readKeychain(service, account);
  return fromKeychain === null ? null : { value: fromKeychain, source: "keychain" };
}
