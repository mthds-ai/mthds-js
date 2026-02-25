import * as p from "@clack/prompts";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { printLogo } from "../index.js";
import { serializeManifestToToml } from "../../../package/manifest/parser.js";
import { MANIFEST_FILENAME } from "../../../package/discovery.js";
import type { ParsedManifest } from "../../../package/manifest/schema.js";
import { isValidAddress, isValidSemver, MTHDS_STANDARD_VERSION } from "../../../package/manifest/schema.js";

export async function packageInit(options: { directory?: string }): Promise<void> {
  printLogo();
  p.intro("mthds package init");

  const targetDir = resolve(options.directory ?? process.cwd());
  const manifestPath = join(targetDir, MANIFEST_FILENAME);

  if (existsSync(manifestPath)) {
    p.log.warning(`${MANIFEST_FILENAME} already exists in ${targetDir}`);
    const overwrite = await p.confirm({ message: "Overwrite?" });
    if (p.isCancel(overwrite) || !overwrite) {
      p.outro("Cancelled.");
      return;
    }
  }

  const address = await p.text({
    message: "Package address (e.g. github.com/org/repo)",
    validate: (val) => {
      if (!val) return "Address is required";
      if (!isValidAddress(val)) return "Must follow hostname/path pattern (e.g. github.com/org/repo)";
      return undefined;
    },
  });
  if (p.isCancel(address)) { p.outro("Cancelled."); return; }

  const version = await p.text({
    message: "Version",
    initialValue: "0.1.0",
    validate: (val) => {
      if (!val) return "Version is required";
      if (!isValidSemver(val)) return "Must be valid semver (e.g. 1.0.0)";
      return undefined;
    },
  });
  if (p.isCancel(version)) { p.outro("Cancelled."); return; }

  const description = await p.text({
    message: "Description",
    validate: (val) => {
      if (!val?.trim()) return "Description is required";
      return undefined;
    },
  });
  if (p.isCancel(description)) { p.outro("Cancelled."); return; }

  const authorInput = await p.text({
    message: "Author(s) (comma-separated, or leave empty)",
    initialValue: "",
  });
  if (p.isCancel(authorInput)) { p.outro("Cancelled."); return; }

  const license = await p.text({
    message: "License (e.g. MIT, or leave empty)",
    initialValue: "",
    validate: (val) => {
      if (val && !val.trim()) return "License must not be whitespace-only";
      return undefined;
    },
  });
  if (p.isCancel(license)) { p.outro("Cancelled."); return; }

  const authors = authorInput
    ? authorInput.split(",").map((a) => a.trim()).filter(Boolean)
    : [];

  const manifest: ParsedManifest = {
    address,
    version,
    description: description.trim(),
    authors,
    exports: {},
    mthdsVersion: `>=${MTHDS_STANDARD_VERSION}`,
    ...(license ? { license } : {}),
  };

  const tomlContent = serializeManifestToToml(manifest);
  try {
    writeFileSync(manifestPath, tomlContent, "utf-8");
  } catch (err) {
    p.log.error(`Failed to write ${MANIFEST_FILENAME}: ${(err as Error).message}`);
    p.outro("");
    process.exitCode = 1;
    return;
  }

  p.log.success(`Created ${MANIFEST_FILENAME} in ${targetDir}`);
  p.outro("");
}
