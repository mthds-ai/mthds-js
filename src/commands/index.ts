import chalk from "chalk";
import { createRequire } from "node:module";

function getVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version: string };
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
    `    ${chalk.yellow("validate <target>")}         Validate PLX content\n`
  );

  console.log(chalk.bold("  Runners:"));
  console.log(
    `    ${chalk.yellow("setup runner <name>")}       Install a runner`
  );
  console.log(
    `    ${chalk.yellow("runner set-default <name>")} Set the default runner`
  );
  console.log(
    `    ${chalk.yellow("runner list")}                List available runners\n`
  );

  console.log(chalk.bold("  Setup:"));
  console.log(
    `    ${chalk.yellow("install <address>")}          Install a method package`
  );
  console.log(
    `    ${chalk.yellow("config set <key> <val>")}    Set a config value`
  );
  console.log(
    `    ${chalk.yellow("config get <key>")}          Get a config value`
  );
  console.log(
    `    ${chalk.yellow("config list")}                List all config values\n`
  );

  console.log(chalk.bold("  Examples:"));
  console.log(`    ${chalk.dim("$")} mthds run hello_world`);
  console.log(`    ${chalk.dim("$")} mthds run my_bundle.plx --inputs data.json`);
  console.log(`    ${chalk.dim("$")} mthds build pipe "Analyze a CV against a job offer"`);
  console.log(`    ${chalk.dim("$")} mthds validate my_bundle.plx`);
  console.log(`    ${chalk.dim("$")} mthds install pipelex/cookbook`);
  console.log(`    ${chalk.dim("$")} mthds install --dir ./my-local-method\n`);

  console.log(
    chalk.dim("  Docs: https://docs.pipelex.com \n")
  );

  console.log(chalk.bold("  Telemetry:"));
  console.log(
    `    ${chalk.yellow("telemetry disable")}        Disable anonymous telemetry`
  );
  console.log(
    `    ${chalk.yellow("telemetry enable")}         Enable anonymous telemetry`
  );
  console.log(
    `    ${chalk.yellow("telemetry status")}         Show telemetry status\n`
  );
  console.log(
    chalk.dim(
      "  Anonymous usage data (method slug + timestamp) is collected\n  to help rank methods. No personal info is collected.\n  Opt out: DISABLE_TELEMETRY=1 or mthds telemetry disable\n"
    )
  );
}
