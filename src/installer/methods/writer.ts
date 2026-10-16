import { join, resolve, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { ResolvedRepo } from "../../package/manifest/types.js";
import { treePathViolation } from "../../method-tree/tree-path.js";
import { installedMethodFiles } from "./method-files.js";

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
  const shimContent = ["#!/bin/sh", `exec pipelex-agent run pipe "$@" -L '${escapedDir}'`, ""].join(
    "\n",
  );

  writeFileSync(shimPath, shimContent, { mode: 0o755 });

  if (process.platform === "win32") {
    const cmdPath = join(binDir, `${name}.cmd`);
    const cmdEscapedDir = installDir.replace(/%/g, "%%").replace(/"/g, '""');
    const cmdContent = ["@echo off", `pipelex-agent run pipe %* -L "${cmdEscapedDir}"`, ""].join(
      "\r\n",
    );
    writeFileSync(cmdPath, cmdContent, "utf-8");
  }
}

/**
 * Install each method of a ResolvedRepo into targetDir/<method-name>/: every file of its tree,
 * with its exact bytes, under its tree path, and a CLI shim for each. A method's directory is
 * replaced as a whole, so a file an earlier install left there that the method no longer holds
 * does not linger in its tree: the tree is written into a scratch directory beside it, whose
 * name starts with a dot so no tree or library scan ever takes it in, then moved into place.
 * Refuses any name or path that escapes targetDir or the method's directory (path traversal
 * protection), before anything of that method is written.
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
    const files = installedMethodFiles(method);
    for (const file of files) {
      const violation = treePathViolation(file.path);
      const filePath = resolve(installDir, ...file.path.split("/"));
      if (violation !== null || !filePath.startsWith(installDir + sep)) {
        throw new Error(`Path traversal detected: "${file.path}" escapes install directory.`);
      }
    }

    const staging = mkdtempSync(join(targetDir, ".installing-"));
    try {
      for (const file of files) {
        const filePath = join(staging, ...file.path.split("/"));
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.bytes);
      }
      rmSync(installDir, { recursive: true, force: true });
      renameSync(staging, installDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }

    generateShim(method.name, installDir);
  }
}
