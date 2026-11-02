// Return a prefix that ends at a Unicode code-point boundary and fits the byte cap.
export function truncateUtf8(text: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  let used = 0;
  let result = "";
  for (const codePoint of text) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (used + bytes > maxBytes) break;
    result += codePoint;
    used += bytes;
  }
  return result;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
