import { z } from "zod";

const slug = z
  .string()
  .min(1, "id is required")
  .regex(/^[a-z][a-z0-9-]*$/, "id must be kebab-case (lowercase, hyphen-separated)");

export const inputKindSchema = z.enum(["git-diff", "git-status", "files", "prompt"]);
export const outputKindSchema = z.enum(["markdown", "json", "text"]);
export const providerPreferenceSchema = z.enum(["local", "remote", "any"]);
export const providerFallbackSchema = z.enum(["none", "remote-if-allowed"]);

export const skillInputSchema = z
  .object({
    name: z.string().min(1),
    kind: inputKindSchema,
    source: z.enum(["room", "argument"]).default("room"),
    required: z.boolean().default(true),
  })
  .strict();

export const skillOutputSchema = z
  .object({
    name: z.string().min(1),
    kind: outputKindSchema,
  })
  .strict();

export const skillSafetySchema = z
  .object({
    reads: z.array(z.string()).default([]),
    writes: z.array(z.string()).default([]),
    network: z.array(z.string()).default([]),
  })
  .strict();

export const skillProviderSchema = z
  .object({
    preference: providerPreferenceSchema.default("local"),
    fallback: providerFallbackSchema.default("none"),
  })
  .strict();

export const skillFrontmatterSchema = z
  .object({
    id: slug,
    name: z.string().min(1),
    description: z.string().min(1),
    version: z.number().int().positive().default(1),
    inputs: z.array(skillInputSchema).default([]),
    outputs: z.array(skillOutputSchema).default([]),
    provider: skillProviderSchema.default({ preference: "local", fallback: "none" }),
    safety: skillSafetySchema.default({ reads: [], writes: [], network: [] }),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface Skill {
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
  readonly source: string;
}

export class SkillValidationError extends Error {
  readonly issues: readonly string[];
  constructor(source: string, issues: readonly string[]) {
    super(`Skill at '${source}' is invalid:\n  - ${issues.join("\n  - ")}`);
    this.name = "SkillValidationError";
    this.issues = issues;
  }
}
