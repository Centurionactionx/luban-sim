import { listAccounts } from "@/lib";

import { handleRouteError, json, requireHostUser } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const user = await requireHostUser();

    return json({ accounts: await listAccounts(user.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}
