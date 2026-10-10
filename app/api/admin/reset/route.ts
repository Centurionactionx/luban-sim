import {
  isDemoLoginAllowed,
  refreshAllQuotes,
  resetPrototype,
  resetRequestThrottle,
} from "@/lib";

import {
  requireTrustedOrigin,
  errorResponse,
  handleRouteError,
  json,
  requireHostUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    // Resetting rebuilds the seeded demo world: it deletes every team and
    // membership while real accounts survive, which would strand every
    // invitation-registered student with no way back onto a team. It is a
    // demo-mode tool only.
    if (!isDemoLoginAllowed()) {
      return errorResponse(
        403,
        "RESET_DEMO_ONLY",
        "The prototype reset is only available in demo mode.",
      );
    }

    const user = await requireHostUser();
    // Best-effort valuation freshness only: a market-data outage must never
    // block the host from pausing, scheduling, resetting, or fixing balances.
    await refreshAllQuotes().catch(() => {});
    const overview = await resetPrototype(user.id);
    // A fresh demo world starts with fresh per-person request allowances.
    resetRequestThrottle();

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}
