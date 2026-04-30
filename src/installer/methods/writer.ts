import { join, resolve, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ResolvedRepo } from "../../package/manifest/types.js";

/**
 * Generate an executable CLI shim for a method in ~/.mthds/bin/.
 *
 * The shim allows invoking a method directly by name, e.g.:
 *   extract-contract-terms --inputs '{"text": "..."}'
 *
 * On Windows, a .cmd shim is also generated.
 */
export function generateShim(name: string, installDir: string): void {
  const binDir = join(homedir(), ".mthds", "bin");
  mkdirSync(binDir, { recursive: true });

  const shimPath = join(binDir, name);
  const escapedDir = installDir.replace(/'/g, "'\\''");
  const shimContent = [
    "#!/bin/sh",
    `exec pipelex-agent run pipe "$@" -L '${escapedDir}'`,
    "",
  ].join("\n");

  writeFileSync(shimPath, shimContent, { mode: 0o755 });

  if (process.platform === "win32") {
    const cmdPath = join(binDir, `${name}.cmd`);
    const cmdEscapedDir = installDir.replace(/%/g, "%%").replace(/"/g, '""');
    const cmdContent = [
      "@echo off",
      `pipelex-agent run pipe %* -L "${cmdEscapedDir}"`,
      "",
    ].join("\r\n");
    writeFileSync(cmdPath, cmdContent, "utf-8");
  }
}

/**
 * Write all method files from a ResolvedRepo into targetDir/<method-name>/,
 * generating a CLI shim for each. Refuses any path that escapes targetDir or
 * the per-method install dir (path traversal protection).
 *
 * Agent-agnostic: the on-disk layout is identical regardless of which AI
 * coding agent triggered the install.
 */
export function writeMethodFiles(repo: ResolvedRepo, targetDirInput: string): void {
  const targetDir = resolve(targetDirInput);
  mkdirSync(targetDir, { recursive: true });

  for (const method of repo.methods) {
    const installDir = resolve(join(targetDir, method.name));
    if (!installDir.startsWith(targetDir + sep)) {
      throw new Error(`Path traversal detected: name "${method.name}" escapes target directory.`);
    }
    mkdirSync(installDir, { recursive: true });

    writeFileSync(join(installDir, "METHODS.toml"), method.rawManifest, "utf-8");

    for (const file of method.files) {
      const filePath = resolve(join(installDir, file.relativePath));
      if (!filePath.startsWith(installDir + sep)) {
        throw new Error(`Path traversal detected: "${file.relativePath}" escapes install directory.`);
      }
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, "utf-8");
    }

    generateShim(method.name, installDir);
  }
}
