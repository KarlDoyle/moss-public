import { z } from "zod";

const slug = z
  .string()
  .min(1, "id is required")
  .regex(/^[a-z][a-z0-9-]*$/, "id must be kebab-case (lowercase, hyphen-separated)");

export const roomTargetTypeSchema = z.enum(["git-repo"]);
export const roomModeSchema = z.enum(["read-only"]);

export const roomTargetSchema = z
  .object({
    type: roomTargetTypeSchema,
    path: z.string().min(1).default("."),
  })
  .strict();

export const roomFrontmatterSchema = z
  .object({
    id: slug,
    name: z.string().min(1),
    description: z.string().min(1),
    skill: slug,
    target: roomTargetSchema,
    mode: roomModeSchema.default("read-only"),
  })
  .strict();

export type RoomFrontmatter = z.infer<typeof roomFrontmatterSchema>;

export interface Room {
  readonly frontmatter: RoomFrontmatter;
  readonly body: string;
  readonly source: string;
}

export class RoomValidationError extends Error {
  readonly issues: readonly string[];
  constructor(source: string, issues: readonly string[]) {
    super(`Room at '${source}' is invalid:\n  - ${issues.join("\n  - ")}`);
    this.name = "RoomValidationError";
    this.issues = issues;
  }
}
