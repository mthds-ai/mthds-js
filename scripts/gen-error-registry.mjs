// Generates src/problems/registry.generated.ts from the vendored MTHDS core error registry,
// scripts/registry/mthds-error-registry.json (scripts/vendor-error-registry.mjs vendors it): the
// registry's version, base URL, extension prefixes and families, a constant per core code, the
// typed parameters of every code, and the entry of every code a reader or an emitter needs, its
// title, domain, retry verdict, status, templates, steps and parameter types.
//
//   node scripts/gen-error-registry.mjs            writes the module
//   node scripts/gen-error-registry.mjs --check    fails when the committed module differs
//
// The module is committed, so that the package builds from its sources alone, and the drift check
// in tests/unit/problems/registry.test.ts runs `--check`. Never edit the module by hand.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const SNAPSHOT_URL = new URL("./registry/mthds-error-registry.json", import.meta.url);
const MODULE_URL = new URL("../src/problems/registry.generated.ts", import.meta.url);

/** The TypeScript type of a parameter value of a registry type. */
function paramValueType(param) {
  switch (param.type) {
    case "identifier":
    case "caller_text":
    case "sha256":
      return "string";
    case "integer":
    case "seconds":
    case "bytes":
      return "number";
    case "enum":
      if (!Array.isArray(param.values) || param.values.length === 0) {
        throw new Error(`an enum parameter declares no values: ${JSON.stringify(param)}`);
      }
      return param.values.map((value) => JSON.stringify(value)).join(" | ");
    case "list": {
      const items = paramValueType(param.items ?? {});
      return items.includes("|") ? `(${items})[]` : `${items}[]`;
    }
    default:
      throw new Error(`unknown parameter type: ${JSON.stringify(param)}`);
  }
}

/** The name of a code's constant: `client.response_unreadable` is `CLIENT_RESPONSE_UNREADABLE`. */
function constantName(code) {
  return code.replace(/\./g, "_").toUpperCase();
}

/** A JSDoc comment of one line, its text kept clear of the comment's own terminator. */
function doc(text, indent = "  ") {
  return `${indent}/** ${text.replace(/\*\//g, "*\\/")} */`;
}

/**
 * Refuse a template that is malformed or names a parameter its code does not declare: every `{`
 * and `}` is doubled or part of a `{name}` placeholder, as `renderTemplate` reads them.
 */
function checkTemplate(code, template, declared) {
  for (const match of template.matchAll(/\{\{|\}\}|\{([a-z][a-z0-9_]*)\}|[{}]/g)) {
    if (match[0] === "{" || match[0] === "}") {
      throw new Error(
        `${code}: a lone brace at ${match.index} makes a template malformed: ${template}`,
      );
    }
    if (match[1] !== undefined && !declared.includes(match[1])) {
      throw new Error(
        `${code}: a template names the undeclared parameter ${match[1]}: ${template}`,
      );
    }
  }
}

/** The entry of a code as the module holds it: the prose for the code's page left out. */
function moduleEntry(entry) {
  const declared = Object.keys(entry.params ?? {});
  for (const template of [entry.detail, entry.steps.actor.detail, entry.steps.other.detail]) {
    checkTemplate(entry.code, template, declared);
  }
  const params = {};
  for (const [name, param] of Object.entries(entry.params ?? {})) {
    const kept = { type: param.type };
    if (param.values !== undefined) kept.values = param.values;
    if (param.items !== undefined) kept.items = { type: param.items.type };
    if (param.optional === true) kept.optional = true;
    if (param.operator_only === true) kept.operator_only = true;
    params[name] = kept;
  }
  const kept = {
    code: entry.code,
    title: entry.title,
    domain: entry.domain,
    retry: entry.retry,
    raised_as: entry.raised_as,
  };
  if (entry.status !== undefined) kept.status = entry.status;
  kept.detail = entry.detail;
  kept.steps = {
    actor: { kind: entry.steps.actor.kind, detail: entry.steps.actor.detail },
    other: { kind: entry.steps.other.kind, detail: entry.steps.other.detail },
  };
  kept.params = params;
  return kept;
}

function render(registry) {
  const codes = registry.codes.map((entry) => entry.code);
  const names = new Map();
  for (const code of codes) {
    const name = constantName(code);
    if (names.has(name))
      throw new Error(`codes ${names.get(name)} and ${code} share a constant name`);
    names.set(name, code);
  }
  const constants = registry.codes
    .map(
      (entry) =>
        `${doc(entry.title)}\n  ${constantName(entry.code)}: ${JSON.stringify(entry.code)},`,
    )
    .join("\n");
  const paramTypes = registry.codes
    .map((entry) => {
      const params = Object.entries(entry.params ?? {});
      if (params.length === 0) {
        return `${doc(entry.title)}\n  ${JSON.stringify(entry.code)}: Record<string, never>;`;
      }
      const members = params
        .map(([name, param]) => {
          // A parameter an occurrence may lack, or one only the operator reads, may be absent.
          const optional = param.optional === true || param.operator_only === true ? "?" : "";
          return `${doc(param.description, "    ")}\n    ${name}${optional}: ${paramValueType(param)};`;
        })
        .join("\n");
      return `${doc(entry.title)}\n  ${JSON.stringify(entry.code)}: {\n${members}\n  };`;
    })
    .join("\n");
  const entries = registry.codes
    .map((entry) => `  ${JSON.stringify(entry.code)}: ${JSON.stringify(moduleEntry(entry))},`)
    .join("\n");
  const families = registry.families.map((family) => family.family);
  const prefixes = registry.extension_prefixes.map(({ prefix, owner, base_url }) => ({
    prefix,
    owner,
    base_url,
  }));

  return `// GENERATED by scripts/gen-error-registry.mjs from scripts/registry/mthds-error-registry.json,
// the MTHDS core error registry ${registry.version}. Do not edit by hand: re-vendor the registry with
// \`make vendor-error-registry\`, or run \`node scripts/gen-error-registry.mjs\` to regenerate this
// module from the vendored snapshot, and \`--check\` to verify it.

import type { ExtensionPrefix, RegistryEntry } from "./types.js";

/** The version of the vendored core registry: the standard version it is published with. */
export const MTHDS_ERROR_REGISTRY_VERSION = ${JSON.stringify(registry.version)};

/** The base URL of every core code's type URI: \`<base>/<code>\`. */
export const CORE_ERROR_BASE_URL = ${JSON.stringify(registry.base_url)};

/** The prefixes registered for extension codes, each with the base URL of its codes' type URIs. */
export const EXTENSION_PREFIXES: readonly ExtensionPrefix[] = ${JSON.stringify(prefixes)};

/** The core families: a core code is a family and a name, such as \`input.missing\`. */
export const ERROR_FAMILIES = ${JSON.stringify(families)} as const;

export type ErrorFamily = (typeof ERROR_FAMILIES)[number];

/** Every core code, under a constant named after it. A client branches on these. */
export const ERROR_CODES = {
${constants}
} as const;

/** A code the core registry declares. */
export type CoreErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * The parameters of each core code, as its registry entry types them. A parameter an occurrence
 * may lack, and one only whoever runs the runtime reads, which a caller never sees, are optional.
 */
export interface ProblemParamsByCode {
${paramTypes}
}

/** The entry of every core code, keyed by its code. */
export const CORE_REGISTRY: { readonly [Code in CoreErrorCode]: RegistryEntry } = {
${entries}
};
`;
}

async function main() {
  const check = process.argv.includes("--check");
  const registry = JSON.parse(readFileSync(SNAPSHOT_URL, "utf-8"));
  const module = render(registry);
  const options = (await prettier.resolveConfig(fileURLToPath(MODULE_URL))) ?? {};
  const formatted = await prettier.format(module, { ...options, parser: "typescript" });
  if (check) {
    let committed = "";
    try {
      committed = readFileSync(MODULE_URL, "utf-8");
    } catch {
      // A module that is not there differs from what the snapshot generates.
    }
    if (committed !== formatted) {
      process.stderr.write(
        `${fileURLToPath(MODULE_URL)} is not what the vendored registry generates; run node scripts/gen-error-registry.mjs\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `${fileURLToPath(MODULE_URL)} matches the vendored registry ${registry.version}\n`,
    );
    return;
  }
  writeFileSync(MODULE_URL, formatted);
  process.stdout.write(
    `wrote ${fileURLToPath(MODULE_URL)} from the registry ${registry.version}\n`,
  );
}

await main();
