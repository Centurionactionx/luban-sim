/**
 * How the browser reads this app's API responses. Every route reports errors
 * as { error: { code, message, field } } (handleRouteError in
 * app/api/_lib/http.ts). Safe to import from client components.
 */

export type ApiErrorShape = {
  error?: {
    code?: string;
    message?: string;
    field?: string;
  };
};

/** The body as JSON, or {} when it is empty or not JSON (a gateway error page). */
export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/** The API's error message from a parsed body, or the fallback. */
export function extractError(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null) {
    const error = (payload as ApiErrorShape).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return fallback;
}

/**
 * Whether a failed order request must keep its idempotency key so a retry
 * replays it: a gateway/server failure or timeout can arrive after the order
 * committed, and a rate limit asks for the same request again later. Any
 * other refusal is final, so an edited retry is a new order.
 */
export function orderKeyOutlivesFailure(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}
