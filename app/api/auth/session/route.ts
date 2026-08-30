import { getAuthMode, isDemoLoginAllowed, listDemoUsers } from "@/lib";

import {
  getAuthenticatedUser,
  handleRouteError,
  json,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const authMode = getAuthMode();
    const user = await getAuthenticatedUser();
    const demoUsers = isDemoLoginAllowed() ? await listDemoUsers() : [];

    if (!user) {
      return json({ authenticated: false, authMode, demoUsers });
    }

    return json({ authenticated: true, authMode, user, demoUsers });
  } catch (error) {
    return handleRouteError(error);
  }
}
