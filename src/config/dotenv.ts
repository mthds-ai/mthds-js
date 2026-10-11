// ── Dotenv parser / serializer ─────────────────────────────────────
// The dialect of `~/.mthds/config`, shared with mthds-python and pinned by
// conformance/specs/mthds-config-file.md, which lives in the conformance repo beside the
// test that verifies it. It sits in a module of its own, with no import, so that the usage
// statistics, which read the legacy telemetry opt-out from that file, can parse it without
// depending on the rest of the configuration. `config.ts` re-exports both functions, where the
// shared conformance fixture (tests/fixtures/config-dialect-cases.json) exercises them.

export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

export function serializeDotenv(entries: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}
