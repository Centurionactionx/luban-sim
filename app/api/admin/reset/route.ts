import { refreshAllQuotes, resetPrototype } from "@/lib";

import {
  handleRouteError,
  json,
  requireHostUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  try {
    const user = await requireHostUser();
    await refreshAllQuotes();
    const overview = resetPrototype(user.id);

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}
