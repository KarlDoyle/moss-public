import { z } from "zod";

// Config + packet types for the M12 bounded karl-context mode.
//
// Pinned by docs/milestones/M12.md and D-0024 (external-root confinement).
// The selection model is allowlist-only / default-deny (D-1): Moss reads ONLY
// files a profile's globs name; `alwaysExclude` is hard-denied on top. No I/O
// here — pure types + Zod schemas, mirroring src/lib/docs/types.ts.

// A named profile is an allowlist of path globs, relative to the karl-context
// root, that MAY be read for that profile. Nothing outside the active
// profile's globs is ever read (default-deny).
export const KarlContextConfigSchema = z
  .object({
    // Master switch. Default-off; the lane does nothing until enabled.
    enabled: z.boolean(),
    // Absolute path (leading `~` is expanded) to the karl-context workspace
    // root. Validated by resolveKarlContextRoot (confine.ts): must exist, be a
    // directory, and pass the realpath/symlink + blocked-marker defences.
    path: z.string().min(1),
    // profile name -> allowlist of globs (relative to root). Default-deny: a
    // file is readable only if the ACTIVE profile lists a glob matching it.
    profiles: z.record(z.string(), z.array(z.string()).readonly()),
    // Paths always denied regardless of profile (defence in depth). The
    // sensitive, local-only material in karl-context lives under Sources/.
    alwaysExclude: z.array(z.string()).readonly().default(["Sources/**", ".git/**"]),
    // Hard cap on total bytes assembled into one context packet. Keeps token
    // load controlled (a roadmap DoD).
    maxBytes: z.number().int().positive().max(32_768).default(32_768),
  })
  .strict();

export type KarlContextConfig = z.infer<typeof KarlContextConfigSchema>;

// Provenance for a single included file. Echoed to the operator so they can
// see exactly what was fed to the model.
export interface ContextFileProvenance {
  readonly path: string; // relative to the karl-context root
  readonly sha256: string;
  readonly bytes: number;
}

// The bounded context packet assembled for one dispatch. `renderedContext` is
// the text prepended to the prompt; the rest is the human/audit-facing record.
export interface ContextPacket {
  readonly profile: string;
  readonly root: string; // absolute root, for the record
  readonly files: readonly ContextFileProvenance[];
  readonly totalBytes: number;
  readonly truncated: boolean; // maxBytes capped the selection
  readonly renderedContext: string;
}
