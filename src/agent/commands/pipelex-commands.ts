/**
 * Pipelex runner stub commands — registered only when --runner=pipelex (default).
 *
 * Each command is a thin stub that makes the command visible in --help,
 * then delegates to passthroughToPipelexAgent() which forwards the full
 * argv to pipelex-agent.
 */

import type { Command } from "commander";
import { passthroughToPipelexAgent } from "./pipelex-passthrough.js";

/**
 * Register all runner-aware commands as passthrough stubs.
 * Only called when --runner=pipelex (default).
 */
export function registerPipelexRunnerCommands(
  program: Command,
  getAutoInstall: () => boolean
): void {
  const action = () => {
    passthroughToPipelexAgent(getAutoInstall());
  };

  const stub = (cmd: Command) =>
    cmd.allowUnknownOption().allowExcessArguments(true).exitOverride().action(action);

  // ── concept ──

  stub(
    program
      .command("concept")
      .description("Structure a concept from JSON spec and output TOML")
  );

  // ── pipe ──

  stub(
    program
      .command("pipe")
      .description("Structure a pipe from JSON spec and output TOML")
  );

  // ── validate ──

  const validateGroup = program
    .command("validate")
    .description("Validate a method, pipe, or bundle")
    .passThroughOptions()
    .allowUnknownOption();

  stub(validateGroup.command("bundle").argument("[target]", "Bundle file (.mthds) or directory").description("Validate a bundle file or content"));
  stub(validateGroup.command("pipe").argument("<target>", "Pipe code or .mthds bundle file").description("Validate a pipe by code or bundle file"));
  stub(validateGroup.command("method").argument("<target>", "Method name, GitHub URL, or local path").description("Validate a method"));

  // ── run ──

  const runGroup = program
    .command("run")
    .description("Execute a pipeline")
    .passThroughOptions()
    .allowUnknownOption();

  stub(runGroup.command("method").argument("<name>", "Name of the installed method").description("Run an installed method by name"));
  stub(runGroup.command("pipe").argument("[target]", "Bundle file (.mthds) or directory").description("Run a pipe from a bundle file, directory, or content"));
  stub(runGroup.command("bundle").argument("[target]", "Bundle file (.mthds) or directory").description("Run a bundle file or content"));

  // ── models ──

  stub(
    program
      .command("models")
      .description("List available model presets, aliases, and waterfalls")
  );

  // ── check-model ──

  stub(
    program
      .command("check-model")
      .argument("<reference>", "Model reference to check")
      .description("Validate a model reference with fuzzy suggestions")
  );

  // ── accept-gateway-terms ──

  stub(
    program
      .command("accept-gateway-terms")
      .description("Accept Pipelex Gateway terms of service")
  );

  // ── inputs ──

  const inputsGroup = program
    .command("inputs")
    .description("Generate example input JSON for a pipe")
    .passThroughOptions()
    .allowUnknownOption();

  stub(inputsGroup.command("bundle").argument("[target]", "Bundle file (.mthds) or directory").description("Generate inputs from a bundle file or content"));
  stub(inputsGroup.command("pipe").argument("<target>", "Bundle file (.mthds) or pipe code").description("Generate inputs for a pipe"));
  stub(inputsGroup.command("method").argument("<name>", "Method name").description("Generate inputs for an installed method"));
}
