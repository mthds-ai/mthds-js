import chalk from "chalk";
import { createRequire } from "node:module";

function getVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

const LOGO = [
  "  ████                                        ████",
  "  ██   ██   ██ ████████ ██   ██ █████  ██████   ██",
  "  ██   ███ ███    ██    ██   ██ ██  ██ ██       ██",
  "  ██   ██ █ ██    ██    ███████ ██  ██  ████    ██",
  "  ██   ██   ██    ██    ██   ██ ██  ██     ██   ██",
  "  ██   ██   ██    ██    ██   ██ █████  ██████   ██",
  "  ████                                        ████",
];

let _logoEnabled = true;

export function setLogoEnabled(enabled: boolean): void {
  _logoEnabled = enabled;
}

export function printLogo(): void {
  if (!_logoEnabled) return;
  console.log();
  for (const line of LOGO) {
    console.log(chalk.white(line));
  }
  console.log();
}

export function showBanner(): void {
  const version = getVersion();

  printLogo();
  console.log(chalk.dim(`  v${version}\n`));

  console.log(chalk.bold("  Usage:"));
  console.log(`    ${chalk.green("mthds")} ${chalk.yellow("<command>")} [options]\n`);

  console.log(chalk.bold("  Pipeline:"));
  console.log(
    `    ${chalk.yellow("run method <name>")}           Run an installed method`
  );
  console.log(
    `    ${chalk.yellow("run pipe <target>")}           Run a pipe by code or bundle file`
  );
  console.log(
    `    ${chalk.yellow("build pipe <brief>")}          Build a pipeline from a prompt`
  );
  console.log(
    `    ${chalk.yellow("build runner method|pipe")}    Generate Python runner code`
  );
  console.log(
    `    ${chalk.yellow("build inputs method|pipe")}    Generate example input JSON`
  );
  console.log(
    `    ${chalk.yellow("build output method|pipe")}    Generate output schema`
  );
  console.log(
    `    ${chalk.yellow("validate method <name>")}      Validate an installed method`
  );
  console.log(
    `    ${chalk.yellow("validate pipe <target>")}      Validate a pipe or bundle\n`
  );

  console.log(chalk.bold("  Configuration:"));
  console.log(
    `    ${chalk.yellow("config set <key> <val>")}    Set a config value`
  );
  console.log(
    `    ${chalk.yellow("config get <key>")}          Get a config value`
  );
  console.log(
    `    ${chalk.yellow("config list")}                List all config values`
  );
  console.log(
    `    ${chalk.yellow("runner setup <name>")}         Initialize a runner`
  );
  console.log(
    `    ${chalk.yellow("runner set-default <name>")}   Set the default runner`
  );
  console.log(
    `    ${chalk.yellow("runner status")}                Show runner configuration`
  );
  console.log(
    `    ${chalk.yellow("telemetry enable|disable")}    Toggle anonymous telemetry\n`
  );

  console.log(chalk.bold("  Installation:"));
  console.log(
    `    ${chalk.yellow("install <address>")}         Install a method package\n`
  );

  console.log(chalk.bold("  Package Management:"));
  console.log(
    `    ${chalk.yellow("package init")}               Initialize METHODS.toml`
  );
  console.log(
    `    ${chalk.yellow("package list")}               Display the package manifest`
  );
  console.log(
    `    ${chalk.yellow("package validate")}           Validate METHODS.toml\n`
  );

  console.log(
    chalk.dim("  Learn more: https://github.com/mthds-ai/mthds-js/blob/main/CLI.md\n")
  );
}
