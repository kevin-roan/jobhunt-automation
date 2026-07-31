export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, statusCode = 500, code = 'internal_error', details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string | number) {
    super(id === undefined ? `${entity} not found` : `${entity} ${id} not found`, 404, 'not_found');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'validation_error', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'conflict');
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(message, 422, 'configuration_error');
  }
}

/** Raised when the browser pipeline hits a question or gate only a human can clear. */
export class NeedsHumanError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'needs_human', details);
  }
}

export class LlmError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 502, 'llm_error', details);
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function toErrorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
