import { z } from "zod";

import { submitFeedback, type FeedbackTopic } from "@/lib";

import {
  handleRouteError,
  json,
  parseJson,
  requireAuthenticatedUser,
  requireTrustedOrigin,
} from "../_lib/http";

export const dynamic = "force-dynamic";

// Only the shape is checked here. submitFeedback owns the rules (topic,
// trimmed length, rate limit) so every caller gets the same answers.
const feedbackSchema = z
  .object({
    topic: z.string(),
    message: z.string(),
    source: z.enum(["header", "page"]).default("header"),
  })
  .strict();

/** Any signed-in account, students through platform administrators. */
export async function POST(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireAuthenticatedUser();
    const body = feedbackSchema.parse(await parseJson(request));
    const feedback = await submitFeedback({
      userId: user.id,
      // Checked inside submitFeedback.
      topic: body.topic as FeedbackTopic,
      message: body.message,
      source: body.source,
    });

    return json({ ok: true, feedback: { id: feedback.id } }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
