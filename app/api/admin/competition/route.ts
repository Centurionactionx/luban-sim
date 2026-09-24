import { z } from "zod";

import { refreshAllQuotes, updateCompetition } from "@/lib";

import {
  requireTrustedOrigin,
  handleRouteError,
  json,
  parseJson,
  requireHostUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const isoInstant = z
  .string()
  .trim()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Enter a valid date and time.",
  });

const updateSchema = z
  .object({
    status: z
      .preprocess(
        (value) =>
          typeof value === "string" ? value.trim().toLowerCase() : value,
        z.enum(["draft", "active", "paused", "ended"]),
      )
      .optional(),
    startsAt: isoInstant.optional(),
    endsAt: isoInstant.optional(),
    startingCashCents: z
      .number()
      .int()
      .min(0)
      .max(100_000_000_000_000)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== undefined ||
      value.startsAt !== undefined ||
      value.endsAt !== undefined ||
      value.startingCashCents !== undefined,
    { message: "Provide a status or schedule change." },
  );

export async function PATCH(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const update = updateSchema.parse(await parseJson(request));
    // Best-effort valuation freshness only: a market-data outage must never
    // block the host from pausing, scheduling, resetting, or fixing balances.
    await refreshAllQuotes().catch(() => {});

    // One transaction: a failed status change rolls back the schedule too.
    const overview = await updateCompetition({
      actorUserId: user.id,
      status: update.status,
      startsAt: update.startsAt,
      endsAt: update.endsAt,
      startingCashCents: update.startingCashCents,
    });

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}
