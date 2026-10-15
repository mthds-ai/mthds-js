import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Whether a repository is public, as GitHub answers it, before a local publish sends its name to
// mthds.sh. GitHub is a stub here: `gh` is absent and `fetch` answers what the test gives it.

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => {
    throw new Error("gh: not found");
  }),
}));

import { repositoryVisibility } from "../../../../src/installer/resolver/github.js";

const fetchStub = vi.fn();

function answer(status: number, body: unknown): void {
  fetchStub.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  fetchStub.mockReset();
  vi.stubGlobal("fetch", fetchStub);
  vi.stubEnv("GITHUB_TOKEN", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("repositoryVisibility", () => {
  it("asks GitHub for the repository and reads a public one", async () => {
    answer(200, { private: false });
    expect(await repositoryVisibility("acme", "tools")).toBe("public");
    expect(String(fetchStub.mock.calls[0]![0])).toBe("https://api.github.com/repos/acme/tools");
  });

  it("reads a private one", async () => {
    answer(200, { private: true });
    expect(await repositoryVisibility("acme", "tools")).toBe("private");
  });

  it("counts an answer that does not say the repository is public as private", async () => {
    answer(200, {});
    expect(await repositoryVisibility("acme", "tools")).toBe("private");
  });

  it("reads a repository GitHub does not show as not found", async () => {
    answer(404, { message: "Not Found" });
    expect(await repositoryVisibility("acme", "tools")).toBe("not_found");
  });

  it("throws when GitHub cannot answer", async () => {
    answer(500, { message: "Server Error" });
    await expect(repositoryVisibility("acme", "tools")).rejects.toThrow(/GitHub API error 500/);
  });
});
