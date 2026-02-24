import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to mock the paths used by the credentials module before importing it.
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
// because the module caches migration state.
async function importCredentials() {
  // Reset module registry so we get a fresh module with fresh `migrationDone = false`
  vi.resetModules();
  const mod = await import("../../../src/config/credentials.js");
  return mod;
}

describe("credentials", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "mthds-test-"));
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ---------------------------------------------------------------------------
  // loadCredentials
  // ---------------------------------------------------------------------------
  describe("loadCredentials", () => {
    it("returns defaults when no credentials file exists", async () => {
      const { loadCredentials } = await importCredentials();
      const creds = loadCredentials();
      expect(creds.runner).toBe("api");
      expect(creds.apiUrl).toBe("https://api.pipelex.com");
      expect(creds.apiKey).toBe("");
      expect(creds.telemetry).toBe(true);
    });

    it("reads values from credentials file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "credentials"),
        "MTHDS_RUNNER=pipelex\nPIPELEX_API_KEY=my-secret-key\n",
        "utf-8"
      );

      const { loadCredentials } = await importCredentials();
      const creds = loadCredentials();
      expect(creds.runner).toBe("pipelex");
      expect(creds.apiKey).toBe("my-secret-key");
      // apiUrl should still be the default
      expect(creds.apiUrl).toBe("https://api.pipelex.com");
    });

    it("env vars override file values", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "credentials"),
        "PIPELEX_API_KEY=file-key\nMTHDS_RUNNER=pipelex\n",
        "utf-8"
      );

      vi.stubEnv("PIPELEX_API_KEY", "env-key");
      vi.stubEnv("MTHDS_RUNNER", "api");

      const { loadCredentials } = await importCredentials();
      const creds = loadCredentials();
      expect(creds.apiKey).toBe("env-key");
      expect(creds.runner).toBe("api");
    });

    it("handles DISABLE_TELEMETRY correctly", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "credentials"),
        "DISABLE_TELEMETRY=1\n",
        "utf-8"
      );

      const { loadCredentials } = await importCredentials();
      const creds = loadCredentials();
      // DISABLE_TELEMETRY=1 means telemetry is OFF
      expect(creds.telemetry).toBe(false);
    });

    it("parses dotenv format correctly (ignores comments and blank lines)", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "credentials"),
        "# This is a comment\n\nPIPELEX_API_KEY=test-key\n\n# Another comment\nPIPELEX_API_URL=https://custom.api.com\n",
        "utf-8"
      );

      const { loadCredentials } = await importCredentials();
      const creds = loadCredentials();
      expect(creds.apiKey).toBe("test-key");
      expect(creds.apiUrl).toBe("https://custom.api.com");
    });
  });

  // ---------------------------------------------------------------------------
  // getCredentialValue
  // ---------------------------------------------------------------------------
  describe("getCredentialValue", () => {
    it("returns default source when no file or env", async () => {
      const { getCredentialValue } = await importCredentials();
      const result = getCredentialValue("apiUrl");
      expect(result.value).toBe("https://api.pipelex.com");
      expect(result.source).toBe("default");
    });

    it("returns file source when value is in credentials file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "credentials"),
        "PIPELEX_API_KEY=file-key\n",
        "utf-8"
      );

      const { getCredentialValue } = await importCredentials();
      const result = getCredentialValue("apiKey");
      expect(result.value).toBe("file-key");
      expect(result.source).toBe("file");
    });

    it("returns env source when env var is set", async () => {
      vi.stubEnv("PIPELEX_API_URL", "https://env.api.com");

      const { getCredentialValue } = await importCredentials();
      const result = getCredentialValue("apiUrl");
      expect(result.value).toBe("https://env.api.com");
      expect(result.source).toBe("env");
    });

    it("env takes precedence over file", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "credentials"),
        "PIPELEX_API_KEY=file-key\n",
        "utf-8"
      );
      vi.stubEnv("PIPELEX_API_KEY", "env-key");

      const { getCredentialValue } = await importCredentials();
      const result = getCredentialValue("apiKey");
      expect(result.value).toBe("env-key");
      expect(result.source).toBe("env");
    });
  });

  // ---------------------------------------------------------------------------
  // setCredentialValue
  // ---------------------------------------------------------------------------
  describe("setCredentialValue", () => {
    it("writes value to credentials file", async () => {
      const { setCredentialValue } = await importCredentials();
      setCredentialValue("apiKey", "new-key");

      const content = readFileSync(
        join(tempHome, ".mthds", "credentials"),
        "utf-8"
      );
      expect(content).toContain("PIPELEX_API_KEY=new-key");
    });

    it("creates config directory if it does not exist", async () => {
      const { setCredentialValue } = await importCredentials();
      setCredentialValue("runner", "pipelex");

      const content = readFileSync(
        join(tempHome, ".mthds", "credentials"),
        "utf-8"
      );
      expect(content).toContain("MTHDS_RUNNER=pipelex");
    });

    it("preserves existing values when setting a new one", async () => {
      const configDir = join(tempHome, ".mthds");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "credentials"),
        "PIPELEX_API_KEY=existing-key\n",
        "utf-8"
      );

      const { setCredentialValue } = await importCredentials();
      setCredentialValue("runner", "pipelex");

      const content = readFileSync(
        join(configDir, "credentials"),
        "utf-8"
      );
      expect(content).toContain("PIPELEX_API_KEY=existing-key");
      expect(content).toContain("MTHDS_RUNNER=pipelex");
    });
  });
});
