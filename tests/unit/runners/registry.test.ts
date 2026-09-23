import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
import { PipelexRunner } from "../../../src/runners/pipelex/runner.js";

// Mock the config module so createRunner("mthds-cli") does not read the real filesystem
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...original,
    loadConfig: vi.fn(() => ({
      runner: "api",
      baseUrl: "https://api.pipelex.com",
      apiKey: "",
      telemetry: true,
    })),
    getConfigValue: vi.fn(() => ({ value: "https://api.pipelex.com", source: "default" })),
    findLegacyUrlKey: vi.fn(() => undefined),
    findLegacyApiKeyKey: vi.fn(() => undefined),
  };
});

// Import after mock setup
import { cliAppInfo, createRunner } from "../../../src/runners/registry.js";
import { MTHDS_JS_VERSION } from "../../../src/version.js";
import { isApiRunner, isPipelexRunner } from "../../../src/cli/commands/utils.js";
import { loadConfig } from "../../../src/config/config.js";

const mockedLoadConfig = vi.mocked(loadConfig);

describe("createRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the API client (the API runner) when type is 'api'", () => {
    const runner = createRunner("mthds-cli", "api");
    expect(runner).toBeInstanceOf(MthdsApiClient);
    expect(runner.type).toBe("api");
  });

  it("returns PipelexRunner when type is 'pipelex'", () => {
    const runner = createRunner("mthds-cli", "pipelex");
    expect(runner).toBeInstanceOf(PipelexRunner);
    expect(runner.type).toBe("pipelex");
  });

  it("reads default runner type from config when no type is passed", () => {
    mockedLoadConfig.mockReturnValue({
      runner: "pipelex",
      baseUrl: "https://api.pipelex.com",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });

    const runner = createRunner("mthds-cli");
    expect(runner).toBeInstanceOf(PipelexRunner);
    expect(loadConfig).toHaveBeenCalled();
  });

  it("uses config default 'api' runner", () => {
    mockedLoadConfig.mockReturnValue({
      runner: "api",
      baseUrl: "https://api.pipelex.com",
      apiKey: "test-key",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });

    const runner = createRunner("mthds-cli");
    expect(runner).toBeInstanceOf(MthdsApiClient);
    expect(loadConfig).toHaveBeenCalled();
  });

  it("throws on unknown runner type", () => {
    expect(() => createRunner("mthds-cli", "unknown" as never)).toThrow(
      "Unknown runner type: unknown",
    );
  });
});

describe("runner type guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("isApiRunner narrows the API client (the type-safe gateway to the mthds_sources extension)", () => {
    const api = createRunner("mthds-cli", "api");
    const pipelex = createRunner("mthds-cli", "pipelex");
    expect(isApiRunner(api)).toBe(true);
    expect(isApiRunner(pipelex)).toBe(false);
  });

  it("isPipelexRunner narrows the local CLI runner", () => {
    const api = createRunner("mthds-cli", "api");
    const pipelex = createRunner("mthds-cli", "pipelex");
    expect(isPipelexRunner(pipelex)).toBe(true);
    expect(isPipelexRunner(api)).toBe(false);
  });
});

describe("createRunner caller identity (client-identification spec)", () => {
  const LIBRARY_UA = `mthds-js/${MTHDS_JS_VERSION} node/${process.versions.node} (${process.platform}; ${process.arch})`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadConfig.mockReturnValue({
      runner: "api",
      baseUrl: "https://api.pipelex.com",
      apiKey: "k",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps each binary to its registry token at this package's version", () => {
    expect(cliAppInfo("mthds-cli")).toEqual({ name: "mthds-cli", version: MTHDS_JS_VERSION });
    expect(cliAppInfo("mthds-agent")).toEqual({ name: "mthds-agent", version: MTHDS_JS_VERSION });
  });

  it.each(["mthds-cli", "mthds-agent"] as const)(
    "the %s binary names itself in front of mthds-js",
    async (caller) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const runner = createRunner(caller, "api");
      expect(runner).toBeInstanceOf(MthdsApiClient);
      await (runner as MthdsApiClient).health();
      const init = fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> };
      expect(init.headers["User-Agent"]).toBe(`${caller}/${MTHDS_JS_VERSION} ${LIBRARY_UA}`);
    },
  );
});

describe("createRunner call sites name the right binary", () => {
  // The caller argument is required, so it cannot be forgotten; this guards the
  // other mistake — an `mthds` command module claiming to be the agent, or back.
  const srcRoot = fileURLToPath(new URL("../../../src/", import.meta.url));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  function expectedCaller(file: string): string | undefined {
    const rel = relative(srcRoot, file).split(sep).join("/");
    if (rel === "cli.ts" || rel.startsWith("cli/")) return "mthds-cli";
    if (rel === "agent-cli.ts" || rel.startsWith("agent/")) return "mthds-agent";
    return undefined;
  }

  it("every call in the mthds binary passes mthds-cli and every call in mthds-agent passes mthds-agent", () => {
    let calls = 0;
    for (const file of sourceFiles(srcRoot)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(?:=|return)\s+createRunner\(\s*("[^"]*")?/g)) {
        if (file.endsWith(join("runners", "registry.ts"))) continue;
        calls += 1;
        const expected = expectedCaller(file);
        expect(expected, `unexpected createRunner caller in ${file}`).toBeDefined();
        expect(match[1], `${file} must pass "${expected}"`).toBe(`"${expected}"`);
      }
    }
    expect(calls).toBeGreaterThan(0);
  });
});
