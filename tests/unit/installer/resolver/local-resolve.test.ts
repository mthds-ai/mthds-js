import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFromLocal } from "../../../../src/installer/resolver/local.js";
import { MethodResolveError } from "../../../../src/installer/resolver/exceptions.js";

// Why a local resolve failed, as `MethodResolveError.reason` says it: nothing there, or a path the
// system refused to read.

const scratch: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mthds-local-resolve-"));
  scratch.push(dir);
  return dir;
}

async function failure(path: string): Promise<MethodResolveError> {
  try {
    await resolveFromLocal(path);
  } catch (err) {
    expect(err).toBeInstanceOf(MethodResolveError);
    return err as MethodResolveError;
  }
  return expect.fail("expected the resolve to fail");
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveFromLocal failures", () => {
  it("reads a missing directory as not_found", async () => {
    const err = await failure(join(scratchDir(), "absent"));
    expect(err.reason).toBe("not_found");
    expect(err.message).toContain("Directory not found");
  });

  it("reads a file given as the directory as not_found", async () => {
    const file = join(scratchDir(), "a-file");
    writeFileSync(file, "");
    expect((await failure(file)).reason).toBe("not_found");
  });

  it("reads a directory with no methods/ folder, or an empty one, as not_found", async () => {
    const dir = scratchDir();
    expect((await failure(dir)).reason).toBe("not_found");
    mkdirSync(join(dir, "methods"));
    expect((await failure(dir)).message).toContain("No methods found");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reads a methods/ folder the system refuses to list as unreadable, naming its path",
    async () => {
      const dir = scratchDir();
      const methods = join(dir, "methods");
      mkdirSync(methods);
      chmodSync(methods, 0o000);
      try {
        const err = await failure(dir);
        expect(err.reason).toBe("unreadable");
        expect(err.path).toBe(methods);
        expect(err.fsCode).toBe("EACCES");
      } finally {
        chmodSync(methods, 0o755);
      }
    },
  );
});
