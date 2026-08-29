import { beforeEach, describe, expect, it } from "vitest";

import {
  AppError,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionToken,
  getSessionFromToken,
  getSessionUser,
  invalidateSessionToken,
  listDemoUsers,
  readSessionTokenFromCookieHeader,
  resetPrototype,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "@/lib";
import { getDatabase } from "@/lib/server/db";

beforeEach(() => {
  resetPrototype("host");
  getDatabase().exec("DELETE FROM sessions;");
});

describe("demo session isolation", () => {
  it("keeps simultaneous sessions independent and revokes only one token", () => {
    const first = createSessionToken("alex");
    const second = createSessionToken("alex");

    expect(first).not.toBe(second);
    expect(getSessionFromToken(first)?.id).toBe("alex");
    expect(getSessionFromToken(second)?.teamId).toBe("northstar");

    invalidateSessionToken(first);

    expect(getSessionFromToken(first)).toBeNull();
    expect(getSessionFromToken(second)?.id).toBe("alex");
  });

  it("serializes and parses an HTTP-only session cookie", () => {
    const token = createSessionToken("maya");
    const serialized = serializeSessionCookie(token);

    expect(serialized).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(serialized).toContain("HttpOnly");
    expect(serialized).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(
      readSessionTokenFromCookieHeader(`theme=paper; ${serialized}; demo=true`),
    ).toBe(token);
    expect(serializeClearedSessionCookie()).toContain("Max-Age=0");
  });

  it("rejects malformed, expired, and invalid-lifetime sessions", () => {
    expect(getSessionFromToken(null)).toBeNull();
    expect(getSessionFromToken("too-short")).toBeNull();
    expect(readSessionTokenFromCookieHeader(null)).toBeNull();

    const token = createSessionToken("jordan", 60);
    getDatabase().exec(
      "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z';",
    );
    expect(getSessionFromToken(token)).toBeNull();

    expect(() => createSessionToken("alex", 59)).toThrowError(
      expect.objectContaining({
        code: "INVALID_SESSION_TTL",
        status: 400,
      }),
    );
    expect(() => createSessionToken("missing-user")).toThrowError(
      expect.objectContaining({ code: "USER_NOT_FOUND", status: 404 }),
    );
  });

  it("returns stable demo identities and serializable application errors", () => {
    expect(getSessionUser("host")).toMatchObject({ role: "host", teamId: null });
    expect(listDemoUsers().map((user) => user.id)).toEqual([
      "alex",
      "maya",
      "jordan",
      "host",
    ]);

    const error = new AppError("TEST_CONFLICT", "Conflict", 409, {
      field: "symbol",
    });
    expect(error.toJSON()).toEqual({
      name: "AppError",
      code: "TEST_CONFLICT",
      message: "Conflict",
      status: 409,
      details: { field: "symbol" },
    });
  });
});
