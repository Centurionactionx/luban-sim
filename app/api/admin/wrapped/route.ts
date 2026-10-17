import { z } from "zod";

import { publishWrapped } from "@/lib";

import {
  requireTrustedOrigin,
  handleRouteError,
  json,
  parseJson,
  requireHostUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const publishSchema = z.object({ code: z.string().max(32) }).strict();

/** Publishes (or refreshes) the end-of-competition Wrapped for everyone. */
export async function POST(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const input = publishSchema.parse(await parseJson(request));
    const { publishedAt } = await publishWrapped({ actorUserId: user.id, code: input.code });
    return json({ ok: true, publishedAt });
  } catch (error) {
    return handleRouteError(error);
  }
}
