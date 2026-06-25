import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "../../../dist/agent-cli.js");

function runAgent(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

// On the API runner, `validate bundle`/`validate pipe` accept `--format` / `--error-format`.
// These reject an out-of-vocabulary value at option-parse time (a clean ArgumentError envelope)
// instead of silently coercing the typo to the default `markdown`. Rejection happens before the
// action runs, so no API config or real bundle is needed.
describe("mthds-agent validate --format/--error-format value validation (e2e)", () => {
  it("rejects an invalid --format value instead of silently coercing to markdown", () => {
    const { stderr, status } = runAgent(
      "--runner",
      "api",
      "validate",
      "bundle",
      "nonexistent.mthds",
      "--format",
      "jsno",
    );
    expect(status).toBe(1);
    const payload = JSON.parse(stderr) as {
      error?: boolean;
      error_type?: string;
      message?: string;
    };
    expect(payload.error).toBe(true);
    expect(payload.error_type).toBe("ArgumentError");
    expect(payload.message).toContain("jsno");
  });

  it("rejects an invalid --error-format value on validate pipe", () => {
    const { stderr, status } = runAgent(
      "--runner",
      "api",
      "validate",
      "pipe",
      "nonexistent.mthds",
      "--error-format",
      "yaml",
    );
    expect(status).toBe(1);
    const payload = JSON.parse(stderr) as { error_type?: string; message?: string };
    expect(payload.error_type).toBe("ArgumentError");
    expect(payload.message).toContain("yaml");
  });
});
