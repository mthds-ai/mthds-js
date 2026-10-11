import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to mock the paths used by the config module before importing it.
// The module reads CONFIG_DIR = join(homedir(), ".mthds") at module level,
// so we mock `node:os` homedir to point to a temp directory.

let tempHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => tempHome,
  };
});

// Dynamic import after mock setup — we must re-import for each test
// so we get a fresh module instance.
async function importConfig() {
  vi.resetModules();
  const mod = await import("../../../src/config/config.js");
  return mod;
}

describe("config", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "mthds-test-"));
    vi.unstubAllEnvs();
    // Env beats file in the config precedence, so any MTHDS_* variable exported by
    // the shell running vitest (a developer's real MTHDS_API_KEY, typically) would
    // leak into every assertion. unstubAllEnvs only clears stubs, not ambient env —
    // stub each ambient config variable to undefined so it is deleted for the test
    // and restored afterwards.
    for (const name of Object.keys(process.env)) {
      if (
        name.startsWith("MTHDS_") ||
        name.startsWith("PIPELEX_USAGE_STATS") ||
        name === "DISABLE_TELEMETRY" ||
        name === "DO_NOT_TRACK"
      ) {
        vi.stubEnv(name, undefined);
      }
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ---------------------------------------------------------------------------
  // loadConfig
  // ---------------------------------------------------------------------------
  describe("loadConfig", () => {
    it("returns defaults when no config file exists", async () => {
      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.runner).toBe("pipelex");
      expect(config.baseUrl).toBe("https://api.pipelex.com");
      expect(config.apiKey).toBe("");
      expect(config).not.toHaveProperty("telemetry");
      expect(config.autoUpgrade).toBe(false);
      expect(config.updateCheck).toBe(true);
    });

    it("reads values from config file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "MTHDS_RUNNER=api\nMTHDS_API_KEY=my-secret-key\n",
        "utf-8",
      );

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.runner).toBe("api");
      expect(config.apiKey).toBe("my-secret-key");
      // baseUrl should still be the default
      expect(config.baseUrl).toBe("https://api.pipelex.com");
    });

    it("env vars override file values", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "MTHDS_API_KEY=file-key\nMTHDS_RUNNER=pipelex\n",
        "utf-8",
      );

      vi.stubEnv("MTHDS_API_KEY", "env-key");
      vi.stubEnv("MTHDS_RUNNER", "api");

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.apiKey).toBe("env-key");
      expect(config.runner).toBe("api");
    });

    it("reads DISABLE_TELEMETRY in the file as the legacy opt-out, not as a setting", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config"), "DISABLE_TELEMETRY=1\n", "utf-8");

      const { loadConfig, getConfigValue } = await importConfig();
      expect(loadConfig()).not.toHaveProperty("telemetry");
      // Not migrated yet: the telemetry key reports it, from the file, in the "1 means off" encoding.
      expect(getConfigValue("telemetry")).toEqual({ value: "1", source: "file" });
    });

    it("parses dotenv format correctly (ignores comments and blank lines)", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "# This is a comment\n\nMTHDS_API_KEY=test-key\n\n# Another comment\nMTHDS_BASE_URL=http://localhost:8081\n",
        "utf-8",
      );

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.apiKey).toBe("test-key");
      expect(config.baseUrl).toBe("http://localhost:8081");
    });

    it("reads baseUrl from the config file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config"), "MTHDS_BASE_URL=http://localhost:8081\n", "utf-8");

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.baseUrl).toBe("http://localhost:8081");
    });

    it("env MTHDS_BASE_URL overrides the file value", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config"), "MTHDS_BASE_URL=http://file-host:8081\n", "utf-8");
      vi.stubEnv("MTHDS_BASE_URL", "http://env-host:8081");

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.baseUrl).toBe("http://env-host:8081");
    });
  });

  // ---------------------------------------------------------------------------
  // getConfigValue
  // ---------------------------------------------------------------------------
  describe("getConfigValue", () => {
    it("returns default source when no file or env", async () => {
      const { getConfigValue } = await importConfig();
      const result = getConfigValue("baseUrl");
      expect(result.value).toBe("https://api.pipelex.com");
      expect(result.source).toBe("default");
    });

    it("returns file source when value is in config file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config"), "MTHDS_API_KEY=file-key\n", "utf-8");

      const { getConfigValue } = await importConfig();
      const result = getConfigValue("apiKey");
      expect(result.value).toBe("file-key");
      expect(result.source).toBe("file");
    });

    it("returns env source when env var is set", async () => {
      vi.stubEnv("MTHDS_BASE_URL", "http://env-host:8081");

      const { getConfigValue } = await importConfig();
      const result = getConfigValue("baseUrl");
      expect(result.value).toBe("http://env-host:8081");
      expect(result.source).toBe("env");
    });

    it("env takes precedence over file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config"), "MTHDS_API_KEY=file-key\n", "utf-8");
      vi.stubEnv("MTHDS_API_KEY", "env-key");

      const { getConfigValue } = await importConfig();
      const result = getConfigValue("apiKey");
      expect(result.value).toBe("env-key");
      expect(result.source).toBe("env");
    });
  });

  // ---------------------------------------------------------------------------
  // setConfigValue
  // ---------------------------------------------------------------------------
  describe("setConfigValue", () => {
    it("writes value to config file", async () => {
      const { setConfigValue } = await importConfig();
      setConfigValue("apiKey", "new-key");

      const content = readFileSync(join(tempHome, ".mthds", "config"), "utf-8");
      expect(content).toContain("MTHDS_API_KEY=new-key");
    });

    it("writes baseUrl under the MTHDS_BASE_URL file key", async () => {
      const { setConfigValue } = await importConfig();
      setConfigValue("baseUrl", "http://localhost:8081");

      const content = readFileSync(join(tempHome, ".mthds", "config"), "utf-8");
      expect(content).toContain("MTHDS_BASE_URL=http://localhost:8081");
    });

    it("creates config directory if it does not exist", async () => {
      const { setConfigValue } = await importConfig();
      setConfigValue("runner", "pipelex");

      const content = readFileSync(join(tempHome, ".mthds", "config"), "utf-8");
      expect(content).toContain("MTHDS_RUNNER=pipelex");
    });

    it("turns usage statistics off in the shared state, not in the config file", async () => {
      const { setConfigValue, getConfigValue } = await importConfig();

      setConfigValue("telemetry", "false");
      expect(existsSync(join(tempHome, ".mthds", "usage-stats", "disabled"))).toBe(true);
      expect(existsSync(join(tempHome, ".mthds", "config"))).toBe(false);
      expect(getConfigValue("telemetry")).toEqual({ value: "1", source: "file" });
    });

    it("turns usage statistics back on, past a legacy opt-out", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(join(configDir, "usage-stats"), { recursive: true });
      writeFileSync(join(configDir, "config"), "DISABLE_TELEMETRY=1\n", "utf-8");
      writeFileSync(join(configDir, "usage-stats", "disabled"), "", "utf-8");
      const { setConfigValue, getConfigValue } = await importConfig();

      setConfigValue("telemetry", "true");
      expect(existsSync(join(configDir, "usage-stats", "disabled"))).toBe(false);
      expect(existsSync(join(configDir, "usage-stats", "legacy-migrated"))).toBe(true);
      expect(getConfigValue("telemetry")).toEqual({ value: "0", source: "default" });
      // The file is left as it was: the marker, not an edit, keeps the old opt-out from applying again.
      expect(readFileSync(join(configDir, "config"), "utf-8")).toBe("DISABLE_TELEMETRY=1\n");
    });

    it.each(["true", "1", "YES", " on "])("reads %j as on", async (value) => {
      const { isValidTelemetryValue } = await importConfig();
      expect(isValidTelemetryValue(value)).toBe(true);
    });

    it.each(["maybe", "", "2"])("refuses %j as a telemetry value", async (value) => {
      const { isValidTelemetryValue, setConfigValue } = await importConfig();
      expect(isValidTelemetryValue(value)).toBe(false);
      expect(() => setConfigValue("telemetry", value)).toThrow(/Invalid value for telemetry/);
    });

    // POSIX-only: mode bits are not meaningful on Windows.
    it.skipIf(process.platform === "win32")(
      "creates the config file with owner-only permissions (0600)",
      async () => {
        const { setConfigValue } = await importConfig();
        setConfigValue("apiKey", "secret-key");

        const mode = statSync(join(tempHome, ".mthds", "config")).mode & 0o777;
        expect(mode).toBe(0o600);
      },
    );

    it.skipIf(process.platform === "win32")(
      "tightens permissions on a pre-existing config file to 0600",
      async () => {
        const configDir = join(tempHome, ".mthds");
        mkdirSync(configDir, { recursive: true });
        const configPath = join(configDir, "config");
        writeFileSync(configPath, "MTHDS_API_KEY=existing-key\n", {
          encoding: "utf-8",
          mode: 0o644,
        });

        const { setConfigValue } = await importConfig();
        setConfigValue("runner", "pipelex");

        const mode = statSync(configPath).mode & 0o777;
        expect(mode).toBe(0o600);
      },
    );

    it("preserves existing values when setting a new one", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config"), "MTHDS_API_KEY=existing-key\n", "utf-8");

      const { setConfigValue } = await importConfig();
      setConfigValue("runner", "pipelex");

      const content = readFileSync(join(configDir, "config"), "utf-8");
      expect(content).toContain("MTHDS_API_KEY=existing-key");
      expect(content).toContain("MTHDS_RUNNER=pipelex");
    });
  });

  // ---------------------------------------------------------------------------
  // auto-upgrade and update-check boolean config keys
  // ---------------------------------------------------------------------------
  describe("autoUpgrade and updateCheck", () => {
    it("writes MTHDS_AUTO_UPGRADE=1 when setting auto-upgrade to true", async () => {
      const { setConfigValue } = await importConfig();
      setConfigValue("autoUpgrade", "true");

      const content = readFileSync(join(tempHome, ".mthds", "config"), "utf-8");
      expect(content).toContain("MTHDS_AUTO_UPGRADE=1");
    });

    it("writes MTHDS_UPDATE_CHECK=0 when setting update-check to false", async () => {
      const { setConfigValue } = await importConfig();
      setConfigValue("updateCheck", "false");

      const content = readFileSync(join(tempHome, ".mthds", "config"), "utf-8");
      expect(content).toContain("MTHDS_UPDATE_CHECK=0");
    });

    it("coerces yes/on/1/true all to true for autoUpgrade", async () => {
      for (const val of ["yes", "on", "1", "true"]) {
        const { setConfigValue, loadConfig } = await importConfig();
        setConfigValue("autoUpgrade", val);
        const config = loadConfig();
        expect(config.autoUpgrade).toBe(true);
      }
    });

    it("round-trips autoUpgrade: set true, reload, get true", async () => {
      const mod1 = await importConfig();
      mod1.setConfigValue("autoUpgrade", "true");

      const mod2 = await importConfig();
      const config = mod2.loadConfig();
      expect(config.autoUpgrade).toBe(true);
    });

    it("round-trips updateCheck: set false, reload, get false", async () => {
      const mod1 = await importConfig();
      mod1.setConfigValue("updateCheck", "false");

      const mod2 = await importConfig();
      const config = mod2.loadConfig();
      expect(config.updateCheck).toBe(false);
    });

    it("env var MTHDS_AUTO_UPGRADE=1 overrides file value", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config"), "MTHDS_AUTO_UPGRADE=0\n", "utf-8");
      vi.stubEnv("MTHDS_AUTO_UPGRADE", "1");

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.autoUpgrade).toBe(true);
    });

    it("getConfigValue returns raw file value for boolean keys", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config"), "MTHDS_AUTO_UPGRADE=1\n", "utf-8");

      const { getConfigValue } = await importConfig();
      const result = getConfigValue("autoUpgrade");
      expect(result.value).toBe("1");
      expect(result.source).toBe("file");
    });

    it("getConfigValue returns correct defaults for new boolean keys", async () => {
      const { getConfigValue } = await importConfig();

      const autoUpgrade = getConfigValue("autoUpgrade");
      expect(autoUpgrade.value).toBe("0");
      expect(autoUpgrade.source).toBe("default");

      const updateCheck = getConfigValue("updateCheck");
      expect(updateCheck.value).toBe("1");
      expect(updateCheck.source).toBe("default");
    });
  });

  // ---------------------------------------------------------------------------
  // Boolean coercion: env vars and file values with "true"/"yes"/"on"
  // ---------------------------------------------------------------------------
  describe("boolean coercion from env and file", () => {
    it("MTHDS_AUTO_UPGRADE=true via env returns autoUpgrade=true", async () => {
      vi.stubEnv("MTHDS_AUTO_UPGRADE", "true");
      const { loadConfig } = await importConfig();
      expect(loadConfig().autoUpgrade).toBe(true);
    });

    it("MTHDS_UPDATE_CHECK=yes via env returns updateCheck=true", async () => {
      vi.stubEnv("MTHDS_UPDATE_CHECK", "yes");
      const { loadConfig } = await importConfig();
      expect(loadConfig().updateCheck).toBe(true);
    });

    it.each(["true", "on", " 1 "])(
      "DISABLE_TELEMETRY=%j via env reports telemetry off from env",
      async (value) => {
        vi.stubEnv("DISABLE_TELEMETRY", value);
        const { getConfigValue } = await importConfig();
        expect(getConfigValue("telemetry")).toEqual({ value: "1", source: "env" });
      },
    );

    it("DISABLE_TELEMETRY=0 via env can no longer turn telemetry on over the machine's choice", async () => {
      mkdirSync(join(tempHome, ".mthds", "usage-stats"), { recursive: true });
      writeFileSync(join(tempHome, ".mthds", "usage-stats", "disabled"), "", "utf-8");
      vi.stubEnv("DISABLE_TELEMETRY", "0");
      const { getConfigValue } = await importConfig();
      expect(getConfigValue("telemetry")).toEqual({ value: "1", source: "file" });
    });

    it("MTHDS_AUTO_UPGRADE=false via env returns autoUpgrade=false", async () => {
      vi.stubEnv("MTHDS_AUTO_UPGRADE", "false");
      const { loadConfig } = await importConfig();
      expect(loadConfig().autoUpgrade).toBe(false);
    });

    it("file values 'true'/'yes'/'on' are coerced correctly", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "MTHDS_AUTO_UPGRADE=true\nMTHDS_UPDATE_CHECK=yes\nDISABLE_TELEMETRY=on\n",
        "utf-8",
      );
      const { loadConfig, getConfigValue } = await importConfig();
      const config = loadConfig();
      expect(config.autoUpgrade).toBe(true);
      expect(config.updateCheck).toBe(true);
      expect(getConfigValue("telemetry")).toEqual({ value: "1", source: "file" });
    });
  });

  // ---------------------------------------------------------------------------
  // The telemetry key and the environment
  // ---------------------------------------------------------------------------
  describe("telemetry key and the environment", () => {
    it.each(["1", "true", "yes", "TRUE", "anything"])(
      "DO_NOT_TRACK=%s reports telemetry off from env",
      async (value) => {
        vi.stubEnv("DO_NOT_TRACK", value);
        const { getConfigValue, getTelemetryDisablingEnvVar } = await importConfig();
        expect(getConfigValue("telemetry")).toEqual({ value: "1", source: "env" });
        expect(getTelemetryDisablingEnvVar()).toBe("DO_NOT_TRACK");
      },
    );

    it.each(["0", "false", "FALSE", "", " "])("DO_NOT_TRACK=%j has no effect", async (value) => {
      vi.stubEnv("DO_NOT_TRACK", value);
      const { getConfigValue, getTelemetryDisablingEnvVar } = await importConfig();
      expect(getConfigValue("telemetry")).toEqual({ value: "0", source: "default" });
      expect(getTelemetryDisablingEnvVar()).toBeUndefined();
    });

    it("a falsy DO_NOT_TRACK does not turn back on what the machine turned off", async () => {
      mkdirSync(join(tempHome, ".mthds", "usage-stats"), { recursive: true });
      writeFileSync(join(tempHome, ".mthds", "usage-stats", "disabled"), "", "utf-8");
      vi.stubEnv("DO_NOT_TRACK", "0");
      const { getConfigValue } = await importConfig();
      expect(getConfigValue("telemetry")).toEqual({ value: "1", source: "file" });
    });

    it("lists telemetry as off from the environment", async () => {
      vi.stubEnv("DO_NOT_TRACK", "1");
      const { listConfig } = await importConfig();
      const entry = listConfig().find((e) => e.cliKey === "telemetry");
      expect(entry).toMatchObject({ value: "1", source: "env" });
    });

    it("leaves every other key alone", async () => {
      vi.stubEnv("DO_NOT_TRACK", "1");
      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.updateCheck).toBe(true);
      expect(config.autoUpgrade).toBe(false);
    });

    it("names DO_NOT_TRACK first, even beside DISABLE_TELEMETRY", async () => {
      vi.stubEnv("DISABLE_TELEMETRY", "1");
      vi.stubEnv("DO_NOT_TRACK", "1");
      const { getTelemetryDisablingEnvVar } = await importConfig();
      expect(getTelemetryDisablingEnvVar()).toBe("DO_NOT_TRACK");
    });

    it("names a DISABLE_TELEMETRY that says off", async () => {
      vi.stubEnv("DISABLE_TELEMETRY", "on");
      const { getTelemetryDisablingEnvVar } = await importConfig();
      expect(getTelemetryDisablingEnvVar()).toBe("DISABLE_TELEMETRY");
    });

    it("names a PIPELEX_USAGE_STATS that says off", async () => {
      vi.stubEnv("PIPELEX_USAGE_STATS", "off");
      const { getTelemetryDisablingEnvVar } = await importConfig();
      expect(getTelemetryDisablingEnvVar()).toBe("PIPELEX_USAGE_STATS");
    });

    it("is undefined for DISABLE_TELEMETRY=0", async () => {
      vi.stubEnv("DISABLE_TELEMETRY", "0");
      const { getTelemetryDisablingEnvVar } = await importConfig();
      expect(getTelemetryDisablingEnvVar()).toBeUndefined();
    });

    it("is undefined when only the file holds telemetry off", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config"), "DISABLE_TELEMETRY=1\n", "utf-8");
      const { getTelemetryDisablingEnvVar, getConfigValue } = await importConfig();
      expect(getTelemetryDisablingEnvVar()).toBeUndefined();
      expect(getConfigValue("telemetry")).toEqual({ value: "1", source: "file" });
    });
  });
});
