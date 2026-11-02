import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { MOSS_VERSION } from "../../version.ts";
import { isConvertible } from "./classify.ts";
import { resolveApprovedFolder } from "./config.ts";
import { loadInventoryManifest } from "./inventory.ts";
import { type DocsOutputDeps, defaultDocsOutputDeps, writeDocsOutput } from "./output.ts";
import { buildProvenanceFrontMatter } from "./provenance.ts";
import { markDerivativeInReviewQueue } from "./review-queue.ts";
import type { DocsConfig, InventoryItem } from "./types.ts";

export class DocumentConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentConvertError";
  }
}

export interface ConvertOneResult {
  readonly sourceRelativePath: string;
  readonly derivativeRelativePath: string;
  readonly classification: InventoryItem["classification"];
}

export interface ConvertBatchResult {
  readonly converted: ConvertOneResult[];
  readonly skipped: Array<{ sourceRelativePath: string; reason: string }>;
}

export interface ConvertDeps extends DocsOutputDeps {
  readonly readFile: (path: string) => Promise<string>;
  readonly now: () => Date;
}

export const defaultConvertDeps: ConvertDeps = {
  ...defaultDocsOutputDeps,
  readFile: (path) => readFile(path, "utf8"),
  now: () => new Date(),
};

function derivativeRelativePath(config: DocsConfig, sourceRelativePath: string): string {
  const extension = extname(sourceRelativePath).toLowerCase();
  const derivativeName =
    extension === ".md" || extension === ".markdown"
      ? sourceRelativePath.slice(0, -extension.length).concat(".converted.md")
      : `${sourceRelativePath}.md`;
  return join(config.outputFolder, derivativeName).split("\\").join("/");
}

function bodyForClassification(
  classification: InventoryItem["classification"],
  raw: string,
): string {
  switch (classification) {
    case "markdown":
      return raw.endsWith("\n") ? raw : `${raw}\n`;
    case "text":
      return `# Source text\n\n\`\`\`text\n${raw.replace(/\r\n/g, "\n")}\n\`\`\`\n`;
    case "json":
      return `# Source JSON\n\n\`\`\`json\n${raw.replace(/\r\n/g, "\n")}\n\`\`\`\n`;
    case "yaml":
      return `# Source YAML\n\n\`\`\`yaml\n${raw.replace(/\r\n/g, "\n")}\n\`\`\`\n`;
    case "html":
      return `# Source HTML\n\n\`\`\`html\n${raw.replace(/\r\n/g, "\n")}\n\`\`\`\n`;
    default:
      throw new DocumentConvertError(
        `Classification '${classification}' is not convertible in M7. OCR, embeddings, and RAG are out of scope.`,
      );
  }
}

export async function convertInventoryItem(
  config: DocsConfig,
  item: InventoryItem,
  deps: ConvertDeps = defaultConvertDeps,
): Promise<ConvertOneResult> {
  if (!isConvertible(item.classification)) {
    if (item.classification === "pdf" || item.classification === "image") {
      throw new DocumentConvertError(
        `Cannot convert '${item.relativePath}' (${item.classification}): OCR is not supported in M7. Add a text or markdown source, or convert the file manually before ingesting.`,
      );
    }
    throw new DocumentConvertError(
      `Cannot convert '${item.relativePath}' (classification: ${item.classification}). M7 only converts markdown, text, json, yaml, and html using rule-based detection.`,
    );
  }

  const approvedRoot = resolveApprovedFolder(config);
  const sourceAbsolute = join(approvedRoot, item.relativePath);
  const raw = await deps.readFile(sourceAbsolute);
  const convertedAt = deps.now().toISOString();
  const frontMatter = buildProvenanceFrontMatter({
    sourceRelativePath: item.relativePath,
    sourceExtension: extname(item.relativePath).toLowerCase(),
    sourceSha256: item.sha256,
    classification: item.classification,
    convertedAt,
    generatedBy: `moss-convert@${MOSS_VERSION}`,
  });
  const body = bodyForClassification(item.classification, raw);
  const derivativeRelative = derivativeRelativePath(config, item.relativePath);
  await writeDocsOutput(derivativeRelative, `${frontMatter}${body}`, deps);
  await markDerivativeInReviewQueue(config, item.relativePath, derivativeRelative, deps);

  return {
    sourceRelativePath: item.relativePath,
    derivativeRelativePath: derivativeRelative,
    classification: item.classification,
  };
}

export async function convertAllFromManifest(
  config: DocsConfig,
  deps: ConvertDeps = defaultConvertDeps,
): Promise<ConvertBatchResult> {
  const manifest = await loadInventoryManifest(config, deps);
  if (manifest === null) {
    throw new DocumentConvertError(
      "No inventory manifest found. Run `moss inventory` first against the approved folder.",
    );
  }

  const converted: ConvertOneResult[] = [];
  const skipped: Array<{ sourceRelativePath: string; reason: string }> = [];

  for (const item of manifest.items) {
    if (!isConvertible(item.classification)) {
      skipped.push({
        sourceRelativePath: item.relativePath,
        reason:
          item.classification === "pdf" || item.classification === "image"
            ? "OCR not supported in M7"
            : `classification ${item.classification} is not convertible`,
      });
      continue;
    }
    converted.push(await convertInventoryItem(config, item, deps));
  }

  return { converted, skipped };
}

export async function convertSinglePath(
  config: DocsConfig,
  sourceRelativePath: string,
  deps: ConvertDeps = defaultConvertDeps,
): Promise<ConvertOneResult> {
  const manifest = await loadInventoryManifest(config, deps);
  const item = manifest?.items.find((entry) => entry.relativePath === sourceRelativePath);
  if (!item) {
    throw new DocumentConvertError(
      `'${sourceRelativePath}' was not found in the latest inventory manifest. Run \`moss inventory\` first.`,
    );
  }
  return convertInventoryItem(config, item, deps);
}
