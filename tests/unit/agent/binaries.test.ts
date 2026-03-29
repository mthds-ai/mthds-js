import { describe, it, expect } from "vitest";

import {
  buildInstallCommand,
  BINARY_RECOVERY,
  type BinaryRecoveryInfo,
} from "../../../src/agent/binaries.js";

describe("buildInstallCommand", () => {
  it("produces correct uv tool install command from recovery info", () => {
    const plxt = BINARY_RECOVERY["plxt"];
    const cmd = buildInstallCommand(plxt);
    expect(cmd).toBe('uv tool install --upgrade "pipelex-tools>=0.3.2"');
  });

  it("includes uv_package and version_constraint in the command", () => {
    const pipelex = BINARY_RECOVERY["pipelex"];
    const cmd = buildInstallCommand(pipelex);
    expect(cmd).toContain(pipelex.uv_package);
    expect(cmd).toContain(pipelex.version_constraint);
    expect(cmd).toBe('uv tool install --upgrade "pipelex>=0.22.0"');
  });
});

describe("BINARY_RECOVERY registry", () => {
  const requiredFields: (keyof BinaryRecoveryInfo)[] = [
    "binary",
    "package",
    "uv_package",
    "version_constraint",
    "version_extract",
    "install_url",
    "auto_installable",
  ];

  it.each(Object.keys(BINARY_RECOVERY))(
    "%s has all required fields",
    (key) => {
      const entry = BINARY_RECOVERY[key];
      for (const field of requiredFields) {
        expect(entry, `${key} missing field '${field}'`).toHaveProperty(field);
      }
    },
  );

  it.each(Object.entries(BINARY_RECOVERY))(
    "%s version_extract matches '<binary> X.Y.Z' output",
    (_key, entry) => {
      const fakeOutput = `${entry.binary} 1.23.456`;
      const match = entry.version_extract.exec(fakeOutput);
      expect(match, `regex failed on "${fakeOutput}"`).not.toBeNull();
      expect(match![1]).toBe("1.23.456");
    },
  );

  it("install_command is not a static field on any entry", () => {
    for (const [key, entry] of Object.entries(BINARY_RECOVERY)) {
      expect(
        entry,
        `${key} should not have a static install_command — use buildInstallCommand()`,
      ).not.toHaveProperty("install_command");
    }
  });
});
