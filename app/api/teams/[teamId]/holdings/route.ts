import {
  assertRequestAllowed,
  getTeamHoldings,
  refreshMissingQuotes,
} from "@/lib";

import {
  ApiError,
  handleRouteError,
  json,
  requireAdminMfa,
  requireAuthenticatedUser,
} from "../../../_lib/http";

export const dynamic = "force-dynamic";

/**
 * One team's holdings for the portfolio map. Hosts and platform admins may
 * read any competition team; students only their own (403 otherwise).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    // Each read values every holding; same ceiling as dashboard polling.
    assertRequestAllowed(`team-holdings:${user.id}`, 120);
    // Hosts and admins read any team here, so they need the host second factor.
    await requireAdminMfa(user);
    const teamId = (await params).teamId.trim();
    if (!teamId || teamId.length > 100) {
      throw new ApiError(400, "INVALID_TEAM_ID", "teamId is invalid.", "teamId");
    }

    // A host may open a team holding symbols this server instance has never
    // quoted; price those first or valuing them would fail. Only missing
    // quotes are fetched, and a market-data outage falls through to the
    // last known prices.
    await refreshMissingQuotes().catch(() => {});

    return json(await getTeamHoldings(user.id, teamId));
  } catch (error) {
    return handleRouteError(error);
  }
}
