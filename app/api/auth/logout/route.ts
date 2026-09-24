import { cookies } from "next/headers";

import { invalidateSessionToken, SESSION_COOKIE_NAME } from "@/lib";

import { requireTrustedOrigin, handleRouteError, json, sessionCookieOptions } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

    if (token) {
      await invalidateSessionToken(token);
    }

    cookieStore.set(SESSION_COOKIE_NAME, "", {
      ...sessionCookieOptions(request),
      maxAge: 0,
    });

    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
