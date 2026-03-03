/**
 * Shared binary metadata for passthrough, auto-install, and doctor commands.
 */

export interface BinaryRecoveryInfo {
  binary: string;
  package: string;
  install_command: string;
  install_url: string;
  auto_installable: boolean;
}

const PIPELEX_INSTALL_COMMAND = process.platform === "win32"
  ? 'powershell -Command "irm https://pipelex.com/install.ps1 | iex"'
  : "curl -fsSL https://pipelex.com/install.sh | sh";

export const BINARY_RECOVERY: Record<string, BinaryRecoveryInfo> = {
  pipelex: {
    binary: "pipelex",
    package: "pipelex",
    install_command: PIPELEX_INSTALL_COMMAND,
    install_url: "https://pipelex.com",
    auto_installable: true,
  },
  "pipelex-agent": {
    binary: "pipelex-agent",
    package: "pipelex",
    install_command: PIPELEX_INSTALL_COMMAND,
    install_url: "https://pipelex.com",
    auto_installable: true,
  },
  plxt: {
    binary: "plxt",
    package: "pipelex-tools",
    install_command: `${process.platform === "win32" ? "python" : "python3"} -m pip install pipelex-tools`,
    install_url: "https://pypi.org/project/pipelex-tools/",
    auto_installable: true,
  },
};
