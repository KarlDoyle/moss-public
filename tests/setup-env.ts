// Runs before every test file.
//
// When the suite runs from a git hook (`pre-push` in particular) git exports GIT_DIR,
// GIT_INDEX_FILE and friends, pointing at the repository being pushed. Tests that build
// a throwaway repository in a temp directory would then read and write the moss checkout
// instead. Strip them, so a hook-run suite behaves exactly like a terminal-run one.
//
// The library fix lives in src/lib/git.ts (GIT_INHERITED_ENV, removed from every safeGit
// call); this only cleans the *test harness*, which shells out to git directly.
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
]) {
  delete process.env[key];
}
