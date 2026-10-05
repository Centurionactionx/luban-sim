import { assertRequestAllowed, isFeedbackTopic, listFeedback } from "@/lib";

import {
  ApiError,
  handleRouteError,
  json,
  parseLimit,
  requirePlatformAdmin,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

/** Newest first; `?topic=WEBSITE` or `?topic=SIMULATOR` narrows it. */
export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requirePlatformAdmin();
    assertRequestAllowed(`feedback-list:${user.id}`, 60);
    const limit = parseLimit(request, { defaultValue: 200, maximum: 500 });
    const rawTopic = new URL(request.url).searchParams.get("topic");
    const topic = rawTopic ? rawTopic.toUpperCase() : undefined;

    if (topic !== undefined && !isFeedbackTopic(topic)) {
      throw new ApiError(
        400,
        "INVALID_FEEDBACK_TOPIC",
        "topic must be WEBSITE or SIMULATOR.",
        "topic",
      );
    }

    return json({ feedback: await listFeedback(user.id, { topic, limit }) });
  } catch (error) {
    return handleRouteError(error);
  }
}
