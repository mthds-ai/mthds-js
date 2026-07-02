import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotenv, serializeDotenv } from "../../../src/config/config.js";

// The vendored tests/fixtures/config-dialect-cases.json is a byte-identical copy of the
// canonical case file in conformance/tests/mthds/fixtures/ (the dialect is pinned by
// docs/specs/mthds-config-file.md in the workspace repo, and the conformance repo's
// check-fixture-drift guard keeps the copies in sync). Running the cases here keeps this
// repo's own fast suite catching parser regressions without the conformance repo checked out.

interface ParseCase {
  name: string;
  description: string;
  input: string;
  expected: Record<string, string>;
}

interface SerializeCase {
  name: string;
  description: string;
  entries: Record<string, string>;
  expected: string;
}

interface RewriteCase {
  name: string;
  description: string;
  input: string;
  expected: string;
}

interface DialectCases {
  description: string;
  parse_cases: ParseCase[];
  serialize_cases: SerializeCase[];
  rewrite_cases: RewriteCase[];
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/config-dialect-cases.json",
);
const cases = JSON.parse(readFileSync(fixturePath, "utf-8")) as DialectCases;

describe("config dialect (shared conformance fixture)", () => {
  describe("parseDotenv", () => {
    for (const parseCase of cases.parse_cases) {
      it(`${parseCase.name}: ${parseCase.description}`, () => {
        expect(parseDotenv(parseCase.input)).toEqual(parseCase.expected);
      });
    }
  });

  describe("serializeDotenv", () => {
    for (const serializeCase of cases.serialize_cases) {
      it(`${serializeCase.name}: ${serializeCase.description}`, () => {
        expect(serializeDotenv(serializeCase.entries)).toBe(serializeCase.expected);
      });
    }
  });

  describe("round trip", () => {
    for (const serializeCase of cases.serialize_cases) {
      it(`${serializeCase.name}: parse(serialize(entries)) is lossless`, () => {
        expect(parseDotenv(serializeDotenv(serializeCase.entries))).toEqual(serializeCase.entries);
      });
    }
  });

  describe("rewrite (parse then serialize, as a programmatic set does)", () => {
    for (const rewriteCase of cases.rewrite_cases) {
      it(`${rewriteCase.name}: ${rewriteCase.description}`, () => {
        expect(serializeDotenv(parseDotenv(rewriteCase.input))).toBe(rewriteCase.expected);
      });
    }
  });
});
