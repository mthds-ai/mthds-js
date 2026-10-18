/**
 * How `MthdsApiClient` sends a method's tree (mthds/docs/spec/protocol.md, "Method files" and
 * "Sending files by hash"): the wire shape of `files` on `/execute`, `/start`, `/validate` and
 * `/pipe-io`, the `/blobs/missing` exchange, the uploads, and the resend after a `422`
 * `request.blobs_missing` problem listing them in its `missing_blobs` parameter.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HANDSHAKE_TTL_MS, MthdsApiClient } from "../../../src/runners/api/client.js";
import {
  ApiResponseError,
  BlobUploadError,
  MalformedBlobsAnswerError,
  PipelineRequestError,
} from "../../../src/runners/api/exceptions.js";
import {
  INLINE_TREE_MAX_BYTES,
  forEachConcurrently,
} from "../../../src/runners/api/tree-sending.js";
import { EMPTY_METHOD_TREE_MESSAGE } from "../../../src/protocol/options.js";
import { listMethodTree } from "../../../src/method-tree/lister.js";
import { sha256Hex, treeDigest } from "../../../src/method-tree/digest.js";
import type { MethodTreeSource } from "../../../src/protocol/file_entries.js";
import { MTHDS_JS_VERSION } from "../../../src/version.js";

vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...original,
    findLegacyUrlKey: () => undefined,
    findLegacyApiKeyKey: () => undefined,
  };
});

const BASE_URL = "http://localhost:8081";
const STORE_URL = "https://bucket.example.com";

function makeClient(): MthdsApiClient {
  return new MthdsApiClient({
    baseUrl: BASE_URL,
    apiKey: "test-token",
    appInfo: { name: "tree-test", version: "1.0.0" },
  });
}

/** A tree held in memory, its hashes and digest computed as a lister computes them. */
function memoryTree(contents: Record<string, string | Uint8Array>): MethodTreeSource & {
  reads: string[];
} {
  const encoder = new TextEncoder();
  const bytesByPath = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(contents)) {
    bytesByPath.set(path, typeof content === "string" ? encoder.encode(content) : content);
  }
  const files = [...bytesByPath.entries()]
    .map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256Hex(bytes) }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  const reads: string[] = [];
  return {
    files,
    digest: treeDigest(files),
    reads,
    async readFile(treePath: string) {
      reads.push(treePath);
      const bytes = bytesByPath.get(treePath);
      if (bytes === undefined) throw new Error(`no file ${treePath}`);
      return bytes;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Route fetch by method and URL, recording every call with its parsed body. */
function routeFetch(handler: (call: Call) => Response | Promise<Response>): { calls: Call[] } {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the raw string
      }
    }
    const call = { method, url, headers, body };
    calls.push(call);
    return handler(call);
  });
  return { calls };
}

const NO_BLOB_STORE = { protocol_version: "1.0.0", runner_version: "0.88.0" };
const WITH_BLOB_STORE = { protocol_version: "1.0.0", blob_store: true };

/**
 * A tree past a limit, as the hosted platform refuses it (`pipelex-server` platform,
 * `MethodTreeTooLargeError`): its closed `code` and `type`, and the `limit` it reached.
 */
const PLATFORM_TREE_TOO_LARGE = {
  type: "https://pipelex.com/errors/method_tree_too_large",
  title: "Method tree too large",
  status: 422,
  code: "method_tree_too_large",
  detail: "The request's inline entries weigh 30 bytes, past this deployment's limit of 4 bytes.",
  instance: "urn:pipelex:request:req-1",
  request_id: "req-1",
  errors: [],
  error_domain: "input",
  retryable: false,
  limit: { name: "max_inline_bytes", value: 4, reached: 30 },
};

/**
 * A tree past a limit, as pipelex-api refuses it (`ensure_within_tree_limits`), and as the
 * platform relays it from the runner behind it: its `error_type` and the matching `type` URI.
 */
const RUNNER_TREE_TOO_LARGE = {
  type: "https://docs.pipelex.com/latest/errors/method-tree-too-large/",
  title: "Method tree too large",
  status: 422,
  detail: "The method's tree holds 30 bytes, past this runner's limit of 4 KiB for a method tree.",
  error_type: "MethodTreeTooLarge",
  error_domain: "input",
  retryable: false,
};

/**
 * A tree past a limit, as the runner refuses it in the problem shape (`ensure_within_tree_limits`):
 * `method.package_invalid` naming the rule and the limit it reached.
 */
const RUNNER_PACKAGE_TOO_LARGE = {
  type: "https://mthds.ai/errors/method.package_invalid",
  title: "The method's package breaks a package rule",
  status: 422,
  detail: "The method's tree holds 30 bytes, past this runner's limit of 4 KiB for a method tree.",
  code: "method.package_invalid",
  domain: "method",
  retry: "no",
  next_step: { kind: "fix_method", detail: "Make the method's tree smaller." },
  params: { reason: "tree_too_large", limit: 4096 },
};

/** The runner's refusal of a request naming blobs it does not hold, `request.blobs_missing`. */
function blobsMissing(hashes: readonly string[]): Record<string, unknown> {
  return {
    type: "https://mthds.ai/errors/request.blobs_missing",
    title: "The runner does not hold some files sent by hash",
    status: 422,
    detail: "The runner does not hold every blob the request names.",
    code: "request.blobs_missing",
    domain: "input",
    retry: "no",
    next_step: { kind: "change_input", detail: "Upload the missing blobs, then send again." },
    params: { missing_blobs: [...hashes] },
  };
}

function bigText(label: string): string {
  return `# ${label}\n` + "x".repeat(INLINE_TREE_MAX_BYTES);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sending a tree inline", () => {
  it("sends the whole tree inline to a runner without a blob store, text as text and other bytes in Base64", async () => {
    const tree = memoryTree({
      "bundle.mthds": "domain = 'x'\nmain_pipe = 'run'\n",
      "funcs/f.py": "def f(): ...\n",
      "images/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]),
    });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, NO_BLOB_STORE)
        : jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} }),
    );
    await makeClient().execute({ tree, pipe_code: "run" });

    const execute = calls.find((call) => call.url === `${BASE_URL}/v1/execute`)!;
    expect(execute.body).toEqual({
      pipe_code: "run",
      files: {
        "bundle.mthds": "domain = 'x'\nmain_pipe = 'run'\n",
        "funcs/f.py": "def f(): ...\n",
        "images/logo.png": { base64: "iVBOR/8A" },
      },
    });
    expect(calls.some((call) => call.url.includes("/blobs/"))).toBe(false);
  });

  it("never sends the client-only tree, nor the retired mthds_contents and bundle_b64", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'" });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, NO_BLOB_STORE)
        : jsonResponse(202, { pipeline_run_id: "r" }),
    );
    await makeClient().start({ tree, bundleMain: "bundle.mthds" });
    const body = calls.find((call) => call.url === `${BASE_URL}/v1/start`)!.body as Record<
      string,
      unknown
    >;
    expect(Object.keys(body)).toEqual(["files"]);
  });

  it("sends a small tree inline to a runner with a blob store", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "templates/t.html": "<p/>" });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, WITH_BLOB_STORE)
        : jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} }),
    );
    await makeClient().execute({ tree });
    const execute = calls.find((call) => call.url === `${BASE_URL}/v1/execute`)!;
    expect((execute.body as { files: unknown }).files).toEqual({
      "bundle.mthds": "domain = 'x'",
      "templates/t.html": "<p/>",
    });
    expect(calls.some((call) => call.url.includes("/blobs/"))).toBe(false);
  });

  it("sends a small tree by hash when its inline map passes the runner's announced inline limit", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'" });
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) {
        return jsonResponse(200, {
          ...WITH_BLOB_STORE,
          limits: { method_tree: { max_inline_bytes: 4 } },
        });
      }
      if (call.url.endsWith("/v1/blobs/missing")) return jsonResponse(200, { missing: [] });
      return jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} });
    });
    await makeClient().execute({ tree });
    const execute = calls.find((call) => call.url === `${BASE_URL}/v1/execute`)!;
    expect((execute.body as { files: unknown }).files).toEqual({
      "bundle.mthds": { sha256: tree.files[0]!.sha256, size: 12 },
    });
  });

  it("asks the runner's handshake once for a client's lifetime", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'" });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, NO_BLOB_STORE)
        : jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} }),
    );
    const client = makeClient();
    await client.methodTreeLimits();
    await client.execute({ tree });
    await client.execute({ tree });
    expect(calls.filter((call) => call.url.endsWith("/v1/version"))).toHaveLength(1);
  });

  it("sends a file named __proto__ as a file like any other", async () => {
    // A computed key, since a literal `__proto__:` would set the prototype instead.
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", ["__proto__"]: "data" });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, NO_BLOB_STORE)
        : jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} }),
    );
    await makeClient().execute({ tree });
    const raw = (vi.mocked(globalThis.fetch).mock.calls.at(-1)![1] as RequestInit).body as string;
    expect(raw).toContain('"__proto__":"data"');
    expect(calls).toHaveLength(2);
  });
});

describe("sending a tree by hash", () => {
  const STORE_HEADERS = {
    "If-None-Match": "*",
    "Content-Type": "application/octet-stream",
    "x-amz-checksum-sha256": "c2lnbmVk",
  };

  it("asks /v1/blobs/missing with the digest, uploads what is missing with exactly its headers, then sends hash entries", async () => {
    const shared = bigText("shared");
    const tree = memoryTree({
      "bundle.mthds": "domain = 'x'",
      "data/a.txt": shared,
      "data/b.txt": shared,
      "data/c.txt": bigText("c"),
    });
    const sha = (path: string): string => tree.files.find((file) => file.path === path)!.sha256;
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) {
        return jsonResponse(200, {
          missing: [
            {
              sha256: sha("data/a.txt"),
              size: shared.length + 0,
              upload: {
                method: "PUT",
                url: `${STORE_URL}/k1?X-Amz-Signature=secret`,
                headers: STORE_HEADERS,
              },
            },
            {
              sha256: sha("data/c.txt"),
              size: tree.files.find((file) => file.path === "data/c.txt")!.size,
              upload: {
                method: "PUT",
                url: `${BASE_URL}/v1/blobs/${sha("data/c.txt")}?sig=s`,
                headers: { "content-type": "application/octet-stream" },
              },
            },
          ],
        });
      }
      if (call.method === "PUT") return new Response(null, { status: 204 });
      return jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} });
    });

    await makeClient().execute({ tree, pipe_code: "run" });

    const missing = calls.find((call) => call.url === `${BASE_URL}/v1/blobs/missing`)!;
    expect(missing.method).toBe("POST");
    expect(missing.body).toEqual({
      digest: tree.digest,
      blobs: [
        { sha256: sha("bundle.mthds"), size: 12 },
        { sha256: sha("data/a.txt"), size: tree.files[1]!.size },
        { sha256: sha("data/c.txt"), size: tree.files[3]!.size },
      ],
    });

    const toStore = calls.find((call) => call.url.startsWith(STORE_URL))!;
    expect(toStore.method).toBe("PUT");
    // A third party's object store gets exactly the target's headers: no credential, no User-Agent.
    expect(toStore.headers).toEqual(STORE_HEADERS);
    expect(new TextDecoder().decode(toStore.body as Uint8Array)).toBe(shared);

    const toRunner = calls.find((call) =>
      call.url.startsWith(`${BASE_URL}/v1/blobs/${sha("data/c.txt")}`),
    )!;
    expect(toRunner.method).toBe("PUT");
    expect(toRunner.headers["content-type"]).toBe("application/octet-stream");
    expect(toRunner.headers["User-Agent"]).toMatch(
      new RegExp(`^tree-test/1\\.0\\.0 mthds-js/${MTHDS_JS_VERSION.replace(/\./g, "\\.")} `),
    );
    expect(toRunner.headers["Authorization"]).toBeUndefined();

    const execute = calls.find((call) => call.url === `${BASE_URL}/v1/execute`)!;
    expect(execute.body).toEqual({
      pipe_code: "run",
      files: Object.fromEntries(
        tree.files.map((file) => [file.path, { sha256: file.sha256, size: file.size }]),
      ),
    });
    // Each upload precedes the request naming it.
    expect(calls.indexOf(execute)).toBeGreaterThan(calls.indexOf(toStore));
    expect(calls.indexOf(execute)).toBeGreaterThan(calls.indexOf(toRunner));
  });

  it("weighs the threshold as the request spends it: a binary tree under 256 KiB whose Base64 passes it goes by hash", async () => {
    const binary = new Uint8Array(250 * 1024).fill(0xff);
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "model.bin": binary });
    expect(tree.files.reduce((total, file) => total + file.size, 0)).toBeLessThan(
      INLINE_TREE_MAX_BYTES,
    );
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) return jsonResponse(200, { missing: [] });
      return jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} });
    });
    await makeClient().execute({ tree });
    const execute = calls.find((call) => call.url === `${BASE_URL}/v1/execute`)!;
    expect((execute.body as { files: Record<string, unknown> }).files["model.bin"]).toEqual({
      sha256: tree.files.find((file) => file.path === "model.bin")!.sha256,
      size: binary.length,
    });
  });

  it("does not read a tree whose files alone pass the threshold before asking which blobs are missing", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": bigText("big") });
    routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) return jsonResponse(200, { missing: [] });
      return jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} });
    });
    await makeClient().execute({ tree });
    expect(tree.reads).toEqual([]);
  });

  it("uploads nothing when the runner holds every blob", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": bigText("big") });
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) return jsonResponse(200, { missing: [] });
      return jsonResponse(202, { pipeline_run_id: "r" });
    });
    await makeClient().start({ tree });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${BASE_URL}/v1/version`,
      `POST ${BASE_URL}/v1/blobs/missing`,
      `POST ${BASE_URL}/v1/start`,
    ]);
    expect(tree.reads).toEqual([]);
  });

  it("counts a 412 on an upload as uploaded, the bytes being held already", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": bigText("big") });
    const big = tree.files.find((file) => file.path === "big.txt")!;
    routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) {
        return jsonResponse(200, {
          missing: [{ ...big, upload: { method: "PUT", url: `${STORE_URL}/k`, headers: {} } }],
        });
      }
      if (call.method === "PUT") return new Response("PreconditionFailed", { status: 412 });
      return jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} });
    });
    await expect(makeClient().execute({ tree })).resolves.toMatchObject({ pipeline_run_id: "r" });
  });

  it("refuses a failed upload with a BlobUploadError that never carries the signed URL", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": bigText("big") });
    const big = tree.files.find((file) => file.path === "big.txt")!;
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) {
        return jsonResponse(200, {
          missing: [
            {
              ...big,
              upload: { method: "PUT", url: `${STORE_URL}/k?X-Amz-Signature=secret`, headers: {} },
            },
          ],
        });
      }
      return new Response("AccessDenied", { status: 403, statusText: "Forbidden" });
    });
    const error = await makeClient()
      .execute({ tree })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BlobUploadError);
    const upload = error as BlobUploadError;
    expect(upload.status).toBe(403);
    expect(upload.sha256).toBe(big.sha256);
    expect(upload.host).toBe("bucket.example.com");
    expect(upload.message).not.toContain("secret");
    expect(calls.some((call) => call.url.endsWith("/v1/execute"))).toBe(false);
  });

  it("keeps nothing of an unreachable target's URL, its query and credentials included", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": bigText("big") });
    const big = tree.files.find((file) => file.path === "big.txt")!;
    const signedUrl = "https://user:hunter2@bucket.example.com/k?X-Amz-Signature=secret#frag";
    routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) {
        return jsonResponse(200, {
          missing: [{ ...big, upload: { method: "PUT", url: signedUrl, headers: {} } }],
        });
      }
      // What fetch itself throws for such a URL: its message quotes the URL whole.
      throw new TypeError(
        `Request cannot be constructed from a URL that includes credentials: ${signedUrl}`,
      );
    });
    const error = (await makeClient()
      .execute({ tree })
      .catch((err: unknown) => err)) as BlobUploadError;
    expect(error).toBeInstanceOf(BlobUploadError);
    expect(error.host).toBe("bucket.example.com");
    expect(error.status).toBeUndefined();
    expect(error.cause).toBeUndefined();
    const kept = JSON.stringify({ ...error, message: error.message, stack: error.stack });
    for (const secret of ["hunter2", "user:", "X-Amz-Signature", "secret", "frag"]) {
      expect(kept).not.toContain(secret);
    }
  });

  it("answers a 422 naming missing_blobs by uploading them and resending once", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": bigText("big") });
    const big = tree.files.find((file) => file.path === "big.txt")!;
    let executes = 0;
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) {
        const body = call.body as { digest?: string };
        // The check before the run says all is held; the one after the 422 names the dropped blob.
        return jsonResponse(200, {
          missing:
            body.digest === undefined
              ? [{ ...big, upload: { method: "PUT", url: `${STORE_URL}/k`, headers: {} } }]
              : [],
        });
      }
      if (call.method === "PUT") return new Response(null, { status: 200 });
      executes += 1;
      return executes === 1
        ? jsonResponse(422, blobsMissing([big.sha256]))
        : jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} });
    });

    await expect(makeClient().execute({ tree })).resolves.toMatchObject({ pipeline_run_id: "r" });

    const asks = calls.filter((call) => call.url.endsWith("/v1/blobs/missing"));
    expect(asks).toHaveLength(2);
    expect(asks[1]!.body).toEqual({ blobs: [{ sha256: big.sha256, size: big.size }] });
    const sends = calls.filter((call) => call.url.endsWith("/v1/execute"));
    expect(sends).toHaveLength(2);
    expect(sends[1]!.body).toEqual(sends[0]!.body);
  });

  it("gives up after one resend, leaving the request.blobs_missing problem on the ApiResponseError", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": bigText("big") });
    const big = tree.files.find((file) => file.path === "big.txt")!;
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) return jsonResponse(200, { missing: [] });
      return jsonResponse(422, blobsMissing([big.sha256]));
    });
    const error = await makeClient()
      .validate({ tree })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as ApiResponseError).problem).toMatchObject({
      code: "request.blobs_missing",
      params: { missing_blobs: [big.sha256] },
    });
    expect(calls.filter((call) => call.url.endsWith("/v1/validate"))).toHaveLength(2);
  });

  it("does not resend a caller's own files map, whose bytes it does not hold", async () => {
    const hash = "a".repeat(64);
    const { calls } = routeFetch(() => jsonResponse(422, blobsMissing([hash])));
    const error = await makeClient()
      .execute({ files: { "bundle.mthds": { sha256: hash, size: 3 } } })
      .catch((err: unknown) => err);
    expect((error as ApiResponseError).problem).toMatchObject({
      code: "request.blobs_missing",
      params: { missing_blobs: [hash] },
    });
    expect(calls).toHaveLength(1);
  });
});

describe("validate sends the method's tree", () => {
  it("posts files, allow_signatures and the markdown render, and nothing of the retired shape", async () => {
    const tree = memoryTree({ "METHODS.toml": "[package]\n", "bundle.mthds": "domain = 'x'" });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, NO_BLOB_STORE)
        : jsonResponse(200, { is_valid: true }),
    );
    await makeClient().validate({ tree }, true);
    const validate = calls.find((call) => call.url === `${BASE_URL}/v1/validate`)!;
    expect(validate.body).toEqual({
      files: { "METHODS.toml": "[package]\n", "bundle.mthds": "domain = 'x'" },
      allow_signatures: true,
      render: ["markdown"],
    });
  });

  it("posts a caller's files map as given, without a handshake", async () => {
    const { calls } = routeFetch(() => jsonResponse(200, { is_valid: true }));
    await makeClient().validate({ files: { "bundle.mthds": "domain = 'x'" } }, false, ["html"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      files: { "bundle.mthds": "domain = 'x'" },
      allow_signatures: false,
      render: ["html", "markdown"],
    });
  });

  it("refuses an empty tree before anything is sent", async () => {
    const { calls } = routeFetch(() => jsonResponse(200, { is_valid: true }));
    await expect(makeClient().validate({ files: {} })).rejects.toBeInstanceOf(PipelineRequestError);
    expect(calls).toHaveLength(0);
  });
});

describe("pipeIo sends the method's tree", () => {
  const PIPE_IO_VALID = {
    is_valid: true,
    pipe_ref: "x.run",
    pipe_io_contracts: {},
    input_form: { "x.run": { fields: [] } },
    output_form: {},
    default_pipe_ref: "x.run",
    pending_signatures: [],
    is_runnable: true,
  };

  it("sends a small tree inline beside the pipe selector, and never the tree itself", async () => {
    const tree = memoryTree({
      "bundle.mthds": "domain = 'x'\nmain_pipe = 'run'\n",
      "images/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]),
    });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, NO_BLOB_STORE)
        : jsonResponse(200, PIPE_IO_VALID),
    );
    await makeClient().pipeIo({ tree, pipe_ref: "x.run", include_files: true });
    const pipeIo = calls.find((call) => call.url === `${BASE_URL}/v1/pipe-io`)!;
    expect(pipeIo.body).toEqual({
      files: {
        "bundle.mthds": "domain = 'x'\nmain_pipe = 'run'\n",
        "images/logo.png": { base64: "iVBOR/8A" },
      },
      pipe_ref: "x.run",
      include_files: true,
    });
  });

  it("sends a large tree by hash, uploading what the runner lacks first", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "data/big.txt": bigText("big") });
    const big = tree.files.find((file) => file.path === "data/big.txt")!;
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) {
        return jsonResponse(200, {
          missing: [
            {
              sha256: big.sha256,
              size: big.size,
              upload: { method: "PUT", url: `${STORE_URL}/k?sig=s`, headers: {} },
            },
          ],
        });
      }
      if (call.method === "PUT") return new Response(null, { status: 204 });
      return jsonResponse(200, PIPE_IO_VALID);
    });
    await makeClient().pipeIo({ tree, read_scope: "org/acme" });
    const upload = calls.find((call) => call.method === "PUT")!;
    const pipeIo = calls.find((call) => call.url === `${BASE_URL}/v1/pipe-io`)!;
    expect(calls.indexOf(pipeIo)).toBeGreaterThan(calls.indexOf(upload));
    expect(pipeIo.body).toEqual({
      files: Object.fromEntries(
        tree.files.map((file) => [file.path, { sha256: file.sha256, size: file.size }]),
      ),
      read_scope: "org/acme",
    });
  });

  it("prepares a tree refused as too large again on a fresh handshake and sends it once more", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'" });
    let versions = 0;
    let reads = 0;
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) {
        versions += 1;
        return jsonResponse(
          200,
          versions === 1
            ? WITH_BLOB_STORE
            : { ...WITH_BLOB_STORE, limits: { method_tree: { max_inline_bytes: 4 } } },
        );
      }
      if (call.url.endsWith("/v1/blobs/missing")) return jsonResponse(200, { missing: [] });
      reads += 1;
      return reads === 1
        ? jsonResponse(422, RUNNER_TREE_TOO_LARGE)
        : jsonResponse(200, PIPE_IO_VALID);
    });
    await expect(makeClient().pipeIo({ tree })).resolves.toMatchObject({ is_valid: true });
    const sends = calls.filter((call) => call.url.endsWith("/v1/pipe-io"));
    expect(sends).toHaveLength(2);
    expect((sends[1]!.body as { files: unknown }).files).toEqual({
      "bundle.mthds": { sha256: tree.files[0]!.sha256, size: 12 },
    });
  });

  it("refuses an empty tree before anything is sent", async () => {
    const { calls } = routeFetch(() => jsonResponse(200, PIPE_IO_VALID));
    await expect(makeClient().pipeIo({ tree: memoryTree({}) })).rejects.toThrow(
      EMPTY_METHOD_TREE_MESSAGE,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("the method's source on a run", () => {
  it("refuses files and tree together before anything is sent", async () => {
    const { calls } = routeFetch(() => jsonResponse(200, {}));
    await expect(
      makeClient().execute({
        files: { "bundle.mthds": "domain = 'x'" },
        tree: memoryTree({ "bundle.mthds": "domain = 'x'" }),
      }),
    ).rejects.toBeInstanceOf(PipelineRequestError);
    expect(calls).toHaveLength(0);
  });

  it("takes a tree alone as something to run", async () => {
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, NO_BLOB_STORE)
        : jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} }),
    );
    await makeClient().execute({ tree: memoryTree({ "bundle.mthds": "domain = 'x'" }) });
    expect(calls.some((call) => call.url.endsWith("/v1/execute"))).toBe(true);
  });

  it("sends a listed MethodTree as it sends any tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mthds-tree-send-"));
    try {
      mkdirSync(join(dir, "funcs"));
      writeFileSync(join(dir, "bundle.mthds"), "domain = 'x'\n");
      writeFileSync(join(dir, "funcs", "f.py"), "def f(): ...\n");
      const tree = await listMethodTree(dir);
      const { calls } = routeFetch((call) =>
        call.url.endsWith("/v1/version")
          ? jsonResponse(200, NO_BLOB_STORE)
          : jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} }),
      );
      await makeClient().execute({ tree });
      expect((calls.at(-1)!.body as { files: unknown }).files).toEqual({
        "bundle.mthds": "domain = 'x'\n",
        "funcs/f.py": "def f(): ...\n",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MthdsApiClient.methodTreeLimits", () => {
  it("maps the announced limits.method_tree onto the lister's limits", async () => {
    routeFetch(() =>
      jsonResponse(200, {
        ...WITH_BLOB_STORE,
        limits: {
          method_tree: {
            max_files: 1000,
            max_file_bytes: 33554432,
            max_total_bytes: 67108864,
            max_inline_bytes: 7340032,
          },
        },
      }),
    );
    await expect(makeClient().methodTreeLimits()).resolves.toEqual({
      maxFileCount: 1000,
      maxFileSize: 33554432,
      maxTotalSize: 67108864,
    });
  });

  it("assumes no limit a runner does not announce, and ignores a malformed one", async () => {
    routeFetch(() =>
      jsonResponse(200, {
        ...NO_BLOB_STORE,
        limits: { method_tree: { max_files: "1000", max_file_bytes: -1, max_total_bytes: 12 } },
      }),
    );
    await expect(makeClient().methodTreeLimits()).resolves.toEqual({ maxTotalSize: 12 });
  });

  it("is empty for a runner announcing no limits", async () => {
    routeFetch(() => jsonResponse(200, NO_BLOB_STORE));
    await expect(makeClient().methodTreeLimits()).resolves.toEqual({});
  });
});

describe("uploads stop at the first failure", () => {
  it("starts no further item and aborts the ones in flight once one fails", async () => {
    const started: number[] = [];
    const aborted: number[] = [];
    const failure = new Error("first");
    const items = Array.from({ length: 10 }, (_, index) => index);
    const run = forEachConcurrently(items, 3, async (item, signal) => {
      started.push(item);
      if (item === 0) {
        await Promise.resolve();
        throw failure;
      }
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted.push(item);
          reject(new Error("aborted"));
        });
      });
    });
    await expect(run).rejects.toBe(failure);
    expect(started).toEqual([0, 1, 2]);
    expect(aborted.sort()).toEqual([1, 2]);
  });

  it("aborts a tree's in-flight uploads and raises the first failure, sending no request", async () => {
    const tree = memoryTree(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [`data/${index}.txt`, bigText(String(index))]),
      ),
    );
    const calls: string[] = [];
    const abortedUploads: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (url.endsWith("/v1/blobs/missing")) {
        return jsonResponse(200, {
          missing: tree.files.map((file, index) => ({
            sha256: file.sha256,
            size: file.size,
            upload: { method: "PUT", url: `${STORE_URL}/k${index}`, headers: {} },
          })),
        });
      }
      if (url === `${STORE_URL}/k0`) return new Response("AccessDenied", { status: 403 });
      // Every other upload hangs until it is aborted.
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => {
          abortedUploads.push(url);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const error = await makeClient()
      .execute({ tree })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BlobUploadError);
    expect((error as BlobUploadError).status).toBe(403);
    const puts = calls.filter((call) => call.startsWith("PUT "));
    expect(puts.length).toBeLessThan(tree.files.length);
    expect(abortedUploads.sort()).toEqual(
      puts
        .map((call) => call.slice("PUT ".length))
        .filter((url) => !url.endsWith("/k0"))
        .sort(),
    );
    expect(calls.some((call) => call.endsWith("/v1/execute"))).toBe(false);
  });
});

describe("the kept handshake", () => {
  it("is asked again once HANDSHAKE_TTL_MS has passed", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'" });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, NO_BLOB_STORE)
        : jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} }),
    );
    const client = makeClient();
    await client.execute({ tree });
    now += HANDSHAKE_TTL_MS - 1;
    await client.execute({ tree });
    expect(calls.filter((call) => call.url.endsWith("/v1/version"))).toHaveLength(1);
    now += 1;
    await client.execute({ tree });
    expect(calls.filter((call) => call.url.endsWith("/v1/version"))).toHaveLength(2);
  });

  it("is dropped when /v1/blobs/missing answers 404, and the tree prepared again on a fresh one", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": bigText("big") });
    let versions = 0;
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) {
        versions += 1;
        return jsonResponse(200, versions === 1 ? WITH_BLOB_STORE : NO_BLOB_STORE);
      }
      if (call.url.endsWith("/v1/blobs/missing")) return jsonResponse(404, { detail: "Not Found" });
      return jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} });
    });
    await makeClient().execute({ tree });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${BASE_URL}/v1/version`,
      `POST ${BASE_URL}/v1/blobs/missing`,
      `GET ${BASE_URL}/v1/version`,
      `POST ${BASE_URL}/v1/execute`,
    ]);
    expect((calls.at(-1)!.body as { files: Record<string, unknown> }).files["big.txt"]).toBe(
      bigText("big"),
    );
  });

  it("retries a 404 from /v1/blobs/missing once, then raises it", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": bigText("big") });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, WITH_BLOB_STORE)
        : jsonResponse(404, { detail: "Not Found" }),
    );
    const error = await makeClient()
      .execute({ tree })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as ApiResponseError).status).toBe(404);
    expect(calls.filter((call) => call.url.endsWith("/v1/version"))).toHaveLength(2);
    expect(calls.filter((call) => call.url.endsWith("/v1/blobs/missing"))).toHaveLength(2);
  });

  it.each([
    ["the hosted platform's", PLATFORM_TREE_TOO_LARGE],
    ["pipelex-api's", RUNNER_TREE_TOO_LARGE],
    ["the runner's method.package_invalid", RUNNER_PACKAGE_TOO_LARGE],
  ])(
    "is dropped when a run refuses the tree with %s refusal, and the tree sent once more as fresh limits say",
    async (_runner, refusal) => {
      const tree = memoryTree({ "bundle.mthds": "domain = 'x'" });
      let versions = 0;
      let executes = 0;
      const { calls } = routeFetch((call) => {
        if (call.url.endsWith("/v1/version")) {
          versions += 1;
          return jsonResponse(
            200,
            versions === 1
              ? WITH_BLOB_STORE
              : { ...WITH_BLOB_STORE, limits: { method_tree: { max_inline_bytes: 4 } } },
          );
        }
        if (call.url.endsWith("/v1/blobs/missing")) return jsonResponse(200, { missing: [] });
        executes += 1;
        return executes === 1
          ? jsonResponse(422, refusal)
          : jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} });
      });
      await expect(makeClient().execute({ tree })).resolves.toMatchObject({
        pipeline_run_id: "r",
      });
      const sends = calls.filter((call) => call.url.endsWith("/v1/execute"));
      expect(sends).toHaveLength(2);
      expect((sends[0]!.body as { files: unknown }).files).toEqual({
        "bundle.mthds": "domain = 'x'",
      });
      expect((sends[1]!.body as { files: unknown }).files).toEqual({
        "bundle.mthds": { sha256: tree.files[0]!.sha256, size: 12 },
      });
      expect(calls.filter((call) => call.url.endsWith("/v1/version"))).toHaveLength(2);
    },
  );

  it.each([
    ["the hosted platform's", PLATFORM_TREE_TOO_LARGE],
    ["pipelex-api's", RUNNER_TREE_TOO_LARGE],
    ["the runner's method.package_invalid", RUNNER_PACKAGE_TOO_LARGE],
  ])(
    "gives validate the same retry when it refuses the tree with %s refusal",
    async (_runner, refusal) => {
      const tree = memoryTree({ "bundle.mthds": "domain = 'x'" });
      let versions = 0;
      let validations = 0;
      const { calls } = routeFetch((call) => {
        if (call.url.endsWith("/v1/version")) {
          versions += 1;
          return jsonResponse(
            200,
            versions === 1
              ? WITH_BLOB_STORE
              : { ...WITH_BLOB_STORE, limits: { method_tree: { max_inline_bytes: 4 } } },
          );
        }
        if (call.url.endsWith("/v1/blobs/missing")) return jsonResponse(200, { missing: [] });
        validations += 1;
        return validations === 1
          ? jsonResponse(422, refusal)
          : jsonResponse(200, { is_valid: true });
      });
      await expect(makeClient().validate({ tree })).resolves.toMatchObject({ is_valid: true });
      const sends = calls.filter((call) => call.url.endsWith("/v1/validate"));
      expect(sends).toHaveLength(2);
      expect((sends[1]!.body as { files: unknown }).files).toEqual({
        "bundle.mthds": { sha256: tree.files[0]!.sha256, size: 12 },
      });
      expect(calls.filter((call) => call.url.endsWith("/v1/version"))).toHaveLength(2);
    },
  );

  it("does not take another 422 for a refusal of the tree as too large", async () => {
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, NO_BLOB_STORE)
        : jsonResponse(422, {
            type: "https://pipelex.com/errors/invalid_method_files",
            title: "Invalid method files",
            status: 422,
            code: "invalid_method_files",
            error_type: "InvalidMethodFiles",
          }),
    );
    await expect(
      makeClient().execute({ tree: memoryTree({ "bundle.mthds": "domain = 'x'" }) }),
    ).rejects.toBeInstanceOf(ApiResponseError);
    expect(calls.filter((call) => call.url.endsWith("/v1/execute"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/v1/version"))).toHaveLength(1);
  });

  it("sends a tree refused as too large once more only, and never resends a caller's files map", async () => {
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, NO_BLOB_STORE)
        : jsonResponse(422, PLATFORM_TREE_TOO_LARGE),
    );
    const client = makeClient();
    await expect(
      client.execute({ tree: memoryTree({ "bundle.mthds": "domain = 'x'" }) }),
    ).rejects.toBeInstanceOf(ApiResponseError);
    expect(calls.filter((call) => call.url.endsWith("/v1/execute"))).toHaveLength(2);

    calls.length = 0;
    await expect(
      client.execute({ files: { "bundle.mthds": "domain = 'x'" } }),
    ).rejects.toBeInstanceOf(ApiResponseError);
    expect(calls.filter((call) => call.url.endsWith("/v1/execute"))).toHaveLength(1);
  });
});

describe("a runner with no blob store and an inline limit", () => {
  const limited = (maxInlineBytes: number): unknown => ({
    ...NO_BLOB_STORE,
    limits: { method_tree: { max_inline_bytes: maxInlineBytes } },
  });

  it("refuses a tree whose files alone pass the limit before reading it, naming the limit", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": "y".repeat(64) });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version") ? jsonResponse(200, limited(32)) : jsonResponse(200, {}),
    );
    const error = await makeClient()
      .execute({ tree })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PipelineRequestError);
    expect((error as Error).message).toContain("max_inline_bytes of 32 bytes");
    expect(tree.reads).toEqual([]);
    expect(calls.some((call) => call.url.endsWith("/v1/execute"))).toBe(false);
  });

  it("refuses a tree whose files fit but whose inline map passes the limit, reading each file once", async () => {
    const binary = new Uint8Array(30).fill(0xff);
    const tree = memoryTree({ "model.bin": binary });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version") ? jsonResponse(200, limited(32)) : jsonResponse(200, {}),
    );
    const error = await makeClient()
      .execute({ tree })
      .catch((err: unknown) => err);
    expect((error as Error).message).toMatch(
      /inline map weighs \d+ bytes, more than its inline limit max_inline_bytes of 32 bytes/,
    );
    expect(tree.reads).toEqual(["model.bin"]);
    expect(calls.some((call) => call.url.endsWith("/v1/execute"))).toBe(false);
  });

  it("sends a tree within the limit inline", async () => {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'" });
    const { calls } = routeFetch((call) =>
      call.url.endsWith("/v1/version")
        ? jsonResponse(200, limited(1024))
        : jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} }),
    );
    await makeClient().execute({ tree });
    expect((calls.at(-1)!.body as { files: unknown }).files).toEqual({
      "bundle.mthds": "domain = 'x'",
    });
  });
});

describe("a file is read once per request", () => {
  it("uploads from the bytes read to weigh the inline map", async () => {
    const binary = new Uint8Array(250 * 1024).fill(0xff);
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "model.bin": binary });
    const model = tree.files.find((file) => file.path === "model.bin")!;
    let uploaded: Uint8Array | undefined;
    routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) {
        return jsonResponse(200, {
          missing: [{ ...model, upload: { method: "PUT", url: `${STORE_URL}/k`, headers: {} } }],
        });
      }
      if (call.method === "PUT") {
        uploaded = call.body as Uint8Array;
        return new Response(null, { status: 200 });
      }
      return jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} });
    });
    await makeClient().execute({ tree });
    expect(uploaded?.length).toBe(binary.length);
    expect([...tree.reads].sort()).toEqual(["bundle.mthds", "model.bin"]);
  });
});

describe("an empty tree", () => {
  it.each([
    ["execute", (client: MthdsApiClient) => client.execute({ pipe_code: "p", files: {} })],
    ["start", (client: MthdsApiClient) => client.start({ pipe_code: "p", files: {} })],
    ["validate", (client: MthdsApiClient) => client.validate({ files: {} })],
    [
      "execute with a tree",
      (client: MthdsApiClient) => client.execute({ pipe_code: "p", tree: memoryTree({}) }),
    ],
    ["prepareMethodFiles", (client: MthdsApiClient) => client.prepareMethodFiles(memoryTree({}))],
  ])("is refused by %s with one message, sending nothing", async (_name, call) => {
    const { calls } = routeFetch(() => jsonResponse(200, NO_BLOB_STORE));
    await expect(call(makeClient())).rejects.toThrow(EMPTY_METHOD_TREE_MESSAGE);
    expect(calls).toHaveLength(0);
  });
});

describe("a malformed /v1/blobs/missing answer", () => {
  const goodUpload = { method: "PUT", url: `${STORE_URL}/k?X-Amz-Signature=secret`, headers: {} };

  async function refusal(missing: unknown): Promise<MalformedBlobsAnswerError> {
    const tree = memoryTree({ "bundle.mthds": "domain = 'x'", "big.txt": bigText("big") });
    const { calls } = routeFetch((call) => {
      if (call.url.endsWith("/v1/version")) return jsonResponse(200, WITH_BLOB_STORE);
      if (call.url.endsWith("/v1/blobs/missing")) return jsonResponse(200, missing);
      return jsonResponse(200, { pipeline_run_id: "r", pipe_output: {} });
    });
    const error = await makeClient()
      .execute({ tree })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MalformedBlobsAnswerError);
    expect(calls.some((call) => call.method === "PUT" || call.url.endsWith("/v1/execute"))).toBe(
      false,
    );
    return error as MalformedBlobsAnswerError;
  }

  it("names the index of an entry whose sha256 is malformed", async () => {
    const error = await refusal({ missing: [{ sha256: "XYZ", size: 3, upload: goodUpload }] });
    expect(error.index).toBe(0);
    expect(error.sha256).toBeUndefined();
    expect(error.message).toContain("missing[0]");
    expect(error.message).toContain("sha256");
  });

  it.each([
    ["a negative size", { size: -1 }, "size"],
    ["no upload", { upload: undefined }, "upload object"],
    ["an empty method", { upload: { ...goodUpload, method: "" } }, "upload.method"],
    ["a URL that does not parse", { upload: { ...goodUpload, url: "not a url" } }, "upload.url"],
    [
      "a header that is not a string",
      { upload: { ...goodUpload, headers: { a: 1 } } },
      "upload.headers",
    ],
  ])("names the entry and the blob for %s, never quoting the URL", async (_topic, fault, named) => {
    const hash = "b".repeat(64);
    const good = { sha256: "a".repeat(64), size: 3, upload: goodUpload };
    const error = await refusal({
      missing: [good, { sha256: hash, size: 3, upload: goodUpload, ...fault }],
    });
    expect(error.index).toBe(1);
    expect(error.sha256).toBe(hash);
    expect(error.message).toContain(`missing[1] (blob ${hash})`);
    expect(error.message).toContain(named);
    expect(error.message).not.toContain("secret");
  });

  it("refuses an answer without a missing list", async () => {
    const error = await refusal({ held: [] });
    expect(error.index).toBeUndefined();
    expect(error.message).toContain("`missing` list");
  });
});
