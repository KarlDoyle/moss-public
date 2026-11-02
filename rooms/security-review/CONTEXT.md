---
id: security-review
name: Security review room
description: A read-only room for security-reviewing a git diff in the current working directory.
skill: security-review
target:
  type: git-repo
  path: .
mode: read-only
---

This room runs the `security-review` skill against the git repository at the working directory where `moss` was invoked.

Defaults:

- Diff selection (in order of preference): working-tree, staged, HEAD~1..HEAD.
- Mode: read-only. Moss writes nothing to the target repository.
- Reports (when requested by `--write-report`) are written under the Moss project, not the target repository.
- Scope: review only what is in the diff. The skill must not assume code or mitigations outside the changed lines.
