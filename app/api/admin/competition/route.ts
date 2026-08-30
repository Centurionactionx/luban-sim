import { z } from "zod";

import {
  refreshAllQuotes,
  setCompetitionStatus,
  updateCompetitionSchedule,
} from "@/lib";

import {
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
    const user = await requireHostUser();
    const update = updateSchema.parse(await parseJson(request));
    // Best-effort valuation freshness only: a market-data outage must never
    // block the host from pausing, scheduling, resetting, or fixing balances.
    await refreshAllQuotes().catch(() => {});

    let overview =
      update.startsAt !== undefined ||
      update.endsAt !== undefined ||
      update.startingCashCents !== undefined
        ? updateCompetitionSchedule({
            actorUserId: user.id,
            startsAt: update.startsAt,
            endsAt: update.endsAt,
            startingCashCents: update.startingCashCents,
          })
        : null;

    if (update.status !== undefined) {
      overview = setCompetitionStatus({
        actorUserId: user.id,
        status: update.status,
      });
    }

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}
