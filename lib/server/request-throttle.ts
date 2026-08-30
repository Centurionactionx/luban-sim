import { AppError } from "../errors";

/**
 * Small in-memory sliding-window throttle for endpoints whose cache misses
 * reach the upstream market-data provider. It is deliberately per-process
 * (good enough at competition scale) and best-effort: the durable,
 * transaction-enforced order rate limit in lib/server/trading.ts remains the
 * authoritative ceiling on trading itself.
 */
const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 2_000;

const windows = new Map<string, number[]>();

export function assertRequestAllowed(
  key: string,
  limitPerMinute: number,
): void {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  if (windows.size > MAX_TRACKED_KEYS) {
    windows.clear();
  }

  const timestamps = (windows.get(key) ?? []).filter((at) => at > cutoff);

  if (timestamps.length >= limitPerMinute) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((timestamps[0] + WINDOW_MS - now) / 1_000),
    );

    throw new AppError(
      "REQUEST_RATE_LIMITED",
      "Too many market-data requests. Try again shortly.",
      429,
      { retryAfterSeconds, limitPerMinute },
    );
  }

  timestamps.push(now);
  windows.set(key, timestamps);
}

/** Test seam: clears all tracked windows. */
export function resetRequestThrottle(): void {
  windows.clear();
}
