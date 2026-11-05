// How a secret of the configuration is shown. The CLIs print, log and return a setting's value for
// an agent or a person to read, and whatever they print lands in a transcript, a log or a paste, so
// a secret is never shown whole: the API key is masked, and the credentials a URL may carry are
// hidden. Every place that shows a setting goes through this module, so the rule is written once.

import type { ConfigKey } from "./config.js";

/** The mark standing for a secret's hidden characters, as the Pipelex app lists a key by its prefix. */
export const HIDDEN_MARK = "…";

/** A secret shorter than this is shown as the mark alone: a short key would be guessed from any part of it. */
const SHORTEST_PARTLY_SHOWN = 16;

/** The most leading characters shown: a Pipelex key's `plx_sk_` and the five the Pipelex app lists it by. */
const MOST_LEADING_SHOWN = 12;

/** The most trailing characters shown, which tell apart two keys sharing a prefix. */
const MOST_TRAILING_SHOWN = 4;

/**
 * A secret as the CLIs show it: never more than a quarter of its characters, taken as up to its
 * first twelve and its last four around `…`, so that a Pipelex API key (`plx_sk_`, then 64
 * hexadecimal characters and a checksum) shows the prefix the Pipelex app lists it by and its last
 * four characters, such as `plx_sk_a1b2c…9f3e`. A secret shorter than sixteen characters is shown as
 * `…` alone, and an empty one, a setting with no value, as the empty string.
 */
export function maskSecret(secret: string): string {
  if (secret === "") return "";
  const characters = Array.from(secret);
  if (characters.length < SHORTEST_PARTLY_SHOWN) return HIDDEN_MARK;
  const shown = Math.floor(characters.length / 4);
  const trailing = Math.min(MOST_TRAILING_SHOWN, Math.floor(shown / 2));
  const leading = Math.min(MOST_LEADING_SHOWN, shown - trailing);
  return (
    characters.slice(0, leading).join("") +
    HIDDEN_MARK +
    characters.slice(characters.length - trailing).join("")
  );
}

/**
 * A value that may be a URL, with everything before its last `@` replaced by `…`, such as
 * `…@example.com` for `https://user:password@example.com`, and a value holding no `@` as it is.
 *
 * A URL carries a user name, a password or a token only before an `@`: the URL parser takes
 * credentials from the text before the last `@` of the authority, and nothing else, so hiding
 * everything before the last `@` of the whole value hides every credential, whatever its scheme,
 * slashes, backslashes or surrounding whitespace, and whether or not the value parses at all. The
 * value is never parsed, so this rule and the parser cannot disagree. The scheme and anything else
 * before that `@` are hidden too, which is the safe side: a valid base URL holds no `@` and is never
 * changed, and only a refused value, or one set in `MTHDS_BASE_URL` or by hand in
 * `~/.mthds/config`, is shown this way.
 */
export function maskUrlCredentials(value: string): string {
  const lastAt = value.lastIndexOf("@");
  return lastAt === -1 ? value : `${HIDDEN_MARK}${value.slice(lastAt)}`;
}

/** A setting's value as a command shows it, and whether a secret of it was hidden. */
export interface ShownConfigValue {
  value: string;
  /** True when the value shown is not the value set: the API key masked, or what may be a URL's credentials hidden. */
  masked: boolean;
}

/**
 * A setting's value as `config set`, `config get` and `config list` show it: the API key masked
 * (`maskSecret`), the base URL with what may be its credentials hidden (`maskUrlCredentials`), and every other
 * setting as it is. No command shows the API key whole: it is read where it is set, in
 * `MTHDS_API_KEY` or `~/.mthds/config`.
 */
export function shownConfigValue(key: ConfigKey, value: string): ShownConfigValue {
  if (key === "apiKey") return { value: maskSecret(value), masked: value !== "" };
  if (key === "baseUrl") {
    const shown = maskUrlCredentials(value);
    return { value: shown, masked: shown !== value };
  }
  return { value, masked: false };
}
