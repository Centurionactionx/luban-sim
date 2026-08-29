import { cookies } from "next/headers";
import { z } from "zod";

import {
  createSessionToken,
  getSessionUser,
  invalidateSessionToken,
  SESSION_COOKIE_NAME,
} from "@/lib";

import {
  errorResponse,
  handleRouteError,
  json,
  parseJson,
  sessionCookieOptions,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const loginSchema = z
  .object({
    userId: z.string().trim().min(1).max(100),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  try {
    if (
      process.env.NODE_ENV === "production" &&
      process.env.LUBAN_DEMO_MODE !== "true"
    ) {
      return errorResponse(
        503,
        "DEMO_MODE_DISABLED",
        "Demo identity switching is disabled in production.",
      );
    }

    const { userId } = loginSchema.parse(await parseJson(request));
    const user = getSessionUser(userId);

    if (!user) {
      return errorResponse(
        401,
        "INVALID_DEMO_USER",
        "Choose one of the available demo users.",
        "userId",
      );
    }

    const cookieStore = await cookies();
    const previousToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (previousToken) {
      invalidateSessionToken(previousToken);
    }

    const token = createSessionToken(user.id);
    cookieStore.set(
      SESSION_COOKIE_NAME,
      token,
      sessionCookieOptions(request),
    );

    return json({ ok: true, user });
  } catch (error) {
    return handleRouteError(error);
  }
}
