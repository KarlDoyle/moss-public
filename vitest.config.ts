import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    setupFiles: ["tests/setup-env.ts"],
    // Belt and braces: no test run may append to the real Taisce telemetry files.
    env: {
      MOSS_LANE_USAGE_FILE: "/tmp/moss-vitest-lane-usage.jsonl",
      MOSS_BENCH_FILE: "/tmp/moss-vitest-model-bench.jsonl",
      // …and may never start or stop the real Ollama app (src/lib/ollama-lifecycle.ts).
      MOSS_NO_OLLAMA_LIFECYCLE: "1",
    },
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["dist/**", "scripts/**", "tests/**", "**/*.config.ts"],
      // Ratchet, not a stretch goal. Raised 2026-09-18 (unified router) to just below the measured
      // 79.94 / 69.33 / 76.38 / 80.89. Set at/just-below the coverage measured on
      // 2026-06-29 (stmts 76.56 / branch 61.11 / funcs 75.04 / lines 77.59) so the
      // repo is green now and coverage can only go up. Raise these as you add
      // tests; never lower them. See shared build tooling playbook/testing-and-coverage.md.
      thresholds: {
        statements: 79,
        branches: 69,
        functions: 76,
        lines: 80,
      },
    },
  },
});
