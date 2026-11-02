import type { DocumentClassification } from "./types.ts";

const EXTENSION_MAP: Readonly<Record<string, DocumentClassification>> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".text": "text",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".html": "html",
  ".htm": "html",
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
};

export function classifyByExtension(relativePath: string): DocumentClassification {
  const lower = relativePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) {
    return "unknown";
  }
  const ext = lower.slice(dot);
  return EXTENSION_MAP[ext] ?? "unknown";
}

export function isConvertible(classification: DocumentClassification): boolean {
  return (
    classification === "markdown" ||
    classification === "text" ||
    classification === "json" ||
    classification === "yaml" ||
    classification === "html"
  );
}
