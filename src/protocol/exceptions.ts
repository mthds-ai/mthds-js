/**
 * Protocol-level exceptions — the base error every MTHDS runner error derives
 * from. Mirrors `mthds/protocol/exceptions.py`. Runner-specific errors (API
 * transport, run lifecycle) live in `runners/api/exceptions.ts`.
 */

export class PipelineRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = "PipelineRequestError";
  }
}
