import type { ParsedAddress } from "../../package/manifest/types.js";

const VALID_SEGMENT = /^[a-zA-Z0-9._-]+$/;

export function parseAddress(input: string): ParsedAddress {
  let raw = input.trim();

  // Strip github.com/ prefix with warning
  if (raw.startsWith("github.com/")) {
    raw = raw.slice("github.com/".length);
    console.warn(
      `Warning: stripped "github.com/" prefix — use "${raw}" directly.`
    );
  }

  // Strip trailing slash
  if (raw.endsWith("/")) {
    raw = raw.slice(0, -1);
  }

  const segments = raw.split("/");

  if (segments.length < 2) {
    throw new Error(
      `Invalid address "${input}": expected at least org/repo (e.g. pipelex/cookbook).`
    );
  }

  for (const seg of segments) {
    if (!VALID_SEGMENT.test(seg)) {
      throw new Error(
        `Invalid address segment "${seg}": only alphanumeric, dot, dash, and underscore are allowed.`
      );
    }
  }

  const org = segments[0]!;
  const repo = segments[1]!;
  const subpath = segments.length > 2 ? segments.slice(2).join("/") : null;

  return { org, repo, subpath };
}
