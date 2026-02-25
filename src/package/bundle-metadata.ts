/**
 * Minimal metadata about a bundle needed for visibility checking.
 */
export interface BundleMetadata {
  readonly domain: string;
  readonly mainPipe: string | null;
  readonly pipeReferences: Array<[string, string]>; // [pipe_ref_str, context]
}
