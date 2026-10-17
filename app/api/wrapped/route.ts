import { getWrapped } from "@/lib";

import { handleRouteError, json, requireAuthenticatedUser } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    return json(await getWrapped(user.id));
  } catch (error) {
    return handleRouteError(error);
  }
}
