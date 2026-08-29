import { listDemoUsers } from "@/lib";

import {
  getAuthenticatedUser,
  handleRouteError,
  json,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const user = await getAuthenticatedUser();

    if (!user) {
      const demoModeEnabled =
        process.env.NODE_ENV !== "production" ||
        process.env.LUBAN_DEMO_MODE === "true";
      return json({
        authenticated: false,
        demoUsers: demoModeEnabled ? listDemoUsers() : [],
      });
    }

    return json({ authenticated: true, user, demoUsers: listDemoUsers() });
  } catch (error) {
    return handleRouteError(error);
  }
}
