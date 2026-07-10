import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "../..");

// The build script must leave every published bin executable — npm's bin shims
// point at these files directly, so a missing exec bit breaks `npx mthds` on
// publish paths that preserve tarball file modes. Windows has no exec bit.
describe.skipIf(process.platform === "win32")("built bin permissions (e2e)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
    bin: Record<string, string>;
  };

  it.each(Object.entries(pkg.bin))("%s bin (%s) is executable after build", (_name, binPath) => {
    const mode = statSync(join(REPO_ROOT, binPath)).mode;
    expect(mode & 0o111, `${binPath} should have the executable bit set`).not.toBe(0);
  });
});
