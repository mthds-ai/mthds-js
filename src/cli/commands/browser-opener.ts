import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The command that opens a URL in the user's browser on a platform, the URL its one argument. */
export function browserOpenerCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      // `explorer.exe` takes the URL whole, where `cmd /c start` would read each `&` between the
      // URL's parameters as a command separator, cutting the URL there and running the rest.
      return { command: "explorer.exe", args: [url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/** The slice of a promisified `execFile` the opener uses. */
export type ExecFileFunction = (command: string, args: readonly string[]) => Promise<unknown>;

/**
 * Open a URL in the user's browser with the platform's own opener, never through a shell.
 *
 * `explorer.exe` exits 1 when it opened the URL, so on Windows an exit code says nothing and only
 * a failure to start the opener counts; elsewhere a non-zero exit is a failure too.
 *
 * @throws The opener's failure, for the caller to show the URL instead.
 */
export async function openInBrowser(
  url: string,
  options: { platform?: NodeJS.Platform; execFile?: ExecFileFunction } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const run = options.execFile ?? execFileAsync;
  const { command, args } = browserOpenerCommand(url, platform);
  try {
    await run(command, args);
  } catch (err) {
    const exited = typeof (err as { code?: unknown } | null)?.code === "number";
    if (platform === "win32" && exited) return;
    throw err;
  }
}
