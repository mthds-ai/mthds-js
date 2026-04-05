import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { checkBinaryVersion } from "../../../../src/installer/runtime/version-check.js";
import { BINARY_RECOVERY, type BinaryRecoveryInfo } from "../../../../src/agent/binaries.js";

const PX_CONSTRAINT = BINARY_RECOVERY["pipelex"].version_constraint;
const PLXT_CONSTRAINT = BINARY_RECOVERY["plxt"].version_constraint;

const mockedExecFileSync = vi.mocked(execFileSync);

const VERSION_RE = /^[\w-]+\s+(\d+\.\d+\.\d+)/;

function makeRecovery(overrides?: Partial<BinaryRecoveryInfo>): BinaryRecoveryInfo {
  return {
    binary: "pipelex",
    package: "pipelex",
    uv_package: "pipelex",
    version_constraint: PX_CONSTRAINT,
    version_extract: VERSION_RE,
    install_url: "https://pipelex.com",
    auto_installable: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkBinaryVersion", () => {
  it("returns 'missing' when binary is not found (ENOENT)", () => {
    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedExecFileSync.mockImplementation(() => { throw err; });

    const result = checkBinaryVersion(makeRecovery());

    expect(result.status).toBe("missing");
    expect(result.installed_version).toBeNull();
    expect(result.version_constraint).toBe(PX_CONSTRAINT);
  });

  it("returns 'unparseable' when binary exists but crashes (non-ENOENT error)", () => {
    const err = new Error("Command failed") as NodeJS.ErrnoException;
    err.code = "EACCES";
    mockedExecFileSync.mockImplementation(() => { throw err; });

    const result = checkBinaryVersion(makeRecovery());

    expect(result.status).toBe("unparseable");
    expect(result.installed_version).toBeNull();
  });

  it("returns 'ok' when version satisfies constraint", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("pipelex 99.0.0"));

    const result = checkBinaryVersion(makeRecovery());

    expect(result.status).toBe("ok");
    expect(result.installed_version).toBe("99.0.0");
  });

  it("returns 'ok' when version exceeds constraint", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("pipelex 1.0.0"));

    const result = checkBinaryVersion(makeRecovery());

    expect(result.status).toBe("ok");
    expect(result.installed_version).toBe("1.0.0");
  });

  it("returns 'outdated' when version is below constraint", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("pipelex 0.20.0"));

    const result = checkBinaryVersion(makeRecovery());

    expect(result.status).toBe("outdated");
    expect(result.installed_version).toBe("0.20.0");
  });

  it("returns 'unparseable' when output doesn't match regex", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("something unexpected"));

    const result = checkBinaryVersion(
      makeRecovery({ version_extract: /^pipelex\s+(\d+\.\d+\.\d+)/ })
    );

    expect(result.status).toBe("unparseable");
    expect(result.installed_version).toBeNull();
  });

  it("returns 'unparseable' when regex matches but semver.coerce fails", () => {
    // Regex captures non-semver string
    mockedExecFileSync.mockReturnValue(Buffer.from("pipelex abc.def.ghi"));
    const weirdRegex = /^pipelex\s+(.+)/;

    const result = checkBinaryVersion(makeRecovery({ version_extract: weirdRegex }));

    // semver.coerce("abc.def.ghi") returns null
    expect(result.status).toBe("unparseable");
  });

  it("handles pipelex-agent version format", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("pipelex-agent 99.0.0"));

    const result = checkBinaryVersion(
      makeRecovery({ binary: "pipelex-agent" })
    );

    expect(result.status).toBe("ok");
    expect(result.installed_version).toBe("99.0.0");
  });

  it("handles plxt version format", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("plxt 0.3.2"));

    const result = checkBinaryVersion(
      makeRecovery({
        binary: "plxt",
        uv_package: "pipelex-tools",
        version_constraint: PLXT_CONSTRAINT,
      })
    );

    expect(result.status).toBe("ok");
    expect(result.installed_version).toBe("0.3.2");
  });

  it("handles version with trailing whitespace/newlines", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("pipelex 99.0.0\n"));

    const result = checkBinaryVersion(makeRecovery());

    expect(result.status).toBe("ok");
    expect(result.installed_version).toBe("99.0.0");
  });
});
