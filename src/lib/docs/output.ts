import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { joinInsideProject } from "../paths.ts";

export interface DocsOutputDeps {
  readonly mkdir: (path: string) => Promise<void>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
}

export const defaultDocsOutputDeps: DocsOutputDeps = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: (path, contents) => writeFile(path, contents, "utf8"),
};

export async function writeDocsOutput(
  relativePath: string,
  contents: string,
  deps: DocsOutputDeps = defaultDocsOutputDeps,
): Promise<string> {
  const absolute = joinInsideProject(relativePath);
  await deps.mkdir(dirname(absolute));
  await deps.writeFile(absolute, contents);
  return absolute;
}
