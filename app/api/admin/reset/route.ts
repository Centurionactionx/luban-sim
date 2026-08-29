import {
  refreshAllRuntimeQuotes,
  resetRuntimePrototype,
} from "@/lib/server/runtime";

import {
  handleRouteError,
  json,
  requireHostUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  try {
    const user = await requireHostUser();
    await refreshAllRuntimeQuotes();
    const overview = await resetRuntimePrototype(user.id);

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}
