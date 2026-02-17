import * as p from "@clack/prompts";
import chalk from "chalk";
import { printLogo } from "./index.js";
import { getConfigValue, setConfigValue } from "../config/config.js";
import { isPipelexInstalled } from "../runtime/check.js";
import type { RunnerType } from "../runners/types.js";

const KNOWN_RUNNERS: { type: RunnerType; label: string; builtin: boolean }[] = [
  { type: "api", label: "Pipelex API", builtin: true },
  { type: "pipelex", label: "Pipelex CLI (local)", builtin: false },
];

function isRunnerAvailable(type: RunnerType): boolean {
  switch (type) {
    case "api":
      return true;
    case "pipelex":
      return isPipelexInstalled();
    default:
      return false;
  }
}

export async function runnerSetDefault(name: string): Promise<void> {
  printLogo();
  p.intro("mthds runner set-default");

  const known = KNOWN_RUNNERS.find((r) => r.type === name);
  if (!known) {
    p.log.error(`Unknown runner: ${name}`);
    p.log.info(
      `Available runners: ${KNOWN_RUNNERS.map((r) => r.type).join(", ")}`
    );
    p.outro("");
    process.exit(1);
  }

  if (!known.builtin && !isRunnerAvailable(known.type)) {
    p.log.error(`Runner "${name}" is not installed.`);
    p.log.info(`Install it first: mthds setup runner ${name}`);
    p.outro("");
    process.exit(1);
  }

  setConfigValue("runner", name);
  p.log.success(`Default runner set to ${name}.`);
  p.outro("Done");
}

export async function runnerList(): Promise<void> {
  printLogo();
  p.intro("mthds runner list");

  const { value: currentDefault, source } = getConfigValue("runner");
  const sourceLabel =
    source === "env" ? " (from env)" : source === "default" ? " (default)" : "";

  p.log.info(`Default runner: ${chalk.bold(currentDefault)}${sourceLabel}\n`);

  for (const r of KNOWN_RUNNERS) {
    const available = isRunnerAvailable(r.type);
    const isDefault = r.type === currentDefault;
    const status = available
      ? chalk.green("installed")
      : r.builtin
        ? chalk.green("built-in")
        : chalk.dim("not installed");
    const defaultMark = isDefault ? chalk.yellow(" (default)") : "";

    p.log.info(`  ${chalk.bold(r.type)} — ${r.label}  ${status}${defaultMark}`);
  }

  p.outro("Done");
}
