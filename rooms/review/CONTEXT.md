---
id: review
name: Code review room
description: A read-only room for reviewing a git diff in the current working directory.
skill: code-review
target:
  type: git-repo
  path: .
mode: read-only
---

This room runs the `code-review` skill against the git repository at the working directory where `moss` was invoked.

Defaults:

- Diff selection (in order of preference): working-tree, staged, HEAD~1..HEAD.
- Mode: read-only. Moss writes nothing to the target repository.
- Reports (when requested by `--write-report`) are written under the Moss project, not the target repository.
