/**
 * The skip list, read back.
 *
 * A resolver returns two lists: the methods it could read, and the ones it
 * refused with the reasons why. Every consumer used to read only the first,
 * which was survivable while a skip meant a structurally broken METHODS.toml —
 * the author of that file finds out soon enough. It stopped being survivable
 * once an `mthds_version` this build does not satisfy became a refusal: that
 * manifest is well-formed, its author did nothing wrong, and the reason lives
 * only in the list nobody read.
 *
 * The two helpers here are the two places the skip list has to reach: the
 * `--method` filter, which must not call a refused method missing, and the
 * agent envelopes, which must not report a partial result as a whole one.
 */

import type { ResolvedRepo, SkippedMethod } from "../../package/manifest/types.js";

/** One refused method, as it rides an agent-CLI success envelope. */
export interface SkippedMethodReport {
  /** The method directory — the same name `--method` takes. */
  readonly name: string;
  /** Why it was refused, one message per failed check. */
  readonly errors: string[];
}

/** Find the refused method a `--method` name refers to, if the name is one of them. */
export function findSkippedMethod(resolved: ResolvedRepo, name: string): SkippedMethod | undefined {
  return resolved.skipped.find((entry) => entry.dirName === name);
}

/**
 * The message for a `--method` name that matched nothing usable.
 *
 * A name in the skip list gets the reason the resolver already produced; only a
 * name in neither list is "not found", which is the only case where offering
 * the available names is a correction rather than a red herring.
 */
export function describeUnusableMethod(resolved: ResolvedRepo, name: string): string {
  const skipped = findSkippedMethod(resolved, name);
  if (skipped) {
    const reasons = skipped.errors.map((message) => `  - ${message}`).join("\n");
    return `Method "${name}" was found but skipped:\n${reasons}`;
  }
  const available = resolved.methods.map((method) => method.name).join(", ");
  return `Method "${name}" not found. Available methods: ${available || "(none)"}`;
}

/**
 * The repository's skip list in envelope shape.
 *
 * Reported whole even under `--method`, because a skip is a property of the
 * repository rather than of the selection: the caller asked this build to read
 * that repository, and this is what it could not read.
 */
export function skippedMethodReports(resolved: ResolvedRepo): SkippedMethodReport[] {
  return resolved.skipped.map((entry) => ({ name: entry.dirName, errors: [...entry.errors] }));
}
