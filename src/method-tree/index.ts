/**
 * The method tree (mthds/docs/spec/method-tree.md): the set of files under a method's root that the
 * membership rule admits, its tree digest, its file references, and the map of file entries it
 * travels as. Node-side: listing reads the file system. See docs/method-tree.md.
 */

export { listMethodTree } from "./lister.js";
export type { ListMethodTreeOptions, MethodTreeLimits } from "./lister.js";
export { MethodTree } from "./tree.js";
export type {
  MethodTreeFile,
  ReferenceRefusal,
  ReferenceResolution,
  ResolveReferenceInput,
} from "./tree.js";
export { MethodTreeError, TreeLimitExceededError, namesExcludedDirectory } from "./exceptions.js";
export type {
  ExclusionRule,
  MapRefusalCode,
  MethodTreeErrorCode,
  MethodTreeImplementationCode,
  TreeLimit,
  TreeRefusalCode,
} from "./exceptions.js";
export {
  MAX_SEGMENT_BYTES,
  MAX_TREE_PATH_BYTES,
  compareUtf8,
  isTreePath,
  pathCollisions,
  treePathViolation,
} from "./tree-path.js";
export { CASE_FOLDING_UNICODE_VERSION, caseFold, fullCaseFold } from "./case-folding.js";
export {
  TREE_DIGEST_PATTERN,
  TREE_DIGEST_PREFIX,
  sha256Hex,
  treeDigest,
  treeListing,
} from "./digest.js";
export type { DigestedFile } from "./digest.js";
export { ROOT_RESOLVED, isFileReference, resolveFileReference } from "./references.js";
export type {
  BareReferenceResolution,
  ReferenceContext,
  ReferenceRefusalCode,
  ResolveFileReferenceInput,
} from "./references.js";
export { locateFunction } from "./function-names.js";
export type { FunctionLocation, FunctionNameRefusalCode } from "./function-names.js";
export {
  EMPTY_BLOB_STORE,
  decodeCanonicalBase64,
  isExcludedName,
  readFileEntryMap,
  readFileEntryMapValue,
} from "./file-entries.js";
export type { BlobStore, ReadFile, ReadTree } from "./file-entries.js";
export { JsonDocumentError, parseJsonDocument } from "./json-document.js";
export type { JsonValue } from "./json-document.js";
export { findManifestDirectory } from "./discovery.js";
