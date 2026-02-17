export class ClientAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientAuthenticationError";
  }
}

export class PipelineRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineRequestError";
  }
}
