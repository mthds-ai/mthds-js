import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildProblemFromEntry } from "../../../src/problems/build.js";
import { readAnswer } from "../../../src/problems/read.js";
import type { StepReader } from "../../../src/problems/build.js";
import { CORE_REGISTRY } from "../../../src/problems/registry.generated.js";

// A registry template names only parameters every occurrence gives, so building a problem throws
// on a placeholder its parameters leave unfilled. Every problem this client builds of a core code
// is built here, with the parameters its build site passes, for both readers, so that a site
// leaving out a parameter one reader's step or the detail names fails here rather than in the
// middle of a failure, whichever reader a caller later asks for.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUILDERS = new Set(["agentProblem", "buildProblem", "problemError"]);
const READERS: StepReader[] = ["actor", "other"];

interface BuildSite {
  where: string;
  code: string;
  params: string[];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** Every call of a builder naming a core code, with the names of the parameters it passes. */
function buildSites(): BuildSite[] {
  const sites: BuildSite[] = [];
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        BUILDERS.has(node.expression.text)
      ) {
        const [code, params] = node.arguments;
        if (code !== undefined && ts.isStringLiteral(code)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const where = `${relative(ROOT, file)}:${line}`;
          if (params === undefined || !ts.isObjectLiteralExpression(params)) {
            throw new Error(
              `${where} passes parameters this test cannot read; pass an object literal.`,
            );
          }
          const names = params.properties.map((property) => {
            if (ts.isSpreadAssignment(property) || property.name === undefined) {
              throw new Error(`${where} spreads its parameters; name each one.`);
            }
            return property.name.getText(source);
          });
          sites.push({ where, code: code.text, params: names });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

describe("every problem the client builds", () => {
  const sites = buildSites();

  it("finds the build sites", () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it.each(sites)("builds $code at $where for either reader", ({ code, params }) => {
    const entry = CORE_REGISTRY[code as keyof typeof CORE_REGISTRY];
    expect(entry, `${code} is no core code`).toBeDefined();
    const values = Object.fromEntries(params.map((name) => [name, "x"]));
    for (const reader of READERS) {
      expect(() => buildProblemFromEntry(entry, values, { reader })).not.toThrow();
    }
  });
});

describe("every problem the client reads an answer by its status as", () => {
  const statuses = Array.from({ length: 500 }, (_, index) => index + 100);

  it.each([false, true])("builds one for every status, createsRun %s", (createsRun) => {
    for (const status of statuses) {
      const answer = { status, headers: new Headers(), body: "<html>no problem</html>" };
      expect(() => readAnswer(answer, { createsRun }), `status ${status}`).not.toThrow();
    }
  });

  it("builds each code a status reads as, with the parameters it names, for either reader", () => {
    for (const status of statuses) {
      for (const createsRun of [false, true]) {
        const answer = { status, headers: new Headers(), body: "" };
        const { problem } = readAnswer(answer, { createsRun });
        const entry = CORE_REGISTRY[problem.code as keyof typeof CORE_REGISTRY];
        const params = problem.params ?? {};
        for (const reader of READERS) {
          expect(
            () => buildProblemFromEntry(entry, params, { reader }),
            problem.code,
          ).not.toThrow();
        }
      }
    }
  });
});
