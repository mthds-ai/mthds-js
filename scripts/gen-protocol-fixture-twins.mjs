// Generates the TypeScript twins of the protocol parity fixtures under
// tests/fixtures/protocol/ — one `.fixture.ts` per `.json`, each exporting the
// same value as a fresh object literal declared with the `mthds/protocol` type
// the fixture is a payload of. A JSON import would type every `kind` as
// `string`; the annotated literal is what lets `tsc` (`npm run typecheck:test`)
// fail when the fixture and the types disagree — a fresh literal against a
// declared type gets the full excess-property and discriminant checks. (An
// annotation rather than `satisfies` because TypeScript normalizes the inferred
// type of a large literal — sibling nodes with different `hints` keys become
// `{ intent: string; other?: undefined }` — and that inferred type is no longer
// assignable to the artifact type the tests index it as.) The runtime parity
// test (tests/unit/protocol/input-form-parity.test.ts) asserts each twin
// deep-equals its JSON, so a stale twin fails `npm test` instead of drifting.
//
//   npm run fixtures:protocol      (after replacing a fixture JSON)
//
// KNOWN_DIVERGENCES lists the sites where the engine that produced the fixture
// is known to disagree with the standard's page. The JSON stays untouched —
// the identical bytes are what `mthds-python` commits, and that identity is
// the parity — and the twin instead carries a `@ts-expect-error` at exactly
// those sites, each naming the ledger item that tracks the engine fix. The
// mechanism is self-cleaning: once a regenerated fixture no longer carries a
// divergence, its rule matches nothing and this script refuses to run until
// the entry is deleted, and a directive left behind by hand fails `tsc` as
// unused.
//
// One TypeScript behaviour shapes where a directive can go: an assignment
// error is elaborated into the deepest failing property, and once a nested
// error has been reported the enclosing object's own excess property is never
// reported. A matched site whose subtree holds another matched site would
// therefore get an *unused* directive, so it gets none and is counted as
// shadowed instead — the deeper site's directive is the one `tsc` sees.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const FIXTURES_DIR = new URL("../tests/fixtures/protocol/", import.meta.url);

const TWINS = [
  {
    json: "input_form.json",
    twin: "input_form.fixture.ts",
    exportName: "INPUT_FORM_FIXTURE",
    typeName: "InputForm",
    typeModule: "../../../src/protocol/input_form.js",
  },
  {
    json: "output_form.json",
    twin: "output_form.fixture.ts",
    exportName: "OUTPUT_FORM_FIXTURE",
    typeName: "OutputForm",
    typeModule: "../../../src/protocol/output_form.js",
  },
  {
    json: "pipe_io_contracts.json",
    twin: "pipe_io_contracts.fixture.ts",
    exportName: "PIPE_IO_CONTRACTS_FIXTURE",
    typeName: "PipeIOContracts",
    typeModule: "../../../src/protocol/pipe_io_contracts.js",
  },
];

/**
 * Each rule is judged per object property: `key` is the property being
 * printed, `parentKey` the key the enclosing object sits under (for an array
 * element, the array's key). A match emits a `@ts-expect-error` directive on
 * the line before the property.
 */
// Deliberately empty: the engine the current capture came from conforms to the
// page at every site the fixture reaches, so no twin carries a suppression. The
// machinery below stays because the next divergence is cheaper to record here
// than to rediscover — add an entry naming the ledger item that tracks the fix.
const KNOWN_DIVERGENCES = [];

/**
 * Prints `value` as a TypeScript literal. Returns the text and how many rule
 * matches the subtree holds, which is what decides whether a match at this
 * level gets a directive (none deeper) or is shadowed (see the header).
 */
function printValue(value, parentKey, indent, hits) {
  if (value === null) return { text: "null", matches: 0 };
  if (Array.isArray(value)) {
    if (value.length === 0) return { text: "[]", matches: 0 };
    let matches = 0;
    const inner = value.map((item) => {
      const printed = printValue(item, parentKey, `${indent}  `, hits);
      matches += printed.matches;
      return `${indent}  ${printed.text}`;
    });
    return { text: `[\n${inner.join(",\n")},\n${indent}]`, matches };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return { text: "{}", matches: 0 };
    const printed = entries.map(([key, child]) => ({
      key,
      child: printValue(child, key, `${indent}  `, hits),
      rules: KNOWN_DIVERGENCES.filter((rule) => rule.matches({ key, parentKey })),
    }));
    const deeper = printed.reduce((count, entry) => count + entry.child.matches, 0);
    let own = 0;
    const properties = printed.map(({ key, child, rules }) => {
      const lines = [];
      for (const rule of rules) {
        own += 1;
        const tally = hits.get(rule) ?? { emitted: 0, shadowed: 0 };
        if (deeper > 0) {
          tally.shadowed += 1;
        } else {
          tally.emitted += 1;
          lines.push(`${indent}  // @ts-expect-error ${rule.ledger}: ${rule.reason}`);
        }
        hits.set(rule, tally);
      }
      lines.push(`${indent}  ${JSON.stringify(key)}: ${child.text}`);
      return lines.join("\n");
    });
    return { text: `{\n${properties.join(",\n")},\n${indent}}`, matches: deeper + own };
  }
  return { text: JSON.stringify(value), matches: 0 };
}

const matchedRules = new Set();

for (const spec of TWINS) {
  const jsonPath = new URL(spec.json, FIXTURES_DIR);
  const twinPath = fileURLToPath(new URL(spec.twin, FIXTURES_DIR));
  const payload = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const hits = new Map();
  const { text: literal } = printValue(payload, undefined, "", hits);
  const source = [
    `// GENERATED FILE — do not edit. Regenerate with \`npm run fixtures:protocol\`.`,
    `// Source: tests/fixtures/protocol/${spec.json} (provenance in the README beside it).`,
    `// The \`${spec.typeName}\` annotation is the compile-time parity check between that payload`,
    `// and the type; the runtime test asserts this value deep-equals the JSON.`,
    ``,
    `import type { ${spec.typeName} } from "${spec.typeModule}";`,
    ``,
    `export const ${spec.exportName}: ${spec.typeName} = ${literal};`,
    ``,
  ].join("\n");
  const options = (await prettier.resolveConfig(twinPath)) ?? {};
  writeFileSync(twinPath, await prettier.format(source, { ...options, filepath: twinPath }));
  for (const rule of hits.keys()) matchedRules.add(rule);
  const summary =
    KNOWN_DIVERGENCES.length === 0
      ? "no known divergences"
      : KNOWN_DIVERGENCES.map((rule) => {
          const tally = hits.get(rule) ?? { emitted: 0, shadowed: 0 };
          return `${rule.ledger}: ${tally.emitted} directives, ${tally.shadowed} shadowed`;
        }).join("; ");
  process.stdout.write(`${spec.twin}: written (${summary})\n`);
}

// A rule that matched nothing in any fixture is dead: the engine now conforms
// on that point, and keeping the rule would re-suppress a future regression at
// the same site without anyone noticing.
const dead = KNOWN_DIVERGENCES.filter((rule) => !matchedRules.has(rule));
if (dead.length > 0) {
  process.stderr.write(
    `KNOWN_DIVERGENCES entries matched no site in any fixture — delete them and rerun: ${dead
      .map((rule) => rule.ledger)
      .join(", ")}\n`,
  );
  process.exit(1);
}
