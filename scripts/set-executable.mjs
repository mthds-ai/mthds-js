// Sets the executable bit on every published bin after `tsc` — in Node rather
// than POSIX `chmod` so the build also works on native Windows (where chmod
// does not exist as a command and the exec bit is a no-op).
import { chmodSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

for (const binPath of Object.values(pkg.bin)) {
  chmodSync(new URL(`../${binPath}`, import.meta.url), 0o755);
}
