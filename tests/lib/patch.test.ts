import { describe, expect, it } from "vitest";
import { textPatchPaths } from "../../src/lib/patch.ts";

const patch = (name = "file.txt") => `--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`;

describe("narrow text-patch grammar", () => {
  it("accepts ordinary, spaced, quoted and multiple-file modifications", () => {
    expect(textPatchPaths(patch())).toEqual(["file.txt"]);
    expect(textPatchPaths(patch("two words.txt"))).toEqual(["two words.txt"]);
    expect(
      textPatchPaths(
        patch().replace("a/file.txt", '"a/file.txt"').replace("b/file.txt", '"b/file.txt"'),
      ),
    ).toEqual(["file.txt"]);
    expect(
      textPatchPaths(
        `diff --git a/file.txt b/file.txt\nindex 1234567..abcdef0 100644\n${patch()}${patch("other.txt")}`,
      ),
    ).toEqual(["file.txt", "other.txt"]);
    expect(
      textPatchPaths(
        "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
      ),
    ).toEqual(["f"]);
  });

  it.each([
    "",
    "prose\n",
    "diff --git a/other b/other\nold mode 100644\nnew mode 100755\n",
    "diff --git a/other b/new\nsimilarity index 100%\nrename from other\nrename to new\n",
    "diff --git a/other b/new\ncopy from other\ncopy to new\n",
    "diff --git a/f b/f\nGIT binary patch\nliteral 1\nA\n",
    "Binary files a/f and b/f differ\n",
    "--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+x\n",
    "--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
    patch().replace("+++ b/file.txt", "+++ b/other"),
    `diff --git a/other b/other\n${patch()}`,
    patch().replace("@@ -1 +1 @@", "@@ -1,2 +1 @@"),
    patch().replace("@@ -1 +1 @@", "@@ invalid @@"),
    patch().replace("+++ b/file.txt", "+++ b/file.txt\tdate"),
    patch().slice(0, -1),
    `${patch()}unexpected\n`,
    `${patch()}${patch()}`,
    ...[
      "../escape",
      "dir/../f",
      "/absolute",
      "./f",
      "dir//f",
      ".git/config",
      "x/.GIT/config",
      "x\\f",
      "C:foo",
    ].map(patch),
    patch().replace("a/file.txt", '"a/file\\040name.txt"'),
  ])("refuses unsupported or ambiguous input %j", (input) => {
    expect(() => textPatchPaths(input)).toThrow("Unsupported patch");
  });
});
