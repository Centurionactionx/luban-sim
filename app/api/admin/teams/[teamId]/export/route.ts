import { centsToDecimal, toCsv, type CsvValue } from "@/lib/csv";
import { getTeamHistoryForExport } from "@/lib";

import { ApiError, handleRouteError, requireHostUser } from "../../../../_lib/http";

export const dynamic = "force-dynamic";

/** One team's trades and activity as a single timeline, newest first. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  try {
    const user = await requireHostUser();
    const teamId = (await context.params).teamId.trim();
    if (!teamId || teamId.length > 100) {
      throw new ApiError(400, "INVALID_TEAM_ID", "teamId is invalid.", "teamId");
    }

    const { teamName, orders, activity } = await getTeamHistoryForExport(user.id, teamId);
    const rows: Array<{ at: string; cells: CsvValue[] }> = [
      ...orders.map((order) => ({
        at: order.createdAt,
        cells: [
          order.createdAt,
          "Trade",
          order.actorName,
          order.side,
          order.symbol,
          order.quantity,
          centsToDecimal(order.fillPriceCadCents),
          centsToDecimal(order.grossCents),
          centsToDecimal(order.realizedGainCents),
          `Filled at ${centsToDecimal(order.fillPriceCents)} in listing currency`,
        ],
      })),
      // Fills are already rows above; their activity entries would repeat them.
      ...activity
        .filter((item) => item.type !== "ORDER_FILLED")
        .map((item) => ({
          at: item.createdAt,
          cells: [item.createdAt, item.title, item.actorName, null, null, null, null, null, null, item.detail],
        })),
    ].sort((left, right) => right.at.localeCompare(left.at));

    const csv = toCsv(
      [
        "Time (UTC)",
        "Event",
        "By",
        "Side",
        "Symbol",
        "Quantity",
        "Fill price (CAD)",
        "Total (CAD)",
        "Realized gain (CAD)",
        "Detail",
      ],
      rows.map((row) => row.cells),
    );
    const slug = teamName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team";
    const day = new Date().toISOString().slice(0, 10);

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="luban-${slug}-${day}.csv"`,
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
