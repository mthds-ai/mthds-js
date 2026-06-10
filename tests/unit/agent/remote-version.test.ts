import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchLatestMthdsAgentNpm,
  fetchLatestPluginMarketplace,
} from "../../../src/agent/remote-version.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

describe("remote-version", () => {
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  // ── fetchLatestMthdsAgentNpm ──────────────────────────────────────
  describe("fetchLatestMthdsAgentNpm", () => {
    it("returns the version string on happy path", async () => {
      fetchSpy!.mockResolvedValueOnce(makeResponse({ version: "0.8.1" }));
      const v = await fetchLatestMthdsAgentNpm();
      expect(v).toBe("0.8.1");
      // Sanity: the registry URL is what we expect, and a 2s timeout is wired.
      const [url, init] = fetchSpy!.mock.calls[0]!;
      expect(url).toBe("https://registry.npmjs.org/mthds/latest");
      expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    });

    it("returns null on non-2xx", async () => {
      fetchSpy!.mockResolvedValueOnce(makeResponse({}, { ok: false, status: 404 }));
      expect(await fetchLatestMthdsAgentNpm()).toBeNull();
    });

    it("returns null when fetch rejects (network error)", async () => {
      fetchSpy!.mockRejectedValueOnce(new TypeError("fetch failed"));
      expect(await fetchLatestMthdsAgentNpm()).toBeNull();
    });

    it("returns null when body has no version field", async () => {
      fetchSpy!.mockResolvedValueOnce(makeResponse({ name: "mthds" }));
      expect(await fetchLatestMthdsAgentNpm()).toBeNull();
    });

    it("returns null when version is an empty string", async () => {
      fetchSpy!.mockResolvedValueOnce(makeResponse({ version: "" }));
      expect(await fetchLatestMthdsAgentNpm()).toBeNull();
    });

    it("returns null when version is not a string", async () => {
      fetchSpy!.mockResolvedValueOnce(makeResponse({ version: 42 }));
      expect(await fetchLatestMthdsAgentNpm()).toBeNull();
    });

    it("returns null when JSON body is not an object", async () => {
      fetchSpy!.mockResolvedValueOnce(makeResponse("string body"));
      expect(await fetchLatestMthdsAgentNpm()).toBeNull();
    });

    it("returns null when json() throws (malformed body)", async () => {
      fetchSpy!.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("invalid JSON");
        },
      } as unknown as Response);
      expect(await fetchLatestMthdsAgentNpm()).toBeNull();
    });

    it("returns null on AbortError (mocked rejection)", async () => {
      const err = new DOMException("aborted", "AbortError");
      fetchSpy!.mockRejectedValueOnce(err);
      expect(await fetchLatestMthdsAgentNpm()).toBeNull();
    });

    it("actually aborts fetch after the 2s timeout", async () => {
      // Tests the real setTimeout + AbortController wiring — a regression that
      // swapped `controller.abort()` for a no-op setTimeout would still pass
      // the mocked-AbortError test above; this one wouldn't.
      vi.useFakeTimers();
      try {
        let abortedSignal: AbortSignal | null = null;
        fetchSpy!.mockImplementation((_url, init) => {
          abortedSignal = (init as RequestInit | undefined)?.signal ?? null;
          return new Promise((_resolve, reject) => {
            abortedSignal?.addEventListener("abort", () => {
              const err = new DOMException("aborted", "AbortError");
              reject(err);
            });
          });
        });

        const pending = fetchLatestMthdsAgentNpm();
        // Cannot resolve before 2s — advance clock to trigger the timeout.
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;
        expect(result).toBeNull();
        expect(abortedSignal).not.toBeNull();
        expect(abortedSignal!.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── fetchLatestPluginMarketplace ──────────────────────────────────
  describe("fetchLatestPluginMarketplace", () => {
    it("returns the version string on happy path", async () => {
      fetchSpy!.mockResolvedValueOnce(
        makeResponse({ metadata: { version: "0.11.3" }, plugins: [] }),
      );
      const v = await fetchLatestPluginMarketplace();
      expect(v).toBe("0.11.3");
      const [url] = fetchSpy!.mock.calls[0]!;
      expect(url).toBe(
        "https://raw.githubusercontent.com/mthds-ai/mthds-plugins/main/.claude-plugin/marketplace.json",
      );
    });

    it("returns null on non-2xx", async () => {
      fetchSpy!.mockResolvedValueOnce(makeResponse({}, { ok: false, status: 500 }));
      expect(await fetchLatestPluginMarketplace()).toBeNull();
    });

    it("returns null when fetch rejects", async () => {
      fetchSpy!.mockRejectedValueOnce(new Error("network unreachable"));
      expect(await fetchLatestPluginMarketplace()).toBeNull();
    });

    it("returns null when metadata is missing", async () => {
      fetchSpy!.mockResolvedValueOnce(makeResponse({ name: "mthds-plugins" }));
      expect(await fetchLatestPluginMarketplace()).toBeNull();
    });

    it("returns null when metadata.version is missing", async () => {
      fetchSpy!.mockResolvedValueOnce(makeResponse({ metadata: { other: 1 } }));
      expect(await fetchLatestPluginMarketplace()).toBeNull();
    });

    it("returns null when metadata.version is not a string", async () => {
      fetchSpy!.mockResolvedValueOnce(
        makeResponse({ metadata: { version: { tag: "0.11.3" } } }),
      );
      expect(await fetchLatestPluginMarketplace()).toBeNull();
    });

    it("returns null when metadata is not an object", async () => {
      fetchSpy!.mockResolvedValueOnce(makeResponse({ metadata: "0.11.3" }));
      expect(await fetchLatestPluginMarketplace()).toBeNull();
    });
  });
});
