/**
 * What a publish refuses before asking mthds.sh anything: the cases the hub would refuse anyway,
 * said in the publisher's terms, and without sending the name of a repository that is not public.
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

/** Why a repository GitHub does not show, missing or private, cannot be listed on mthds.sh. */
export function unseenRepositoryRefusal(orgRepo: string): string {
  return `Nothing was published: GitHub has no public repository ${orgRepo} (it does not exist, or it is private), and mthds.sh lists only public ones.`;
}

/** Why a manifest address outside GitHub cannot be listed on mthds.sh. */
export function notOnGitHubRefusal(address: string): string {
  return `Nothing was published: mthds.sh lists methods from public GitHub repositories, and the manifest's address ${address} is not on GitHub.`;
}

/** Why a publish stops when GitHub cannot say whether a repository is public. */
export function visibilityUnknownRefusal(orgRepo: string, detail: string): string {
  return `Nothing was published: could not check with GitHub that ${orgRepo} is public, and mthds.sh is never sent a repository that may be private (${detail}).`;
}
