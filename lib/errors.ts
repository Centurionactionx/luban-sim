import type { SerializedAppError } from "./contracts";

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON(): SerializedAppError {
    return {
      name: "AppError",
      code: this.code,
      message: this.message,
      status: this.status,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function assertFound<T>(
  value: T | null | undefined,
  message: string,
  code = "NOT_FOUND",
): T {
  if (value === null || value === undefined) {
    throw new AppError(code, message, 404);
  }

  return value;
}
