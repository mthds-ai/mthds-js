import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import type { DomainExports } from "./manifest/schema.js";

/**
 * Scan .mthds bundle files and extract domain/pipe metadata.
 *
 * Returns:
 * - domainPipes: mapping domain -> set of pipe codes
 * - domainMainPipes: mapping domain -> main_pipe code
 * - errors: list of human-readable error strings
 */
export function scanBundlesForDomainInfo(
  mthdsFiles: string[],
): {
  domainPipes: Map<string, Set<string>>;
  domainMainPipes: Map<string, string>;
  errors: string[];
} {
  const domainPipes = new Map<string, Set<string>>();
  const domainMainPipes = new Map<string, string>();
  const errors: string[] = [];

  for (const filePath of mthdsFiles) {
    let data: Record<string, unknown>;
    try {
      const content = readFileSync(filePath, "utf-8");
      data = parse(content) as Record<string, unknown>;
    } catch (err) {
      errors.push(`${filePath}: ${(err as Error).message}`);
      continue;
    }

    const domain = data["domain"];
    if (typeof domain !== "string" || !domain) {
      errors.push(`${filePath}: missing or invalid 'domain' field`);
      continue;
    }

    // Collect pipe codes from [pipe.*] sections
    const pipesSection = data["pipe"];
    const pipeCodes = new Set<string>();
    if (pipesSection && typeof pipesSection === "object" && !Array.isArray(pipesSection)) {
      for (const key of Object.keys(pipesSection as Record<string, unknown>)) {
        pipeCodes.add(key);
      }
    }

    const existing = domainPipes.get(domain);
    if (existing) {
      for (const code of pipeCodes) existing.add(code);
    } else {
      domainPipes.set(domain, pipeCodes);
    }

    // Collect main_pipe if declared
    const mainPipe = data["main_pipe"];
    if (typeof mainPipe === "string" && mainPipe) {
      const existingMain = domainMainPipes.get(domain);
      if (!existingMain || existingMain === mainPipe) {
        domainMainPipes.set(domain, mainPipe);
      } else {
        errors.push(`${filePath}: conflicting main_pipe for domain '${domain}': '${existingMain}' vs '${mainPipe}' (keeping '${existingMain}')`);
      }
    }
  }

  return { domainPipes, domainMainPipes, errors };
}

/**
 * Build DomainExports dict from scan results.
 */
export function buildDomainExportsFromScan(
  domainPipes: Map<string, Set<string>>,
  domainMainPipes: Map<string, string>,
): Record<string, DomainExports> {
  const exports: Record<string, DomainExports> = {};

  const sortedDomains = [...domainPipes.keys()].sort();
  for (const domain of sortedDomains) {
    const pipes = new Set(domainPipes.get(domain)!);

    // Ensure main_pipe is in the exported pipe list
    const mainPipe = domainMainPipes.get(domain);
    if (mainPipe) {
      pipes.add(mainPipe);
    }

    exports[domain] = { pipes: [...pipes].sort() };
  }

  return exports;
}
