import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Runners } from "../types.js";
import { materializeBundleFiles } from "../bundle.js";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildInputsResponse,
  BuildOutputRequest,
  BuildOutputResponse,
  BuildRequestBase,
  BuildRunnerRequest,
  BuildRunnerResponse,
  ConceptRequest,
  ConceptResponse,
  MthdsFileItem,
  PipeSpecRequest,
  PipeSpecResponse,
  RunnerStructures,
  CheckModelRequest,
  CheckModelResponse,
  ConceptRepresentationFormat,
  InputsTemplateFormat,
} from "../types.js";
import { resolveQualifiedPipeRef } from "../pipe-ref.js";
import type { RunOptions, StartOptions } from "../../protocol/options.js";
import type {
  ModelCategory,
  ModelDeck,
  ModelInfo,
  ValidationResult,
  VersionInfo,
} from "../../protocol/models.js";
import { MTHDS_PROTOCOL_VERSION } from "../../protocol/models.js";
import { conceptRef } from "../../protocol/concept.js";
import type { DictPipeOutput, DictRunResultExecute } from "../api/models.js";

const execFileAsync = promisify(execFile);

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mthds-"));
}

// Extract the canonical code from the first `[concept.X]` / `[pipe.X]` section of a TOML
// string. pipelex normalizes these names (ASCII fold, PascalCase / snake_case, namespace
// strip) before emitting TOML, so the section header is the source of truth — not the
// caller-supplied spec.
function extractSectionKey(toml: string, kind: "concept" | "pipe"): string | null {
  const m = toml.match(new RegExp(`\\[${kind}\\.([^\\]\\s]+)\\]`));
  return m && m[1] ? m[1] : null;
}

/**
 * A file's `source` label is a free-form provenance string (a path, a URI). Keep
 * only what is safe to use as a temp filename: a plain `*.mthds` basename. Any
 * other label falls back to a positional name rather than escaping the temp dir.
 */
function safeFileName(source: string | undefined, index: number): string {
  const fallback = index === 0 ? "bundle.mthds" : `extra_${index}.mthds`;
  if (!source) return fallback;
  const base = source.split(/[/\\]/).pop();
  if (!base || !base.endsWith(".mthds") || base.startsWith(".")) return fallback;
  return base;
}

/**
 * Materialize a closure into a temp directory so the local CLI can load it.
 * Returns the path of the first file — the bundle the CLI is pointed at; the rest
 * sit beside it and are picked up via `-L <tmp>`.
 *
 * Each file is written under its own `source` label when that label is a usable
 * `.mthds` basename, so the CLI's diagnostics name the file the CALLER named —
 * the whole point of carrying `source` on the wire.
 */
function writeMthdsFiles(tmp: string, files: MthdsFileItem[]): string {
  if (files.length === 0) {
    throw new Error("At least one MTHDS file is required.");
  }
  const used = new Set<string>();
  let bundlePath: string | null = null;
  files.forEach((file, index) => {
    let name = safeFileName(file.source, index);
    // Two files may legitimately carry the same basename (different directories
    // upstream). Never let one silently overwrite the other.
    while (used.has(name)) name = `extra_${used.size}_${name}`;
    used.add(name);
    const path = join(tmp, name);
    writeFileSync(path, file.content, "utf-8");
    bundlePath ??= path;
  });
  return bundlePath!;
}

/**
 * The `mthds_contents` variant, for the routes that still ride bare strings —
 * `execute` / `start` / `validate`. Those are MTHDS Protocol routes: their
 * envelope is owned by the standard, so only the Pipelex-extension `/build/*`
 * routes moved to `files[]`.
 */
function writeMthdsContents(tmp: string, contents: string[]): string {
  return writeMthdsFiles(
    tmp,
    contents.map((content) => ({ content })),
  );
}

/** Materialize a `/v1/build/*` closure, rejecting the selector this runner cannot serve. */
function writeBuildFiles(tmp: string, request: BuildRequestBase): string {
  if (request.method_ref) {
    throw new Error(
      "method_ref is not supported by the local pipelex runner — pass the closure as files[]. " +
        "(The API answers 501 for it too: the method registry does not exist yet.)",
    );
  }
  return writeMthdsFiles(tmp, request.files ?? []);
}

const STRUCTURES_DIR = "structures";
const CODEGEN_LOCK_FILENAME = "codegen.lock";

/**
 * Walk a projection directory and collect every file under its path RELATIVE to the
 * root, "/"-separated regardless of platform — the wire shape `GeneratedArtifact.path`
 * carries. pipelex's lock layer validates artifact paths as (possibly multi-part)
 * relative paths, so nested files are part of the projection, not noise: skipping
 * them would hand `codegen check` a silently halved artifact set.
 */
function collectArtifactFiles(root: string, rel = ""): { path: string; content: string }[] {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return collectArtifactFiles(root, relPath);
    if (!entry.isFile()) return [];
    return [{ path: relPath, content: readFileSync(join(root, relPath), "utf-8") }];
  });
}

/**
 * Collect the typed-structures projection `pipelex build runner` scaffolds beside
 * the script it emits, so the local runner returns the same `structures` payload
 * the API does — the stamped artifacts plus the lock that tracks them.
 *
 * Returns `undefined` when the CLI emitted no projection. That is not a failure: a
 * closure that resolves to no crate yields no `structures/`, and the `runner.py` we
 * just generated is valid regardless, so treating a missing lock as fatal would throw
 * away good output over an absent sidecar. The lock is still all-or-nothing: a
 * projection without one cannot be offline-checked, so we never report a half one.
 */
function readRunnerStructures(runnerPath: string): RunnerStructures | undefined {
  const dir = join(dirname(runnerPath), STRUCTURES_DIR);
  const lockPath = join(dir, CODEGEN_LOCK_FILENAME);
  if (!existsSync(lockPath)) return undefined;

  const artifacts = collectArtifactFiles(dir)
    .filter((artifact) => artifact.path !== CODEGEN_LOCK_FILENAME)
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  return {
    directory: STRUCTURES_DIR,
    artifacts,
    lock: readFileSync(lockPath, "utf-8"),
    lock_filename: CODEGEN_LOCK_FILENAME,
  };
}

export class PipelexRunner implements Runner {
  readonly type: RunnerType = Runners.PIPELEX;
  private readonly libraryDirs: string[];

  constructor(libraryDirs?: string[]) {
    this.libraryDirs = libraryDirs ?? [];
  }

  private libraryArgs(): string[] {
    return this.libraryDirs.flatMap((dir) => ["-L", dir]);
  }

  private async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("pipelex", [...args, ...this.libraryArgs()], {
      encoding: "utf-8",
    });
  }

  /**
   * Run pipelex with stdout and stderr inherited (streamed to the terminal).
   * Use this for long-running or interactive commands.
   */
  private async execStreaming(args: string[], inheritStdin = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("pipelex", [...args, ...this.libraryArgs()], {
        stdio: [inheritStdin ? "inherit" : "ignore", "inherit", "inherit"],
      });
      child.on("error", (err) => reject(new Error(`pipelex not found: ${err.message}`)));
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`pipelex exited with code ${code}`));
        }
      });
    });
  }

  // ── CLI passthrough ──────────────────────────────────────────

  async buildPassthrough(subcommand: string, rawArgs: string[]): Promise<void> {
    await this.execStreaming(["build", subcommand, ...rawArgs]);
  }

  async runPassthrough(rawArgs: string[]): Promise<void> {
    await this.execStreaming(["run", ...rawArgs], true);
  }

  async validatePassthrough(rawArgs: string[]): Promise<void> {
    await this.execStreaming(["validate", ...rawArgs]);
  }

  // ── Health & version ────────────────────────────────────────────

  async health(): Promise<Record<string, unknown>> {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pipelex health check timed out after 10s")), 10_000),
      );
      await Promise.race([this.exec(["doctor", "-g"]), timeout]);
      return { status: "ok" };
    } catch {
      throw new Error("pipelex CLI is not installed or not in PATH");
    }
  }

  async version(): Promise<VersionInfo> {
    const { stdout } = await this.exec(["--version"]);
    const pipelexVersion = stdout.trim();
    return {
      protocol_version: MTHDS_PROTOCOL_VERSION,
      runner_version: pipelexVersion,
      // Implementation identity rides the protocol's extension-open VersionInfo.
      implementation: "pipelex",
      implementation_version: pipelexVersion,
      runtime_version: pipelexVersion,
    };
  }

  // ── Build ───────────────────────────────────────────────────────
  //
  // The local runner speaks the same discriminated verdict as the API
  // (`is_valid` + a qualified `pipe_ref`), but it reaches it by shelling out to
  // the CLI rather than by loading a library. Two consequences, both deliberate:
  //
  //  * It never RETURNS the invalid arm — an unloadable closure makes the CLI
  //    exit non-zero, which surfaces as a thrown error. The union's invalid arm
  //    is therefore API-only in practice. Callers still branch on `is_valid`;
  //    that branch is simply never taken here.
  //  * It resolves the qualified `pipe_ref` ITSELF (see `resolveQualifiedPipeRef`)
  //    and passes it to `--pipe` explicitly, so the ref it echoes back is exactly
  //    the ref it asked for — never a bare code dressed up as a resolved one.

  // pipelex-agent inputs bundle <bundle.mthds> --pipe <ref> --format <fmt> [--explicit]
  async buildInputs(request: BuildInputsRequest): Promise<BuildInputsResponse> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = writeBuildFiles(tmp, request);
      const pipeRef = resolveQualifiedPipeRef(request.files ?? [], request.pipe_ref);
      const format: InputsTemplateFormat = request.format ?? "json";
      const explicit = request.explicit ?? false;

      const { stdout } = await execFileAsync(
        "pipelex-agent",
        [
          "inputs",
          "bundle",
          bundlePath,
          "--pipe",
          pipeRef,
          "--format",
          format,
          ...(explicit ? ["--explicit"] : []),
          "-L",
          tmp,
          ...this.libraryArgs(),
        ],
        { encoding: "utf-8" },
      );

      const base = {
        is_valid: true as const,
        pipe_ref: pipeRef,
        ...(request.pipe_ref ? { requested_pipe_ref: request.pipe_ref } : {}),
        explicit,
        message: "Inputs template generated via local CLI",
      };

      // `--format toml` prints the raw template to stdout; `--format json` prints
      // the agent CLI's own `{success, pipe_code, inputs}` envelope, whose `inputs`
      // is the template. Unwrap it so both runners return the SAME thing under
      // `inputs` — the bare template, as the API does.
      if (format === "toml") {
        return { ...base, format, inputs_toml: stdout };
      }
      const envelope = JSON.parse(stdout) as { inputs?: Record<string, unknown> };
      // The envelope always carries `inputs` — `{}` for an input-less pipe. Its
      // absence means the CLI contract changed under us; surface that as a
      // no-verdict rather than an `is_valid: true` with a hollowed-out template.
      if (envelope.inputs === undefined) {
        throw new Error("pipelex-agent inputs returned no `inputs` field in its JSON envelope.");
      }
      return { ...base, format, inputs: envelope.inputs };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // pipelex build output bundle <bundle.mthds> --pipe <ref> -o <file> --format <fmt>
  // Output format determines the file content: 'json'/'schema' produce JSON, 'python' produces Python code.
  // We always pass --format explicitly so the parsing branch below does not rely on
  // pipelex's CLI default, which is outside our contract.
  async buildOutput(request: BuildOutputRequest): Promise<BuildOutputResponse> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = writeBuildFiles(tmp, request);
      const pipeRef = resolveQualifiedPipeRef(request.files ?? [], request.pipe_ref);
      const outPath = join(tmp, "output.json");
      const format: ConceptRepresentationFormat = request.format ?? "schema";

      const args = [
        "build",
        "output",
        "bundle",
        bundlePath,
        "--pipe",
        pipeRef,
        "-o",
        outPath,
        "-L",
        tmp,
        "--format",
        format,
        ...this.libraryArgs(),
      ];

      const { stderr } = await execFileAsync("pipelex", args, {
        encoding: "utf-8",
      });

      // pipelex can exit 0 without writing the file (e.g. render_output raises ValueError
      // and the CLI does `typer.Exit(0)` after printing the message to stderr). Surface
      // that diagnostic instead of an opaque ENOENT.
      if (!existsSync(outPath)) {
        throw new Error(
          `pipelex build output produced no file at ${outPath}.` +
            (stderr ? ` Output:\n${stderr.trim()}` : ""),
        );
      }
      const raw = readFileSync(outPath, "utf-8");

      const base = {
        is_valid: true as const,
        pipe_ref: pipeRef,
        ...(request.pipe_ref ? { requested_pipe_ref: request.pipe_ref } : {}),
        message: "Output representation generated via local CLI",
      };

      // Same two-field split as the API: 'python' is source text, the rest are objects.
      if (format === "python") {
        return { ...base, format, output_python: raw };
      }
      return { ...base, format, output: JSON.parse(raw) as Record<string, unknown> };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // pipelex build runner bundle <bundle.mthds> --pipe <ref> -o <file>
  async buildRunner(request: BuildRunnerRequest): Promise<BuildRunnerResponse> {
    // `pipelex build runner` has no --allow-signatures flag, so there is nothing to
    // forward. Silently dropping it would make the same request mean two different
    // things depending on the runner — the API would accept a closure with unresolved
    // signatures that we'd then reject. Say so instead of guessing.
    if (request.allow_signatures) {
      throw new Error(
        "allow_signatures is not supported by the local pipelex runner: " +
          "`pipelex build runner` exposes no --allow-signatures flag. Send this request " +
          "through an MthdsApiClient (the API runner) instead.",
      );
    }

    const tmp = makeTmpDir();
    try {
      const bundlePath = writeBuildFiles(tmp, request);
      const pipeRef = resolveQualifiedPipeRef(request.files ?? [], request.pipe_ref);

      const outPath = join(tmp, "runner.py");
      await this.execStreaming([
        "build",
        "runner",
        "bundle",
        bundlePath,
        "--pipe",
        pipeRef,
        "-o",
        outPath,
        "-L",
        tmp,
        ...this.libraryArgs(),
      ]);

      const pythonCode = readFileSync(outPath, "utf-8");
      const structures = readRunnerStructures(outPath);
      return {
        is_valid: true,
        pipe_ref: pipeRef,
        ...(request.pipe_ref ? { requested_pipe_ref: request.pipe_ref } : {}),
        python_code: pythonCode,
        ...(structures ? { structures } : {}),
        message: "Runner code generated via local CLI",
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── Spec-to-TOML ────────────────────────────────────────────────

  // pipelex-agent concept --spec <json>
  async concept(request: ConceptRequest): Promise<ConceptResponse> {
    const { stdout } = await execFileAsync(
      "pipelex-agent",
      ["concept", "--spec", JSON.stringify(request.spec)],
      { encoding: "utf-8" },
    );
    return {
      success: true,
      concept_code:
        extractSectionKey(stdout, "concept") ?? (request.spec.concept_code as string) ?? "",
      toml: stdout,
    };
  }

  // pipelex-agent pipe --type <type> --spec <json>
  async pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse> {
    const { stdout } = await execFileAsync(
      "pipelex-agent",
      ["pipe", "--type", request.pipe_type, "--spec", JSON.stringify(request.spec)],
      { encoding: "utf-8" },
    );
    return {
      success: true,
      pipe_code: extractSectionKey(stdout, "pipe") ?? (request.spec.pipe_code as string) ?? "",
      pipe_type: request.pipe_type,
      toml: stdout,
    };
  }

  // pipelex-agent check-model <reference> --type <type> --format json
  // check-model is a LOCAL CLI capability of this runner only — the Pipelex API
  // has no check-model route, so this method is NOT on the shared `Runner`
  // interface. The local runner always forces --format json: pipelex-agent's
  // markdown output is plain text (via print()), which can't satisfy the
  // CheckModelResponse contract. The request's `format` field is intentionally
  // ignored here. pipelex-agent declares --type as a required typer option (no
  // default), so we guard here for SDK consumers that bypass the agent CLI's parser.
  async checkModel(request: CheckModelRequest): Promise<CheckModelResponse> {
    if (!request.type) {
      throw new Error("checkModel requires `type` (one of: llm, extract, img_gen, search)");
    }
    const args = ["check-model", request.reference, "--type", request.type, "--format", "json"];
    const { stdout } = await execFileAsync("pipelex-agent", args, {
      encoding: "utf-8",
    });
    return JSON.parse(stdout) as CheckModelResponse;
  }

  // pipelex-agent models [--type <type>] --format json
  async models(category?: ModelCategory): Promise<ModelDeck> {
    const args = ["models"];
    if (category) {
      args.push("--type", category);
    }
    args.push("--format", "json");
    const { stdout } = await execFileAsync("pipelex-agent", args, {
      encoding: "utf-8",
    });
    return toModelDeck(JSON.parse(stdout));
  }

  // ── Method execution ────────────────────────────────────────────
  // pipelex run <target> [--pipe code] [--inputs file] [--output-dir dir]
  // Local, blocking, in-process — methods run through `execute`. There is no
  // durable run to poll by id; the async `start` primitive is unsupported (use
  // the API runner for that).

  async execute(options: RunOptions): Promise<DictRunResultExecute> {
    const tmp = makeTmpDir();
    try {
      // The pipelex CLI dispatches through `run bundle <path>` / `run pipe <code>`.
      const args: string[] = ["run"];

      if (options.files && Object.keys(options.files).length > 0) {
        // A full method bundle (custom PipeFunc Python travels with the method).
        // Materialize it to disk preserving `funcs/*.py`, then run the main
        // `.mthds` with the temp dir as its library so the funcs resolve.
        const bundlePath = materializeBundleFiles(tmp, options.files);
        args.push("bundle", bundlePath);
        args.push("-L", tmp);
        if (options.pipe_code) {
          args.push("--pipe", options.pipe_code);
        }
      } else if (options.mthds_contents?.length) {
        const bundlePath = writeMthdsContents(tmp, options.mthds_contents);
        args.push("bundle", bundlePath);
        args.push("-L", tmp);
        if (options.pipe_code) {
          args.push("--pipe", options.pipe_code);
        }
      } else if (options.pipe_code) {
        args.push("pipe", options.pipe_code);
      }

      if (options.inputs) {
        const inputsPath = join(tmp, "inputs.json");
        writeFileSync(inputsPath, JSON.stringify(options.inputs), "utf-8");
        args.push("--inputs", inputsPath);
      }

      // Pin the working-memory artifact to a known path; other outputs go to
      // an incremental directory under --output-dir which we don't need.
      const wmPath = join(tmp, "working_memory.json");
      args.push("--working-memory-path", wmPath);
      args.push("--output-dir", join(tmp, "results"));
      args.push("--no-pretty-print");

      await this.execStreaming(args);

      const raw = existsSync(wmPath)
        ? (JSON.parse(readFileSync(wmPath, "utf-8")) as Record<string, unknown>)
        : {};

      // The CLI writes the runtime's FULL working memory
      // (`{root: {name: {stuff_code, stuff_name, concept: {...}, content}}, aliases}`).
      // Reduce each stuff to the SDK wire shape `{concept: <ref string>, content}` —
      // the same reduction the API runner performs server-side. The runtime-internal
      // id keeps its `pipeline_run_id` name (D1: internals are out of the rename scope).
      const rawRoot = (raw["root"] ?? {}) as Record<string, Record<string, unknown>>;
      const aliases = (raw["aliases"] ?? {}) as Record<string, string>;
      const reducedRoot: Record<string, { concept: string; content: unknown }> = {};
      for (const [stuffName, stuff] of Object.entries(rawRoot)) {
        const conceptRaw = stuff["concept"];
        let conceptRefStr: string;
        if (conceptRaw && typeof conceptRaw === "object") {
          const conceptObj = conceptRaw as Record<string, unknown>;
          const code = typeof conceptObj["code"] === "string" ? conceptObj["code"] : "";
          const domainCode =
            typeof conceptObj["domain_code"] === "string" ? conceptObj["domain_code"] : "";
          // A missing domain_code falls back to the bare code (no leading dot).
          conceptRefStr = domainCode ? conceptRef({ domain_code: domainCode, code }) : code;
        } else {
          conceptRefStr = String(conceptRaw ?? "");
        }
        reducedRoot[stuffName] = { concept: conceptRefStr, content: stuff["content"] };
      }

      // `main_stuff_name` is a pipelex extension field riding the protocol's
      // extension-open response — not a protocol field.
      return {
        pipeline_run_id: "",
        pipe_output: {
          working_memory: { root: reducedRoot, aliases },
          pipeline_run_id: "",
        } as DictPipeOutput,
        main_stuff_name: aliases["main_stuff"] ?? "main_stuff",
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── Validation ──────────────────────────────────────────────────
  // pipelex validate bundle <bundle.mthds> [--allow-signatures]

  async validate(mthdsContents: string[], allowSignatures = false): Promise<ValidationResult> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = writeMthdsContents(tmp, mthdsContents);
      const args = ["validate", "bundle", bundlePath, "-L", tmp];
      if (allowSignatures) {
        args.push("--allow-signatures");
      }
      try {
        await this.exec(args);
      } catch (err) {
        const execError = err as Error & {
          code?: number | string;
          stderr?: string;
          stdout?: string;
        };
        const detail = execError.stderr?.trim() || execError.stdout?.trim() || execError.message;
        // The bare `pipelex validate` follows the 0/1/2 exit policy: exit 1 is a
        // produced negative verdict (the bundle is invalid), exit 2+ (or a spawn
        // failure, whose `code` is a string like "ENOENT") is a *no-verdict*
        // condition (setup / bad args / internal). A negative verdict is a result,
        // not a transport failure → return the minimal invalid arm (mirroring the
        // minimal valid arm below — the CLI emits human text, not structured
        // diagnostics, so validation_errors is empty). Re-raise everything else.
        if (execError.code === 1) {
          return {
            is_valid: false,
            validation_errors: [],
            pending_signatures: [],
            is_runnable: false,
            message: `Bundle validation failed:\n${detail}`,
          };
        }
        throw new Error(`Bundle validation failed:\n${detail}`);
      }
      // Exit 0 — a valid verdict. The CLI emits human-readable output, not the
      // structural artifacts, so return the minimal valid arm (the `is_valid: true`
      // discriminant), not the full report. (Per the protocol contract, a CLI
      // runner may return minimal discriminant arms.)
      return { is_valid: true };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── Async start (protocol primitive, unsupported locally) ──────────
  // The local pipelex CLI runs methods in-process and blocking via `execute`;
  // there is no durable run to start and poll by id, so the protocol's async
  // `start` primitive belongs to the Pipelex Hosted API (use --runner api).

  async start(_options: StartOptions): Promise<never> {
    throw new Error(ASYNC_START_UNSUPPORTED);
  }
}

const ASYNC_START_UNSUPPORTED =
  "Async start is not supported by the pipelex CLI runner — it runs methods in-process and blocking. Use `execute` (e.g. `mthds run`), or the API runner for durable start (--runner api).";

/**
 * Normalize the local CLI's models output into the protocol `ModelDeck`.
 *
 * Accepts the deck shape verbatim (`{ models, aliases, waterfalls }`) and maps
 * the legacy `pipelex-agent models` shape (`presets` / nested `aliases` /
 * nested `waterfalls`, keyed by category) by flattening it.
 */
function toModelDeck(parsed: unknown): ModelDeck {
  const root = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;

  if (Array.isArray(root.models)) {
    return {
      models: root.models as ModelInfo[],
      aliases: (root.aliases as Record<string, string> | undefined) ?? {},
      waterfalls: (root.waterfalls as Record<string, string[]> | undefined) ?? {},
    };
  }

  const models: ModelInfo[] = [];
  const presets = (root.presets ?? {}) as Record<string, Array<{ name: string }>>;
  for (const [category, entries] of Object.entries(presets)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && typeof entry.name === "string") {
        models.push({ name: entry.name, type: category as ModelInfo["type"] });
      }
    }
  }

  const aliases: Record<string, string> = {};
  const rawAliases = (root.aliases ?? {}) as Record<string, Record<string, string>>;
  for (const group of Object.values(rawAliases)) {
    if (group && typeof group === "object") Object.assign(aliases, group);
  }

  const waterfalls: Record<string, string[]> = {};
  const rawWaterfalls = (root.waterfalls ?? {}) as Record<string, Record<string, string[]>>;
  for (const group of Object.values(rawWaterfalls)) {
    if (group && typeof group === "object") Object.assign(waterfalls, group);
  }

  return { models, aliases, waterfalls };
}
