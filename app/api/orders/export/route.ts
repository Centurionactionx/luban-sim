import { centsToDecimal, toCsv } from "@/lib/csv";
import { listOrdersForExport } from "@/lib";

import { handleRouteError, requireAuthenticatedUser } from "../../_lib/http";

export const dynamic = "force-dynamic";

/** Every fill the caller may see, newest first, as a CSV download. */
export async function GET(): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const orders = await listOrdersForExport(user.id);
    const csv = toCsv(
      [
        "Filled at (UTC)",
        "Portfolio",
        "Placed by",
        "Side",
        "Symbol",
        "Quantity",
        "Fill price (listing currency)",
        "Fill price (CAD)",
        "Total (CAD)",
        "Realized gain (CAD)",
      ],
      orders.map((order) => [
        order.createdAt,
        order.teamName,
        order.actorName,
        order.side,
        order.symbol,
        order.quantity,
        centsToDecimal(order.fillPriceCents),
        centsToDecimal(order.fillPriceCadCents),
        centsToDecimal(order.grossCents),
        centsToDecimal(order.realizedGainCents),
      ]),
    );
    const day = new Date().toISOString().slice(0, 10);

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="luban-trades-${day}.csv"`,
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
