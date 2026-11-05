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
  it("hides a URL's user name and password", () => {
    expect(maskUrlCredentials("https://user:hunter2-dummy@example.com")).toBe(
      "https://…@example.com",
    );
  });

  it("hides a token written as the user name", () => {
    expect(maskUrlCredentials("http://tok-dummy@localhost:8081")).toBe("http://…@localhost:8081");
  });

  it("hides a password holding a slash, up to the last at sign", () => {
    const shown = maskUrlCredentials("https://user:pa/ss-dummy@example.com");
    expect(shown).toBe("https://…@example.com");
    expect(shown).not.toContain("ss-dummy");
  });

  it("keeps a URL holding no credentials as it is", () => {
    for (const url of [
      "https://api.pipelex.com",
      "http://localhost:8081",
      "https://api.pipelex.com/v1?to=a@b",
      "not a url",
    ]) {
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
      value: "https://…@example.com",
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
