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

export const BINARY_RECOVERY: Record<string, BinaryRecoveryInfo> = {
  "pipelex-agent": {
    binary: "pipelex-agent",
    package: "pipelex",
    install_command: "curl -fsSL https://pipelex.com/install.sh | sh",
    install_url: "https://pipelex.com",
    auto_installable: true,
  },
  plxt: {
    binary: "plxt",
    package: "pipelex-tools",
    install_command: "pip install pipelex-tools",
    install_url: "https://pypi.org/project/pipelex-tools/",
    auto_installable: true,
  },
};
