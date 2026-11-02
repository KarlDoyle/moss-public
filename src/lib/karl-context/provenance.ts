import type { ContextPacket } from "./types.ts";

// Human-facing provenance for a context packet (M12). Shown before dispatch
// and by `moss context status` so the operator can see EXACTLY which
// karl-context files were included, their sizes, and their content hashes.
// Metadata only — never the file contents.

export function formatPacketProvenance(packet: ContextPacket): string {
  const lines: string[] = [];
  lines.push(
    `karl-context — profile '${packet.profile}': ${packet.files.length} file(s), ${packet.totalBytes} bytes${
      packet.truncated ? " (truncated at maxBytes)" : ""
    }.`,
  );
  lines.push(`root: ${packet.root}`);
  if (packet.files.length === 0) {
    lines.push("  (no files matched — nothing was included)");
    return lines.join("\n");
  }
  for (const file of packet.files) {
    lines.push(`  - ${file.path}  ${file.bytes}B  sha256:${file.sha256.slice(0, 12)}`);
  }
  return lines.join("\n");
}
