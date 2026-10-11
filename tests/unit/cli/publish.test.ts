import { beforeEach, describe, expect, it, vi } from "vitest";

// `mthds publish` registers a public GitHub repository on mthds.sh through its
// telemetry event alone, so while telemetry is off it refuses before the
// selection and exits non-zero instead of printing "Published".

// ── Mocks ────────────────────────────────────────────────────────────

const spinner = { start: vi.fn(), stop: vi.fn(), message: vi.fn() };

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: () => spinner,
  multiselect: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/cli/commands/index.js", () => ({ printLogo: vi.fn() }));

vi.mock("../../../src/installer/resolver/address.js", () => ({ parseAddress: vi.fn() }));
vi.mock("../../../src/installer/resolver/github.js", () => ({ resolveFromGitHub: vi.fn() }));
vi.mock("../../../src/installer/resolver/local.js", () => ({ resolveFromLocal: vi.fn() }));

vi.mock("../../../src/installer/telemetry/posthog.js", () => ({
  trackPublish: vi.fn(),
  publishBlockedByTelemetry: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

import * as p from "@clack/prompts";
import { parseAddress } from "../../../src/installer/resolver/address.js";
import { resolveFromGitHub } from "../../../src/installer/resolver/github.js";
import { resolveFromLocal } from "../../../src/installer/resolver/local.js";
import {
  trackPublish,
  publishBlockedByTelemetry,
} from "../../../src/installer/telemetry/posthog.js";
import { publishMethod } from "../../../src/cli/commands/publish.js";
import type { ResolvedMethod, ResolvedRepo } from "../../../src/package/manifest/types.js";

const mockedPublishBlockedByTelemetry = vi.mocked(publishBlockedByTelemetry);

const method: ResolvedMethod = {
  name: "contract-analysis",
  manifest: {
    package: {
      address: "github.com/mthds-ai/contract-analysis",
      name: "contract-analysis",
      version: "1.0.0",
      description: "Analyze contracts",
    },
  },
  rawManifest: "[package]\nname = 'contract-analysis'",
  files: [],
};

const publicRepo: ResolvedRepo = {
  methods: [method],
  skipped: [],
  source: "github",
  repoName: "mthds-ai/contract-analysis",
  isPublic: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedPublishBlockedByTelemetry.mockReturnValue(undefined);
  vi.mocked(parseAddress).mockReturnValue({
    org: "mthds-ai",
    repo: "contract-analysis",
    subpath: null,
  });
  vi.mocked(resolveFromGitHub).mockResolvedValue(publicRepo);
  // A refusal ends in process.exit(1); throw a sentinel so the test can catch it.
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("__exit__");
  }) as never);
});

describe("publishMethod", () => {
  it("sends the publish event and reports it while telemetry is on", async () => {
    await publishMethod({ address: "mthds-ai/contract-analysis" });

    expect(trackPublish).toHaveBeenCalledWith(method, "mthds-ai/contract-analysis");
    expect(p.log.success).toHaveBeenCalledWith("Published 1 method to mthds.sh");
  });

  it("refuses a public repository while telemetry is off, naming why", async () => {
    mockedPublishBlockedByTelemetry.mockReturnValue(
      "Nothing was published: telemetry is off (DO_NOT_TRACK is set).",
    );

    await expect(publishMethod({ address: "mthds-ai/contract-analysis" })).rejects.toThrow(
      "__exit__",
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(p.log.error).toHaveBeenCalledWith(
      "Nothing was published: telemetry is off (DO_NOT_TRACK is set).",
    );
    expect(trackPublish).not.toHaveBeenCalled();
    expect(p.log.success).not.toHaveBeenCalledWith(expect.stringContaining("Published"));
  });

  it("does not consult telemetry for a local source, which never sends", async () => {
    vi.mocked(resolveFromLocal).mockReturnValue({
      ...publicRepo,
      source: "local",
      isPublic: false,
    });
    mockedPublishBlockedByTelemetry.mockReturnValue("telemetry is off");

    await publishMethod({ dir: "/some/path" });

    expect(publishBlockedByTelemetry).not.toHaveBeenCalled();
    expect(trackPublish).not.toHaveBeenCalled();
  });
});
