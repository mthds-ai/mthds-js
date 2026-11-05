import { describe, it, expect } from "vitest";
import {
  HIDDEN_MARK,
  maskSecret,
  maskUrlCredentials,
  shownConfigValue,
} from "../../../src/config/secrets.js";

// Dummies only: no test here holds a real key.
const DUMMY_KEY = "sk-test-dummy-0123456789abcdef";
const PIPELEX_SHAPED_KEY = `plx_sk_${"0123456789abcdef".repeat(4)}_1a2b3c4d`;

/** The characters of `masked` that are not the mark, which is every character it shows of the secret. */
function shownCharacters(masked: string): number {
  return Array.from(masked.replace(HIDDEN_MARK, "")).length;
}

describe("maskSecret", () => {
  it("shows an empty secret, a setting with no value, as the empty string", () => {
    expect(maskSecret("")).toBe("");
  });

  it("shows a secret shorter than sixteen characters as the mark alone", () => {
    for (const short of ["a", "short-dummy", "x".repeat(15)]) {
      expect(maskSecret(short)).toBe(HIDDEN_MARK);
    }
  });

  it("shows the first and last characters of a long secret around the mark", () => {
    expect(maskSecret(DUMMY_KEY)).toBe("sk-t…def");
    expect(maskSecret("0123456789abcdef")).toBe("01…ef");
  });

  it("shows a Pipelex key by the prefix the Pipelex app lists it by and its last four characters", () => {
    expect(maskSecret(PIPELEX_SHAPED_KEY)).toBe("plx_sk_01234…3c4d");
  });

  it("never shows more than a quarter of a secret, whatever its length", () => {
    for (let length = 1; length <= 200; length += 1) {
      const secret = "k".repeat(length);
      const masked = maskSecret(secret);
      expect(masked).toContain(HIDDEN_MARK);
      expect(shownCharacters(masked)).toBeLessThanOrEqual(Math.floor(length / 4));
    }
  });

  it("counts characters, never cutting one in two", () => {
    const masked = maskSecret("🔑".repeat(20));
    expect(masked).toBe("🔑🔑🔑…🔑🔑");
  });
});

describe("maskUrlCredentials", () => {
  const CREDENTIALS = "fakeuser:FAKEPASS123";

  // Every form the URL parser reads credentials from, or a person would write them in.
  const URLS_WITH_CREDENTIALS: ReadonlyArray<[string, string, string]> = [
    ["with its scheme", `https://${CREDENTIALS}@example.com`, "…@example.com"],
    ["without a scheme", `${CREDENTIALS}@example.com`, "…@example.com"],
    ["wrapped in whitespace", ` https://${CREDENTIALS}@example.com `, "…@example.com "],
    ["with no slashes after the scheme", `https:${CREDENTIALS}@example.com`, "…@example.com"],
    ["with backslashes after the scheme", `https:\\\\${CREDENTIALS}@example.com`, "…@example.com"],
    ["with a slash in the password", "https://fakeuser:pa/ss@example.com", "…@example.com"],
    ["with an at sign in the password", "https://fakeuser:pa@ss@example.com", "…@example.com"],
    ["as a token alone", "http://tok-dummy@localhost:8081", "…@localhost:8081"],
    ["with a path after the host", `https://${CREDENTIALS}@example.com/v1`, "…@example.com/v1"],
  ];

  it.each(URLS_WITH_CREDENTIALS)("hides the credentials of a URL %s", (_form, url, shown) => {
    expect(maskUrlCredentials(url)).toBe(shown);
  });

  it.each(URLS_WITH_CREDENTIALS)(
    "never shows what the URL parser reads as the credentials of a URL %s",
    (_form, url) => {
      const masked = maskUrlCredentials(url);
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        parsed = undefined;
      }
      for (const credential of [parsed?.username, parsed?.password]) {
        if (credential) expect(masked).not.toContain(decodeURIComponent(credential));
      }
      expect(masked).not.toContain("FAKEPASS123");
      expect(masked).not.toContain("fakeuser");
    },
  );

  it("hides everything before the last at sign, even one in a query", () => {
    expect(maskUrlCredentials("https://api.pipelex.com/v1?to=a@b")).toBe("…@b");
  });

  it("keeps a value holding no at sign as it is", () => {
    for (const url of ["https://api.pipelex.com", "http://localhost:8081", " not a url ", ""]) {
      expect(maskUrlCredentials(url)).toBe(url);
    }
  });
});

describe("shownConfigValue", () => {
  it("masks the API key and says so", () => {
    expect(shownConfigValue("apiKey", DUMMY_KEY)).toEqual({ value: "sk-t…def", masked: true });
    expect(shownConfigValue("apiKey", "short-dummy")).toEqual({ value: HIDDEN_MARK, masked: true });
  });

  it("shows an unset API key as empty, with nothing masked", () => {
    expect(shownConfigValue("apiKey", "")).toEqual({ value: "", masked: false });
  });

  it("hides a base URL's credentials, and keeps a base URL holding none", () => {
    expect(shownConfigValue("baseUrl", "https://user:pw-dummy@example.com")).toEqual({
      value: "…@example.com",
      masked: true,
    });
    expect(shownConfigValue("baseUrl", "https://api.pipelex.com")).toEqual({
      value: "https://api.pipelex.com",
      masked: false,
    });
  });

  it("shows every other setting as it is", () => {
    expect(shownConfigValue("runner", "api")).toEqual({ value: "api", masked: false });
    expect(shownConfigValue("telemetry", "1")).toEqual({ value: "1", masked: false });
  });
});
