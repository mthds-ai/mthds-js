# PR #132 review notes — deferred items

Round 3 of the `/rev` ladder on https://github.com/mthds-ai/mthds-js/pull/132 (`feature/Agent-run-validation-items`, head `12aa56c`), at profile 4 with cubic, Codex (review and adversarial) and code-review at medium. The bar was `necessity`, which fixes only a defect the previous pass's own changes introduced or one too severe to ship with. No finding met it, so every finding below is deferred. None was put to a verifier, so each rests on its reviewer's word alone.

## The workspace spec still says `validation_errors` rides only a `ValidateBundleError` (unverified)

- **Reporter:** cubic (P2), on `src/agent/output.ts`.
- **Issue:** the workspace spec `docs/specs/mthds-agent-cli.md` (around line 68, and the no-verdict envelope around line 266) says the `validation_errors` field is present only on a `ValidateBundleError`. Since this change, a `RunnerError` envelope carries it too (`run start` and every other API-runner command whose refusal lists items).
- **Trace:** the spec lives in the workspace repository and is the spec member of the sprint, which describes the envelope once this branch lands.

## The build-verdict wording covers every `/v1/build/*` route, `concept` and `pipe-spec` included (unverified)

- **Reporter:** cubic (P2), on `src/runners/api/exceptions.ts`.
- **Issue:** the corrected comments and docs say the build routes answer an invalid bundle with a `200` verdict and never put items on `ApiResponseError`. That holds for the crate routes (`build/inputs`, `build/output`, `build/runner`); `build/concept` and `build/pipe-spec` answer an invalid spec with a `422`, reportedly without items. The same wording is in `docs/errors.md`, `docs/architecture.md`, `src/index.ts` and `src/runners/api/models.ts`.
- **Recommendation:** scope the claim to the three crate routes, and say what the `concept` and `pipe-spec` 422s carry once that is read off pipelex-api.

## `api-commands.ts` comments say `validation_errors` rides only a verdict (unverified)

- **Reporters:** cubic (P3) and code-review (a remark, no priority), on `src/agent/commands/api-commands.ts` near the `emitInputsTemplate` and `runProtocolValidate` catch arms.
- **Issue:** the comments say `is_valid` and `validation_errors` ride only a verdict. Since this change a refusal's catch arm can carry `validation_errors` through `runnerProblemExtras`, although never `is_valid`, so a caller can still tell the two apart.
- **Recommendation:** reword the two comments to say a refusal may carry the items but never `is_valid`.

## The human `mthds run` still drops a refusal's validation items (unverified)

- **Reporter:** cubic (P3), on `src/cli/commands/error-output.ts`.
- **Issue:** `formatCliError`, which `mthds run` uses (`src/cli/commands/run.ts`), prints the message, domain, next step, retry flag and request id of a refusal, but not its validation items or their suggested fixes, so a person running an invalid method sees that it was refused but not which pipe or what fix.
- **Trace:** reported to the sprint's orchestrator as a found item, to be filed there.
