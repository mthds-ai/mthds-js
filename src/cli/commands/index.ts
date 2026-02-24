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
  "                    __  __              __",
  "   ____ ___  ___  / /_/ /_  ____  ____/ /____",
  "  / __ `__ \\/ _ \\/ __/ __ \\/ __ \\/ __  / ___/",
  " / / / / / /  __/ /_/ / / / /_/ / /_/ (__  )",
  "/_/ /_/ /_/\\___/\\__/_/ /_/\\____/\\__,_/____/",
];

export function printLogo(): void {
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
    `    ${chalk.yellow("run <target>")}              Execute a pipeline`
  );
  console.log(
    `    ${chalk.yellow("build pipe <brief>")}        Build a pipeline from a prompt`
  );
  console.log(
    `    ${chalk.yellow("build runner <bundle>")}     Generate Python runner code`
  );
  console.log(
    `    ${chalk.yellow("build inputs <bundle>")}     Generate example input JSON`
  );
  console.log(
    `    ${chalk.yellow("build output <bundle>")}     Generate output schema`
  );
  console.log(
    `    ${chalk.yellow("validate <target>")}         Validate a bundle\n`
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
    `    ${chalk.yellow("setup runner <name>")}       Install a runner\n`
  );

  console.log(chalk.bold("  Installation (JS-only):"));
  console.log(
    `    ${chalk.yellow("install <address>")}         Install a method package\n`
  );

  console.log(chalk.bold("  Package Management:"));
  console.log(
    `    ${chalk.yellow("package init")}              Initialize METHODS.toml`
  );
  console.log(
    `    ${chalk.yellow("package list")}              Display the package manifest`
  );
  console.log(
    `    ${chalk.yellow("package add <dep>")}         Add a dependency`
  );
  console.log(
    `    ${chalk.yellow("package lock")}              Resolve and generate lock file`
  );
  console.log(
    `    ${chalk.yellow("package install")}           Install dependencies`
  );
  console.log(
    `    ${chalk.yellow("package update")}            Update dependencies\n`
  );

  console.log(chalk.bold("  Examples:"));
  console.log(`    ${chalk.dim("$")} mthds run hello_world`);
  console.log(`    ${chalk.dim("$")} mthds run my_bundle.mthds --inputs data.json`);
  console.log(`    ${chalk.dim("$")} mthds build pipe "Analyze a CV against a job offer"`);
  console.log(`    ${chalk.dim("$")} mthds validate my_bundle.mthds`);
  console.log(`    ${chalk.dim("$")} mthds install pipelex/cookbook\n`);

  console.log(
    chalk.dim("  Docs: https://docs.pipelex.com \n")
  );
}
