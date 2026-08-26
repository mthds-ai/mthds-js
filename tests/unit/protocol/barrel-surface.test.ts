import { describe, it, expect } from "vitest";
import * as protocol from "../../../src/protocol/index.js";
import type {
  MTHDSProtocol,
  RunRequest,
  StartRequest,
  RunOptions,
  StartOptions,
  ExtensionOptions,
  RunResultExecute,
  RunResultStart,
  ModelCategory,
  ModelInfo,
  ModelDeck,
  ValidationReport,
  ValidationError,
  InvalidValidationReport,
  ValidationResult,
  VersionInfo,
  VariableMultiplicity,
  PipeOutputAbstract,
  StuffContentOrData,
  PipelineInputs,
  ConceptAbstract,
  StuffAbstract,
  StuffContentAbstract,
  WorkingMemoryAbstract,
  MethodFile,
  IOMultiplicity,
  PresenceMarker,
  PipeInputContract,
  PipeOutputContract,
  PipeIOContract,
  PipeIOContracts,
  FieldKind,
  IntentHints,
  InputFormField,
  InputFormItem,
  TextFieldNode,
  ProseFieldNode,
  DateFieldNode,
  NumberFieldNode,
  BooleanFieldNode,
  EnumFieldNode,
  DocumentFieldNode,
  ImageFieldNode,
  ObjectFieldNode,
  ListFieldNode,
  UnknownFieldNode,
  PipeInputFormDescriptor,
  InputForm,
} from "../../../src/protocol/index.js";

/**
 * Export-surface guard for the protocol barrel — the `mthds/protocol` subpath
 * that `@pipelex/sdk` builds its clients on.
 *
 * The barrel is a hand-maintained re-export list, so dropping a line from it
 * compiles clean: `tsc` never learns that a symbol was *supposed* to stay
 * public, and the per-module unit tests import their subject directly. That
 * combination lets a barrel deletion break every downstream consumer with no
 * signal in this repo. This file is the missing signal.
 *
 * Two halves, because the two kinds of export fail differently:
 *   - runtime values are asserted below, at run time;
 *   - types are asserted by the `import type` block above, which `npm run
 *     typecheck:test` resolves — a dropped type re-export fails there.
 *
 * Deliberately imports the barrel *source*, not the published `mthds/protocol`
 * specifier: `npm test` runs against `src/` with no build step, so resolving
 * through `exports` would either fail on a clean checkout or silently assert
 * against a stale `dist/`. Packaging (the `exports` map, `files`) is a
 * build-artifact concern and belongs with the `dist/`-dependent e2e tests.
 */

// Type-side surface: referencing each imported type is what makes the
// `import type` block above load-bearing rather than dead.
export type ProtocolTypeSurface = [
  MTHDSProtocol,
  RunRequest,
  StartRequest,
  RunOptions,
  StartOptions,
  ExtensionOptions,
  RunResultExecute,
  RunResultStart,
  ModelCategory,
  ModelInfo,
  ModelDeck,
  ValidationReport,
  ValidationError,
  InvalidValidationReport,
  ValidationResult,
  VersionInfo,
  VariableMultiplicity,
  PipeOutputAbstract,
  StuffContentOrData,
  PipelineInputs,
  ConceptAbstract,
  StuffAbstract,
  StuffContentAbstract,
  WorkingMemoryAbstract,
  MethodFile,
  IOMultiplicity,
  PresenceMarker,
  PipeInputContract,
  PipeOutputContract,
  PipeIOContract,
  PipeIOContracts,
  FieldKind,
  IntentHints,
  InputFormField,
  InputFormItem,
  TextFieldNode,
  ProseFieldNode,
  DateFieldNode,
  NumberFieldNode,
  BooleanFieldNode,
  EnumFieldNode,
  DocumentFieldNode,
  ImageFieldNode,
  ObjectFieldNode,
  ListFieldNode,
  UnknownFieldNode,
  PipeInputFormDescriptor,
  InputForm,
];

describe("protocol barrel", () => {
  it("re-exports every runtime value in the public surface", () => {
    expect(Object.keys(protocol).sort()).toEqual([
      "FIELD_KINDS",
      "MODEL_CATEGORIES",
      "MTHDS_PROTOCOL_VERSION",
      "PipelineRequestError",
      "assertExclusiveRunSources",
      "conceptRef",
      "hasBundlePayload",
      "parseMethodFiles",
      "serializeMethodFiles",
    ]);
  });
});
