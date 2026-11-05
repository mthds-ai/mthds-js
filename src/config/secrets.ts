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
 * The credentials of a URL: from the end of its scheme's `://` to the last `@` before a query or a
 * fragment. Hiding a little more than the userinfo of a malformed URL, such as one with a `/` in
 * its password, is the safe side.
 */
const URL_CREDENTIALS = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^?#]*@/;

/**
 * A URL with the credentials it carries, a user name, a password or a token, replaced by `…`, such
 * as `https://…@example.com` for `https://user:password@example.com`. A base URL never holds
 * credentials, which the client refuses, but a refused value, or one set in `MTHDS_BASE_URL` or by
 * hand in `~/.mthds/config`, is still quoted by the command that reads it. A URL holding none is
 * returned as it is.
 */
export function maskUrlCredentials(url: string): string {
  return url.replace(URL_CREDENTIALS, `$1${HIDDEN_MARK}@`);
}

/** A setting's value as a command shows it, and whether a secret of it was hidden. */
export interface ShownConfigValue {
  value: string;
  /** True when the value shown is not the value set: the API key masked, or a URL's credentials hidden. */
  masked: boolean;
}

/**
 * A setting's value as `config set`, `config get` and `config list` show it: the API key masked
 * (`maskSecret`), the base URL without its credentials (`maskUrlCredentials`), and every other
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
