import { MOSS_VERSION } from "../../version.ts";
import type { DocumentClassification } from "./types.ts";

export interface ProvenanceInput {
  readonly sourceRelativePath: string;
  readonly sourceExtension: string;
  readonly sourceSha256: string;
  readonly classification: DocumentClassification;
  readonly convertedAt: string;
  readonly generatedBy?: string;
}

export function buildProvenanceFrontMatter(input: ProvenanceInput): string {
  const generatedBy = input.generatedBy ?? `moss-convert@${MOSS_VERSION}`;
  const lines = [
    "---",
    `sourcePath: ${JSON.stringify(input.sourceRelativePath)}`,
    `sourceExtension: ${JSON.stringify(input.sourceExtension)}`,
    `sourceSha256: ${input.sourceSha256}`,
    `convertedAt: ${JSON.stringify(input.convertedAt)}`,
    `generatedBy: ${JSON.stringify(generatedBy)}`,
    `classification: ${input.classification}`,
    "moveStatus: pending_review",
    "---",
    "",
  ];
  return lines.join("\n");
}
