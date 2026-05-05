/**
 * Shared binary metadata for passthrough, auto-install, and doctor commands.
 *
 * version_constraint is a semver range (e.g. ">=0.22.0") checked against the
 * output of `<binary> --version`.  Use buildInstallCommand() to get the
 * canonical install command — single source of truth.
 *
 * Each BINARY_RECOVERY entry spreads a shared `*_PKG` constant that holds
 * the per-PyPI-package metadata (constraint, install URL, etc.). To bump a
 * minimum version, edit the constant — never the per-binary entry — so that
 * binaries shipping from the same package can never drift.
 */

export interface BinaryRecoveryInfo {
  binary: string;
  package: string;
  /** PyPI package name for `uv tool install` (may differ from `package`). */
  uv_package: string;
  /** Semver range constraint, e.g. ">=0.22.0". */
  version_constraint: string;
  /** RegExp with one capture group that extracts the semver from `--version` output. */
  version_extract: RegExp;
  install_url: string;
  auto_installable: boolean;
}

/**
 * Build the canonical install/upgrade command string for a binary.
 */
export function buildInstallCommand(recovery: BinaryRecoveryInfo): string {
  return `uv tool install --upgrade "${recovery.uv_package}${recovery.version_constraint}"`;
}

/** Shared version-extract regex: `<name> <semver>` */
const VERSION_RE = /^[\w-]+\s+(\d+\.\d+\.\d+)/;

/** Shared metadata for the `pipelex` PyPI package — provides both `pipelex` and `pipelex-agent` binaries. */
const PIPELEX_PKG = {
  package: "pipelex",
  uv_package: "pipelex",
  version_constraint: ">=0.26.1",
  version_extract: VERSION_RE,
  install_url: "https://pypi.org/project/pipelex/",
  auto_installable: true,
} as const;

/** Shared metadata for the `pipelex-tools` PyPI package — provides the `plxt` binary. */
const PIPELEX_TOOLS_PKG = {
  package: "pipelex-tools",
  uv_package: "pipelex-tools",
  version_constraint: ">=0.3.3",
  version_extract: VERSION_RE,
  install_url: "https://pypi.org/project/pipelex-tools/",
  auto_installable: true,
} as const;

export const BINARY_RECOVERY: Record<string, BinaryRecoveryInfo> = {
  pipelex: { binary: "pipelex", ...PIPELEX_PKG },
  "pipelex-agent": { binary: "pipelex-agent", ...PIPELEX_PKG },
  plxt: { binary: "plxt", ...PIPELEX_TOOLS_PKG },
};
