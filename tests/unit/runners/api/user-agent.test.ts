import { describe, expect, it } from "vitest";
import {
  buildUserAgent,
  detectRuntime,
  renderAppInfo,
  validateAppInfo,
  USER_AGENT_MAX_LENGTH,
} from "../../../../src/runners/api/user-agent.js";
import type { AppInfo, RuntimeInfo } from "../../../../src/runners/api/user-agent.js";
import { MTHDS_JS_VERSION } from "../../../../src/version.js";

const NODE: RuntimeInfo = {
  name: "node",
  version: "22.4.0",
  os: "darwin",
  arch: "arm64",
  isBrowser: false,
};

describe("renderAppInfo", () => {
  it("renders the name alone", () => {
    expect(renderAppInfo({ name: "acme-invoicer" })).toBe("acme-invoicer");
  });

  it("renders name/version", () => {
    expect(renderAppInfo({ name: "acme-invoicer", version: "1.4.0" })).toBe("acme-invoicer/1.4.0");
  });

  it("renders details before +url in the comment", () => {
    expect(
      renderAppInfo({
        name: "pipelex-mcp",
        version: "0.17.0",
        details: ["workshop", "host=claude-code/2.1.4"],
        url: "https://pipelex.com",
      }),
    ).toBe("pipelex-mcp/0.17.0 (workshop; host=claude-code/2.1.4; +https://pipelex.com)");
  });

  it("renders a url-only comment", () => {
    expect(renderAppInfo({ name: "acme", url: "https://acme.test/bot" })).toBe(
      "acme (+https://acme.test/bot)",
    );
  });

  it("drops an empty details list", () => {
    expect(renderAppInfo({ name: "acme", version: "1", details: [] })).toBe("acme/1");
  });
});

describe("validateAppInfo", () => {
  it.each<AppInfo>([
    { name: "acme-invoicer" },
    { name: "acme", version: "0.2.16-rc.01" },
    { name: "acme", details: ["console", "host=openai", "host=claude-code/2.1.4"] },
    { name: "acme", url: "https://acme.test/path?q=1" },
    { name: "acme", url: "acme.test/about" },
    { name: "acme", version: "" },
    { name: "acme", url: "" },
    { name: "acme", details: [] },
  ])("accepts %j", (appInfo) => {
    expect(() => validateAppInfo(appInfo)).not.toThrow();
  });

  it.each<[string, unknown]>([
    ["empty name", { name: "" }],
    ["name with a space", { name: "acme invoicer" }],
    ["name with a slash", { name: "acme/1.0" }],
    ["non-string name", { name: 42 }],
    ["missing name", {}],
    ["non-object", "acme"],
    ["null", null],
    ["version with a space", { name: "acme", version: "1.0 beta" }],
    ["version with parentheses", { name: "acme", version: "1.0(x)" }],
    ["detail with a space", { name: "acme", details: ["a b"] }],
    ["detail with a semicolon", { name: "acme", details: ["a;b"] }],
    ["detail with an empty key", { name: "acme", details: ["=x"] }],
    ["detail with an empty value", { name: "acme", details: ["host="] }],
    ["detail value with two slashes", { name: "acme", details: ["host=a/b/c"] }],
    ["non-string detail", { name: "acme", details: [1] }],
    ["details not an array", { name: "acme", details: "workshop" }],
    ["url with a space", { name: "acme", url: "https://acme.test/a b" }],
    ["url with a parenthesis", { name: "acme", url: "https://acme.test/(x)" }],
    ["url with a semicolon", { name: "acme", url: "https://acme.test/a;b" }],
    ["url with a backslash", { name: "acme", url: "https://acme.test/a\\b" }],
    ["url with a tab", { name: "acme", url: "https://acme.test/a\tb" }],
    ["url with non-ASCII", { name: "acme", url: "https://\u{1F600}.test" }],
    ["non-string url", { name: "acme", url: 42 }],
  ])("refuses %s with a TypeError", (_label, appInfo) => {
    expect(() => validateAppInfo(appInfo as AppInfo)).toThrow(TypeError);
  });

  it("names the offending field in the message", () => {
    expect(() => validateAppInfo({ name: "acme invoicer" })).toThrow(/appInfo\.name/);
    expect(() => validateAppInfo({ name: "a", version: "1 0" })).toThrow(/appInfo\.version/);
    expect(() => validateAppInfo({ name: "a", details: ["x y"] })).toThrow(/appInfo\.details/);
    expect(() => validateAppInfo({ name: "a", url: "a b" })).toThrow(/appInfo\.url/);
  });
});

describe("detectRuntime", () => {
  it("reads node from process.versions", () => {
    expect(
      detectRuntime({ process: { versions: { node: "22.4.0" }, platform: "linux", arch: "x64" } }),
    ).toEqual({
      name: "node",
      version: "22.4.0",
      os: "linux",
      arch: "x64",
      isBrowser: false,
    });
  });

  it("prefers bun over its node-compat version", () => {
    expect(
      detectRuntime({
        process: { versions: { node: "22.6.0", bun: "1.2.3" }, platform: "darwin", arch: "arm64" },
      }),
    ).toMatchObject({ name: "bun", version: "1.2.3", os: "darwin", arch: "arm64" });
  });

  it("reads deno from Deno.version and Deno.build, ahead of its process shim", () => {
    expect(
      detectRuntime({
        Deno: { version: { deno: "2.1.0" }, build: { os: "linux", arch: "x86_64" } },
        process: { versions: { node: "22.0.0" }, platform: "linux", arch: "x64" },
      }),
    ).toMatchObject({
      name: "deno",
      version: "2.1.0",
      os: "linux",
      arch: "x86_64",
      isBrowser: false,
    });
  });

  it("flags a browser (window with a document)", () => {
    expect(detectRuntime({ window: { document: {} } })).toEqual({ isBrowser: true });
  });

  it("flags a web worker", () => {
    expect(detectRuntime({ importScripts: () => undefined })).toEqual({ isBrowser: true });
  });

  it("flags a browser that also exposes process.versions.node (Electron renderer)", () => {
    expect(
      detectRuntime({
        window: { document: {} },
        process: { versions: { node: "22.4.0" }, platform: "darwin", arch: "arm64" },
      }),
    ).toEqual({ isBrowser: true });
  });

  it("reports an unknown server runtime as not a browser, with no version", () => {
    expect(detectRuntime({})).toEqual({ isBrowser: false });
  });

  it("detects the real runtime the suite runs on", () => {
    expect(detectRuntime()).toMatchObject({
      name: "node",
      version: process.versions.node,
      isBrowser: false,
    });
  });
});

describe("buildUserAgent", () => {
  it("builds the library-only header", () => {
    expect(buildUserAgent(undefined, NODE, "0.27.0")).toBe(
      "mthds-js/0.27.0 node/22.4.0 (darwin; arm64)",
    );
  });

  it("places appInfo first, outermost", () => {
    expect(buildUserAgent({ name: "mthds-cli", version: "0.27.0" }, NODE, "0.27.0")).toBe(
      "mthds-cli/0.27.0 mthds-js/0.27.0 node/22.4.0 (darwin; arm64)",
    );
  });

  it("defaults to this package's version and the real runtime", () => {
    expect(buildUserAgent()).toBe(
      `mthds-js/${MTHDS_JS_VERSION} node/${process.versions.node} (${process.platform}; ${process.arch})`,
    );
  });

  it("returns undefined in a browser, even with appInfo", () => {
    expect(buildUserAgent({ name: "acme" }, { isBrowser: true })).toBeUndefined();
  });

  it("still validates appInfo in a browser", () => {
    expect(() => buildUserAgent({ name: "bad name" }, { isBrowser: true })).toThrow(TypeError);
  });

  it("refuses an over-long appInfo in a browser as it does on a server", () => {
    const details = Array.from({ length: 80 }, (_, i) => `k${i}=value${i}`);
    expect(() => buildUserAgent({ name: "acme", details }, { isBrowser: true })).toThrow(
      RangeError,
    );
  });

  it("omits the runtime token when its version cannot be read", () => {
    expect(buildUserAgent(undefined, { isBrowser: false }, "1.0.0")).toBe("mthds-js/1.0.0");
  });

  it("treats an empty version, url and details as absent", () => {
    expect(
      buildUserAgent(
        { name: "acme", version: "", url: "", details: [] },
        { isBrowser: false },
        "1.0.0",
      ),
    ).toBe("acme mthds-js/1.0.0");
  });

  it("keeps the runtime token but drops the os comment when os/arch are unknown", () => {
    expect(
      buildUserAgent(undefined, { name: "node", version: "22.4.0", isBrowser: false }, "1.0.0"),
    ).toBe("mthds-js/1.0.0 node/22.4.0");
  });

  it("refuses a header over the length limit with a RangeError", () => {
    const details = Array.from({ length: 100 }, (_, i) => `detail${i}=value${i}`);
    expect(() => buildUserAgent({ name: "acme", details }, NODE)).toThrow(RangeError);
    expect(USER_AGENT_MAX_LENGTH).toBe(512);
  });
});
