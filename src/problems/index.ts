/**
 * Problems: the MTHDS Protocol's error document, the core error registry it is coded from, and
 * how a client reads, builds and renders one. Free of Node built-ins, so `mthds/errors` exports it
 * to a browser bundle too. See docs/errors.md.
 */

export {
  CORE_ERROR_BASE_URL,
  CORE_REGISTRY,
  ERROR_CODES,
  ERROR_FAMILIES,
  EXTENSION_PREFIXES,
  MTHDS_ERROR_REGISTRY_VERSION,
} from "./registry.generated.js";
export type { CoreErrorCode, ErrorFamily, ProblemParamsByCode } from "./registry.generated.js";
export { MTHDS_ERROR_REGISTRY_TARGET_VERSION } from "./registry-target.js";
export {
  FIX_OP_KINDS,
  FIX_SAFETIES,
  PROBLEM_DOMAINS,
  RETRY_VERDICTS,
  STEP_KINDS,
} from "./vocabulary.js";
export type {
  FixOpKind,
  FixSafety,
  ProblemDomain,
  RaisedAs,
  RegistryParamType,
  RetryVerdict,
  StepKind,
} from "./vocabulary.js";
export type {
  DeleteKeyOp,
  DeleteTableOp,
  EnsureTableOp,
  ExtensionPrefix,
  FixOp,
  FixValue,
  KnownFixOp,
  MoveKeyOp,
  NextStep,
  Problem,
  ProblemItem,
  ProblemLocation,
  ProblemParams,
  RegistryEntry,
  RegistryParam,
  RemapValueOp,
  RenameTableKeyOp,
  SetKeyOp,
  StepTemplate,
  SuggestedFix,
  UnknownFixOp,
} from "./types.js";
export {
  PROBLEM_CODE_PATTERN,
  codeFamily,
  isCoreErrorCode,
  registryEntry,
  typeUriOf,
} from "./registry.js";
export {
  fixSafety,
  isApplicableFix,
  isKnownFixOp,
  itemDomain,
  knownProblemDomain,
  problemDomain,
  problemRetry,
  problemStepKind,
} from "./reading.js";
export {
  buildProblem,
  buildProblemFromEntry,
  defaultStepReader,
  renderTemplate,
  templateParams,
} from "./build.js";
export type { BuildProblemOptions, StepReader } from "./build.js";
export {
  MAX_BODY_NESTING,
  isProblem,
  isProblemItem,
  parseJsonBody,
  readAnswer,
  readErrorAnswer,
  readProblemBody,
  retryAfterSeconds,
  unreadableAnswer,
} from "./read.js";
export type {
  Answer,
  AnswerHeaders,
  AnswerReading,
  JsonReading,
  ReadAnswerOptions,
} from "./read.js";
export {
  formatItem,
  formatLocation,
  formatSuggestedFix,
  problemRequestId,
  renderProblemLines,
  renderProblemMarkdown,
} from "./render.js";
export {
  ProblemError,
  argumentInvalid,
  isProblemError,
  problemError,
  problemErrorMessage,
  reportedProblem,
} from "./errors.js";
export type { ProblemErrorOptions } from "./errors.js";
