import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
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
      expect(config.runnerUrl).toBe("https://api.pipelex.com/runner/v1");
      expect(config.platformUrl).toBe("https://api.pipelex.com/platform/v1");
      expect(config.apiKey).toBe("");
      expect(config.telemetry).toBe(true);
      expect(config.autoUpgrade).toBe(false);
      expect(config.updateCheck).toBe(true);
    });

    it("reads values from config file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "MTHDS_RUNNER=api\nPIPELEX_API_KEY=my-secret-key\n",
        "utf-8"
      );

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.runner).toBe("api");
      expect(config.apiKey).toBe("my-secret-key");
      // runnerUrl should still be the default
      expect(config.runnerUrl).toBe("https://api.pipelex.com/runner/v1");
    });

    it("env vars override file values", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "PIPELEX_API_KEY=file-key\nMTHDS_RUNNER=pipelex\n",
        "utf-8"
      );

      vi.stubEnv("PIPELEX_API_KEY", "env-key");
      vi.stubEnv("MTHDS_RUNNER", "api");

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.apiKey).toBe("env-key");
      expect(config.runner).toBe("api");
    });

    it("handles DISABLE_TELEMETRY correctly", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "DISABLE_TELEMETRY=1\n",
        "utf-8"
      );

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      // DISABLE_TELEMETRY=1 means telemetry is OFF
      expect(config.telemetry).toBe(false);
    });

    it("parses dotenv format correctly (ignores comments and blank lines)", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "# This is a comment\n\nPIPELEX_API_KEY=test-key\n\n# Another comment\nPIPELEX_RUNNER_URL=https://custom.api.com/api/v1\n",
        "utf-8"
      );

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.apiKey).toBe("test-key");
      expect(config.runnerUrl).toBe("https://custom.api.com/api/v1");
    });

    it("reads runnerUrl and platformUrl from the config file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "PIPELEX_RUNNER_URL=http://localhost:8081/api/v1\nPIPELEX_PLATFORM_URL=http://localhost:9000/platform/v1\n",
        "utf-8"
      );

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.runnerUrl).toBe("http://localhost:8081/api/v1");
      expect(config.platformUrl).toBe("http://localhost:9000/platform/v1");
    });

    it("env overrides PIPELEX_RUNNER_URL and PIPELEX_PLATFORM_URL", async () => {
      vi.stubEnv("PIPELEX_RUNNER_URL", "http://env-runner/api/v1");
      vi.stubEnv("PIPELEX_PLATFORM_URL", "http://env-platform/platform/v1");

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.runnerUrl).toBe("http://env-runner/api/v1");
      expect(config.platformUrl).toBe("http://env-platform/platform/v1");
    });

    it("platform follows runner: self-hosted runnerUrl (no explicit platform) disables the platform", async () => {
      // Pointing the runner at a self-hosted URL without setting a platform URL
      // must NOT leave the hosted platform default in place — otherwise `run pipe`
      // would poll api.pipelex.com for a run that executed on the local runner.
      vi.stubEnv("PIPELEX_RUNNER_URL", "http://localhost:8081/api/v1");

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.runnerUrl).toBe("http://localhost:8081/api/v1");
      expect(config.platformUrl).toBe("");
    });

    it("platform follows runner: default runnerUrl keeps the hosted platform default", async () => {
      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.runnerUrl).toBe("https://api.pipelex.com/runner/v1");
      expect(config.platformUrl).toBe("https://api.pipelex.com/platform/v1");
    });

    it("platform follows runner: an explicit platformUrl is respected even with a self-hosted runner", async () => {
      vi.stubEnv("PIPELEX_RUNNER_URL", "http://localhost:8081/api/v1");
      vi.stubEnv("PIPELEX_PLATFORM_URL", "http://localhost:9000/platform/v1");

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.platformUrl).toBe("http://localhost:9000/platform/v1");
    });

    it("does NOT throw on a legacy PIPELEX_API_URL — loadConfig is migration-agnostic", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "MTHDS_RUNNER=pipelex\nPIPELEX_API_URL=https://legacy.example.com\n",
        "utf-8"
      );

      const { loadConfig } = await importConfig();
      // Pure pipelex-runner flow must be unaffected by a leftover legacy apiUrl.
      expect(() => loadConfig().runner).not.toThrow();
      expect(loadConfig().runner).toBe("pipelex");
    });

    it("detects a legacy apiUrl from file and env via hasLegacyApiUrl", async () => {
      const { hasLegacyApiUrl } = await importConfig();
      expect(hasLegacyApiUrl()).toBe(false);

      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "PIPELEX_API_URL=https://legacy.example.com\n",
        "utf-8"
      );
      const mod2 = await importConfig();
      expect(mod2.hasLegacyApiUrl()).toBe(true);

      vi.stubEnv("PIPELEX_API_URL", "https://legacy-env.example.com");
      const mod3 = await importConfig();
      expect(mod3.hasLegacyApiUrl()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getConfigValue
  // ---------------------------------------------------------------------------
  describe("getConfigValue", () => {
    it("returns default source when no file or env", async () => {
      const { getConfigValue } = await importConfig();
      const result = getConfigValue("runnerUrl");
      expect(result.value).toBe("https://api.pipelex.com/runner/v1");
      expect(result.source).toBe("default");
    });

    it("returns file source when value is in config file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "PIPELEX_API_KEY=file-key\n",
        "utf-8"
      );

      const { getConfigValue } = await importConfig();
      const result = getConfigValue("apiKey");
      expect(result.value).toBe("file-key");
      expect(result.source).toBe("file");
    });

    it("returns env source when env var is set", async () => {
      vi.stubEnv("PIPELEX_RUNNER_URL", "https://env.api.com/api/v1");

      const { getConfigValue } = await importConfig();
      const result = getConfigValue("runnerUrl");
      expect(result.value).toBe("https://env.api.com/api/v1");
      expect(result.source).toBe("env");
    });

    it("env takes precedence over file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "PIPELEX_API_KEY=file-key\n",
        "utf-8"
      );
      vi.stubEnv("PIPELEX_API_KEY", "env-key");

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

      const content = readFileSync(
        join(tempHome, ".mthds", "config"),
        "utf-8"
      );
      expect(content).toContain("PIPELEX_API_KEY=new-key");
    });

    it("creates config directory if it does not exist", async () => {
      const { setConfigValue } = await importConfig();
      setConfigValue("runner", "pipelex");

      const content = readFileSync(
        join(tempHome, ".mthds", "config"),
        "utf-8"
      );
      expect(content).toContain("MTHDS_RUNNER=pipelex");
    });

    it("coerces telemetry values correctly when using config set", async () => {
      const { setConfigValue, loadConfig } = await importConfig();

      // "false" should disable telemetry (write DISABLE_TELEMETRY=1)
      setConfigValue("telemetry", "false");
      const content1 = readFileSync(
        join(tempHome, ".mthds", "config"),
        "utf-8"
      );
      expect(content1).toContain("DISABLE_TELEMETRY=1");

      // Re-import to clear cache and verify round-trip
      const mod2 = await importConfig();
      expect(mod2.loadConfig().telemetry).toBe(false);
    });

    it("coerces 'true' telemetry value to DISABLE_TELEMETRY=0", async () => {
      const { setConfigValue } = await importConfig();
      setConfigValue("telemetry", "true");

      const content = readFileSync(
        join(tempHome, ".mthds", "config"),
        "utf-8"
      );
      expect(content).toContain("DISABLE_TELEMETRY=0");
    });

    it("preserves existing values when setting a new one", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "PIPELEX_API_KEY=existing-key\n",
        "utf-8"
      );

      const { setConfigValue } = await importConfig();
      setConfigValue("runner", "pipelex");

      const content = readFileSync(
        join(configDir, "config"),
        "utf-8"
      );
      expect(content).toContain("PIPELEX_API_KEY=existing-key");
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

      const content = readFileSync(
        join(tempHome, ".mthds", "config"),
        "utf-8"
      );
      expect(content).toContain("MTHDS_AUTO_UPGRADE=1");
    });

    it("writes MTHDS_UPDATE_CHECK=0 when setting update-check to false", async () => {
      const { setConfigValue } = await importConfig();
      setConfigValue("updateCheck", "false");

      const content = readFileSync(
        join(tempHome, ".mthds", "config"),
        "utf-8"
      );
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
      writeFileSync(
        join(configDir, "config"),
        "MTHDS_AUTO_UPGRADE=0\n",
        "utf-8"
      );
      vi.stubEnv("MTHDS_AUTO_UPGRADE", "1");

      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.autoUpgrade).toBe(true);
    });

    it("getConfigValue returns raw file value for boolean keys", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config"),
        "MTHDS_AUTO_UPGRADE=1\n",
        "utf-8"
      );

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

    it("DISABLE_TELEMETRY=true via env returns telemetry=false", async () => {
      vi.stubEnv("DISABLE_TELEMETRY", "true");
      const { loadConfig } = await importConfig();
      expect(loadConfig().telemetry).toBe(false);
    });

    it("DISABLE_TELEMETRY=on via env returns telemetry=false", async () => {
      vi.stubEnv("DISABLE_TELEMETRY", "on");
      const { loadConfig } = await importConfig();
      expect(loadConfig().telemetry).toBe(false);
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
        "utf-8"
      );
      const { loadConfig } = await importConfig();
      const config = loadConfig();
      expect(config.autoUpgrade).toBe(true);
      expect(config.updateCheck).toBe(true);
      expect(config.telemetry).toBe(false);
    });
  });
});
