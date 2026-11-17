import { describe, it, expect, vi } from "vitest";
import { browserOpenerCommand, openInBrowser } from "../../../src/cli/commands/browser-opener.js";
import { buildShareUrls } from "../../../src/cli/commands/share.js";

/** A share URL carrying literal `&` between its parameters, which `cmd /c start` would split. */
const REDDIT_URL = buildShareUrls({
  methods: [{ displayName: "Contract Analysis", description: "Analyze legal contracts" }],
  address: "mthds-ai/contract-analysis",
}).reddit;

/** An `execFile` failure as Node raises it: `code` is the exit code, or the system's error name. */
function execFailure(code: number | string): Error & { code: number | string } {
  return Object.assign(new Error("Command failed"), { code });
}

describe("browserOpenerCommand", () => {
  it("opens a URL on Windows with explorer.exe, the URL whole as its one argument", () => {
    expect(REDDIT_URL).toContain("&");
    const { command, args } = browserOpenerCommand(REDDIT_URL, "win32");
    expect(command).toBe("explorer.exe");
    expect(args).toEqual([REDDIT_URL]);
  });

  it("never goes through cmd on Windows, which reads each & as a command separator", () => {
    const { command, args } = browserOpenerCommand(REDDIT_URL, "win32");
    expect(command.toLowerCase()).not.toMatch(/^cmd(\.exe)?$/);
    expect(args).not.toContain("/c");
    expect(args).not.toContain("start");
  });

  it("opens a URL with open on macOS and xdg-open elsewhere", () => {
    expect(browserOpenerCommand(REDDIT_URL, "darwin")).toEqual({
      command: "open",
      args: [REDDIT_URL],
    });
    expect(browserOpenerCommand(REDDIT_URL, "linux")).toEqual({
      command: "xdg-open",
      args: [REDDIT_URL],
    });
  });
});

describe("openInBrowser", () => {
  it("hands the platform's opener the URL as one argument", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await openInBrowser(REDDIT_URL, { platform: "win32", execFile });
    expect(execFile).toHaveBeenCalledWith("explorer.exe", [REDDIT_URL]);
  });

  it("counts explorer.exe exiting 1 as opened, since it exits 1 when it succeeds", async () => {
    const execFile = vi.fn().mockRejectedValue(execFailure(1));
    await expect(openInBrowser(REDDIT_URL, { platform: "win32", execFile })).resolves.toBe(
      undefined,
    );
  });

  it("fails on Windows when explorer.exe cannot be started", async () => {
    const execFile = vi.fn().mockRejectedValue(execFailure("ENOENT"));
    await expect(openInBrowser(REDDIT_URL, { platform: "win32", execFile })).rejects.toThrow(
      "Command failed",
    );
  });

  it("fails elsewhere when the opener exits non-zero", async () => {
    const execFile = vi.fn().mockRejectedValue(execFailure(3));
    await expect(openInBrowser(REDDIT_URL, { platform: "linux", execFile })).rejects.toThrow(
      "Command failed",
    );
  });
});
