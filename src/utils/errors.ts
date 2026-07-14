interface ErrorOptionsWithCause {
  cause?: unknown;
}

export class EulrError extends Error {
  constructor(message: string, options?: ErrorOptionsWithCause) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends EulrError {}
export class AuthenticationError extends EulrError {}
export class ProviderError extends EulrError {}
export class ToolValidationError extends EulrError {}
export class ToolExecutionError extends EulrError {}
export class PermissionDeniedError extends EulrError {}
export class WorkspaceBoundaryError extends EulrError {}
export class SessionError extends EulrError {}
export class CancellationError extends EulrError {}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    error instanceof CancellationError
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
