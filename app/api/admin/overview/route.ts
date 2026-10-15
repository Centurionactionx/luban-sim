import { assertRequestAllowed, getAdminOverview, refreshAllQuotes } from "@/lib";

import {
  handleRouteError,
  json,
  requireHostUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const user = await requireHostUser();
    assertRequestAllowed(`poll-overview:${user.id}`, 120);
    await refreshAllQuotes();
    return json(await getAdminOverview(user.id));
  } catch (error) {
    return handleRouteError(error);
  }
}
