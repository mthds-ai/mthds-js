/**
 * What a publish refuses before asking mthds.sh anything: the two cases the hub would refuse
 * anyway, said in the publisher's terms, and without sending a private repository's name.
 */

import type { ParsedAddress } from "../../package/manifest/types.js";

/** Why a method package in a repository's subdirectory cannot be listed on mthds.sh. */
export function subdirectoryRefusal(parsed: ParsedAddress): string {
  return (
    `Nothing was published: mthds.sh lists the methods at the root of a repository (methods/<name>/), ` +
    `and ${parsed.org}/${parsed.repo}/${parsed.subpath} names a subdirectory of ${parsed.org}/${parsed.repo}.`
  );
}

/** Why a private repository cannot be listed on mthds.sh. */
export function privateRepositoryRefusal(orgRepo: string): string {
  return `Nothing was published: ${orgRepo} is a private repository, and mthds.sh lists only public ones.`;
}
