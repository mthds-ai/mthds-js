import { describe, it, expect } from "vitest";
import { isDomainCodeValid, isPipeCodeValid, isSnakeCase } from "../../../../src/package/manifest/validation.js";

describe("isDomainCodeValid", () => {
  it("accepts simple domain", () => {
    expect(isDomainCodeValid("legal")).toBe(true);
  });

  it("accepts dotted domain path", () => {
    expect(isDomainCodeValid("legal.contracts")).toBe(true);
  });

  it("accepts cross-package domain with valid alias", () => {
    expect(isDomainCodeValid("my_lib->scoring")).toBe(true);
    expect(isDomainCodeValid("dep->legal.contracts")).toBe(true);
  });

  it("rejects cross-package domain with invalid LHS alias", () => {
    expect(isDomainCodeValid("!!!->scoring")).toBe(false);
    expect(isDomainCodeValid("BAD->scoring")).toBe(false);
    expect(isDomainCodeValid("->scoring")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isDomainCodeValid("")).toBe(false);
  });

  it("rejects leading/trailing dots", () => {
    expect(isDomainCodeValid(".legal")).toBe(false);
    expect(isDomainCodeValid("legal.")).toBe(false);
    expect(isDomainCodeValid("legal..contracts")).toBe(false);
  });

  it("rejects non-snake_case segments", () => {
    expect(isDomainCodeValid("Legal")).toBe(false);
    expect(isDomainCodeValid("legal.BadName")).toBe(false);
  });
});

describe("isPipeCodeValid", () => {
  it("accepts snake_case", () => {
    expect(isPipeCodeValid("compute_score")).toBe(true);
    expect(isPipeCodeValid("run")).toBe(true);
  });

  it("rejects non-snake_case", () => {
    expect(isPipeCodeValid("BadName")).toBe(false);
    expect(isPipeCodeValid("")).toBe(false);
  });
});
