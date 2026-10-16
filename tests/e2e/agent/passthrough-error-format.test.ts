import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "../../../dist/agent-cli.js");

// On the pipelex runner, mthds-agent forwards a command to pipelex-agent, which writes the
// command's failure itself. pipelex-agent accepts `--error-format` after a command only, and not
// at all on `inputs`, so mthds-agent moves the option after the command, or drops it for `inputs`.
// pipelex-agent is a stand-in first on the PATH that prints the arguments it was given.

const home = mkdtempSync(join(tmpdir(), "mthds-passthrough-format-"));
const bin = join(home, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "pipelex-agent"),
  [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "pipelex 99.0.0"; exit 0; fi',
    'printf "%s\\n" "$@"',
    "",
  ].join("\n"),
);
chmodSync(join(bin, "pipelex-agent"), 0o755);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The arguments the stand-in pipelex-agent received, one per line of its output. */
function forwardedArgs(...args: string[]): string[] {
  const result = spawnSync("node", [CLI_PATH, "--runner", "pipelex", ...args], {
    encoding: "utf-8",
    timeout: 10_000,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout.split("\n").filter((line) => line !== "");
}

describe.skipIf(process.platform === "win32")(
  "mthds-agent's --error-format on a command forwarded to pipelex-agent (e2e)",
  () => {
    it("moves --error-format given before the command after it", () => {
      expect(forwardedArgs("--error-format", "json", "run", "bundle", "x.mthds")).toEqual([
        "run",
        "bundle",
        "x.mthds",
        "--error-format",
        "json",
      ]);
    });

    it("keeps --error-format given on the command after it", () => {
      expect(forwardedArgs("validate", "bundle", "x.mthds", "--error-format=json")).toEqual([
        "validate",
        "bundle",
        "x.mthds",
        "--error-format",
        "json",
      ]);
    });

    it("drops --error-format on inputs, which pipelex-agent does not give it", () => {
      expect(forwardedArgs("inputs", "bundle", "x.mthds", "--error-format", "json")).toEqual([
        "inputs",
        "bundle",
        "x.mthds",
      ]);
      expect(forwardedArgs("--error-format=json", "inputs", "pipe", "x.mthds")).toEqual([
        "inputs",
        "pipe",
        "x.mthds",
      ]);
    });
  },
);
