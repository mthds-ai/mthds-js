import { describe, it, expect } from "vitest";
import { buildShareUrl } from "../../../src/cli/commands/share.js";

describe("buildShareUrl", () => {
  it("builds a Twitter intent URL with encoded text", () => {
    const url = buildShareUrl({
      displayName: "Contract Analysis",
      description: "Analyze legal contracts with AI",
      address: "mthds-ai/contract-analysis",
    });

    expect(url).toContain("https://twitter.com/intent/tweet?text=");
    const text = decodeURIComponent(url.replace("https://twitter.com/intent/tweet?text=", ""));
    expect(text).toContain('I just published "Contract Analysis" on mthds.sh!');
    expect(text).toContain("Analyze legal contracts with AI");
    expect(text).toContain("npx mthds install mthds-ai/contract-analysis");
    expect(text).toContain("#mthds #AI");
  });

  it("encodes special characters", () => {
    const url = buildShareUrl({
      displayName: "Test & Demo",
      description: "A method with special chars: <>&",
      address: "org/repo",
    });

    // URL should be properly encoded
    expect(url).not.toContain(" ");
    const text = decodeURIComponent(url.replace("https://twitter.com/intent/tweet?text=", ""));
    expect(text).toContain('Test & Demo');
    expect(text).toContain("<>&");
  });

  it("uses the address in the install command", () => {
    const url = buildShareUrl({
      displayName: "My Method",
      description: "desc",
      address: "acme/monorepo",
    });

    const text = decodeURIComponent(url.replace("https://twitter.com/intent/tweet?text=", ""));
    expect(text).toContain("npx mthds install acme/monorepo");
  });
});
