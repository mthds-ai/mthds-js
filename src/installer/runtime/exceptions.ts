/**
 * The error installing a tool throws, with the reason it failed for, so that a command tells a
 * tool that is absent and cannot be installed apart from an install attempt that failed and may
 * succeed later. Its message is the sentence the `mthds` CLI prints.
 */

/**
 * Why a tool could not be installed:
 *
 * - `uv_missing`: `uv`, which every install goes through, is not on the PATH or cannot be started;
 * - `install_failed`: `uv tool install` ran and failed, for want of the network, of the package
 *   index or of a version satisfying the constraint, so a later attempt may succeed;
 * - `not_on_path`: the install succeeded, and the tool is still not on the PATH.
 */
export type ToolInstallFailureReason = "uv_missing" | "install_failed" | "not_on_path";

export class ToolInstallError extends Error {
  /** Why the tool could not be installed. */
  public readonly reason: ToolInstallFailureReason;
  /** The program at fault: `uv` on a `uv_missing` failure, else the tool being installed. */
  public readonly tool: string;

  constructor(
    message: string,
    reason: ToolInstallFailureReason,
    tool: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolInstallError";
    this.reason = reason;
    this.tool = tool;
  }
}
