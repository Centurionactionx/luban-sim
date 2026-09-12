import { cookies } from "next/headers";
import { ZodError } from "zod";

import {
  AppError,
  SESSION_TTL_SECONDS,
  canHostCompetitions,
  getSessionFromToken,
  isManagedAuthMode,
  SESSION_COOKIE_NAME,
} from "@/lib";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Expires: "0",
  Pragma: "no-cache",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
} as const;

export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_SECONDS;

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionFromToken>>>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function json(
  body: unknown,
  init: Omit<ResponseInit, "headers"> & { headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);

  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    if (name === "Vary" && headers.has(name)) {
      const current = headers.get(name);
      headers.set(name, current ? `${current}, ${value}` : value);
    } else if (!headers.has(name)) {
      headers.set(name, value);
    }
  }

  return Response.json(body, { ...init, headers });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  field?: string,
  details?: Record<string, unknown>,
): Response {
  return json(
    {
      error: {
        code,
        message,
        ...(field ? { field } : {}),
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
}

export function requireTrustedOrigin(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  // Next may normalize request.url to its listening hostname. The HTTP Host
  // preserves the browser's actual target; never trust X-Forwarded-Host here.
  const url = new URL(request.url);
  const host = request.headers.get("host");
  const targetOrigin = host ? `${url.protocol}//${host}` : url.origin;
  if (
    site === "cross-site" ||
    site === "same-site" ||
    (origin !== null && origin !== targetOrigin)
  ) {
    throw new ApiError(403, "UNTRUSTED_ORIGIN", "Submit this request from the application.");
  }
}

export async function parseJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > 16_384) {
    throw new ApiError(413, "BODY_TOO_LARGE", "The JSON body is too large.");
  }

  const rawBody = await request.text();

  if (rawBody.length > 16_384) {
    throw new ApiError(413, "BODY_TOO_LARGE", "The JSON body is too large.");
  }

  if (!rawBody.trim()) {
    throw new ApiError(400, "EMPTY_BODY", "A JSON request body is required.");
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

export async function getAuthenticatedUser(): Promise<SessionUser | null> {
  if (isManagedAuthMode()) {
    // Imported on demand so demo-mode processes never load the Clerk SDK,
    // which refuses to run without provider keys.
    const { getManagedSessionUser } = await import(
      "@/lib/server/managed-identity"
    );
    return getManagedSessionUser();
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  const user = await getSessionFromToken(token);
  if (!user) {
    cookieStore.set(SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "strict",
      secure: false,
    });
  }

  return user;
}

export async function requireAuthenticatedUser(): Promise<SessionUser> {
  const user = await getAuthenticatedUser();

  if (!user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
  }

  return user;
}

export async function requireHostUser(): Promise<SessionUser> {
  const user = await requireAuthenticatedUser();

  if (!canHostCompetitions(user.role)) {
    throw new ApiError(
      403,
      "HOST_ONLY",
      "Only a competition host can perform this action.",
    );
  }

  if (isManagedAuthMode()) {
    const { assertAdminMfaSatisfied } = await import(
      "@/lib/server/managed-identity"
    );
    await assertAdminMfaSatisfied(user);
  }

  return user;
}

export async function requirePlatformAdmin(): Promise<SessionUser> {
  const user = await requireAuthenticatedUser();

  if (user.role !== "platform_admin") {
    throw new ApiError(
      403,
      "ADMIN_ONLY",
      "Only a platform administrator can perform this action.",
    );
  }

  if (isManagedAuthMode()) {
    const { assertAdminMfaSatisfied } = await import(
      "@/lib/server/managed-identity"
    );
    await assertAdminMfaSatisfied(user);
  }

  return user;
}

export function sessionCookieOptions(request: Request) {
  const isHttps =
    new URL(request.url).protocol === "https:" ||
    process.env.LUBAN_FORCE_SECURE_COOKIES === "true";

  return {
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
    priority: "high" as const,
    sameSite: "strict" as const,
    secure: isHttps,
  };
}

export function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key")?.trim();

  if (!value) {
    throw new ApiError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "The Idempotency-Key header is required.",
      "Idempotency-Key",
    );
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new ApiError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 8 to 128 safe characters.",
      "Idempotency-Key",
    );
  }

  return value;
}

export function parseLimit(
  request: Request,
  { defaultValue = 20, maximum = 100 } = {},
): number {
  const rawLimit = new URL(request.url).searchParams.get("limit");
  if (rawLimit === null || rawLimit === "") {
    return defaultValue;
  }

  if (!/^\d+$/.test(rawLimit)) {
    throw new ApiError(
      400,
      "INVALID_LIMIT",
      "limit must be a positive whole number.",
      "limit",
    );
  }

  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new ApiError(
      400,
      "INVALID_LIMIT",
      `limit must be between 1 and ${maximum}.`,
      "limit",
    );
  }

  return limit;
}

function safeStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 500;
}

export function handleRouteError(error: unknown): Response {
  if (error instanceof ApiError) {
    return errorResponse(error.status, error.code, error.message, error.field);
  }

  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const field = issue?.path.map(String).join(".") || undefined;
    return errorResponse(
      422,
      "VALIDATION_ERROR",
      issue?.message ?? "The request data is invalid.",
      field,
    );
  }

  if (error instanceof AppError) {
    const field =
      typeof error.details?.field === "string" ? error.details.field : undefined;
    const retryAfterSeconds =
      typeof error.details?.retryAfterSeconds === "number" &&
      Number.isFinite(error.details.retryAfterSeconds)
        ? Math.max(1, Math.round(error.details.retryAfterSeconds))
        : null;
    if (retryAfterSeconds !== null) {
      return json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(field ? { field } : {}),
            ...(error.details ? { details: error.details } : {}),
          },
        },
        {
          status: safeStatus(error.status),
          headers: { "Retry-After": String(retryAfterSeconds) },
        },
      );
    }
    return errorResponse(
      safeStatus(error.status),
      error.code,
      error.message,
      field,
      error.details,
    );
  }

  if (
    error instanceof Error &&
    (("code" in error && error.code === "SQLITE_BUSY") ||
      error.message.toLowerCase().includes("database is locked"))
  ) {
    return json(
      {
        error: {
          code: "DATABASE_BUSY",
          message: "The shared portfolio is busy. Retry this request in a moment.",
          details: { retryAfterSeconds: 1 },
        },
      },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }

  console.error("Unhandled API route error", error);
  return errorResponse(
    500,
    "INTERNAL_ERROR",
    "An unexpected server error occurred.",
  );
}
