import { describe, it, expect } from "vitest";
import { buildShareUrls } from "../../../src/cli/commands/share.js";

const singleMethod = {
  methods: [{ displayName: "Contract Analysis", description: "Analyze legal contracts with AI" }],
  address: "mthds-ai/contract-analysis",
};

const multiMethods = {
  methods: [
    { displayName: "Contract Analysis", description: "Analyze legal contracts with AI" },
    { displayName: "Doc Summarizer", description: "Summarize documents" },
    { displayName: "Entity Extractor", description: "Extract entities" },
  ],
  address: "Pipelex/methods",
};

describe("buildShareUrls", () => {
  describe("single method", () => {
    it("includes display name and description in X text", () => {
      const urls = buildShareUrls(singleMethod);
      const text = decodeURIComponent(urls.x.replace("https://twitter.com/intent/tweet?text=", ""));
      expect(text).toContain('"Contract Analysis"');
      expect(text).toContain("Analyze legal contracts with AI");
      expect(text).toContain("npx mthds install mthds-ai/contract-analysis");
      expect(text).toContain("#mthds #AI");
    });

    it("uses method name in Reddit title", () => {
      const urls = buildShareUrls(singleMethod);
      const url = new URL(urls.reddit);
      expect(url.searchParams.get("title")).toContain("Contract Analysis");
    });
  });

  describe("multiple methods", () => {
    it("lists method names with short descriptions in X text", () => {
      const urls = buildShareUrls(multiMethods);
      const text = decodeURIComponent(urls.x.replace("https://twitter.com/intent/tweet?text=", ""));
      expect(text).toContain("3 methods");
      expect(text).toContain("- Contract Analysis: Analyze legal contracts with AI");
      expect(text).toContain("- Doc Summarizer: Summarize documents");
      expect(text).toContain("- Entity Extractor: Extract entities");
    });

    it("uses count in Reddit title", () => {
      const urls = buildShareUrls(multiMethods);
      const url = new URL(urls.reddit);
      expect(url.searchParams.get("title")).toContain("3 AI methods");
    });
  });

  describe("reddit", () => {
    it("creates a text post on old.reddit.com with body text", () => {
      const urls = buildShareUrls(singleMethod);
      expect(urls.reddit).toContain("www.reddit.com/submit");
      const url = new URL(urls.reddit);
      expect(url.searchParams.get("type")).toBe("TEXT");
      expect(url.searchParams.get("text")).toBeTruthy();
      expect(url.searchParams.get("text")).toContain("Contract Analysis");
    });
  });

  describe("linkedin", () => {
    it("includes pre-filled text with the share content", () => {
      const urls = buildShareUrls(singleMethod);
      expect(urls.linkedin).toContain("linkedin.com/feed/?shareActive=true&text=");
      const url = new URL(urls.linkedin);
      const text = url.searchParams.get("text")!;
      expect(text).toContain("Contract Analysis");
      expect(text).toContain("mthds.sh");
    });
  });

  it("returns all three platforms", () => {
    const urls = buildShareUrls(singleMethod);
    expect(urls).toHaveProperty("x");
    expect(urls).toHaveProperty("reddit");
    expect(urls).toHaveProperty("linkedin");
  });

  it("truncates long descriptions to 15 words in multi-method mode", () => {
    const urls = buildShareUrls({
      methods: [
        { displayName: "Method A", description: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen" },
        { displayName: "Method B", description: "short desc" },
      ],
      address: "org/repo",
    });
    const text = decodeURIComponent(urls.x.replace("https://twitter.com/intent/tweet?text=", ""));
    expect(text).toContain("- Method A: one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen...");
    expect(text).toContain("- Method B: short desc");
  });

  it("encodes special characters", () => {
    const urls = buildShareUrls({
      methods: [{ displayName: "Test & Demo", description: "Special chars: <>&" }],
      address: "org/repo",
    });
    expect(urls.x).not.toContain(" ");
    expect(urls.reddit).not.toContain(" ");
    expect(urls.linkedin).not.toContain(" ");
  });
});
