import type { APIRequestContext } from "@playwright/test";

export type DemoUserId = "alex" | "maya" | "jordan" | "host";

export type DashboardResponse = {
  currentUser: {
    id: DemoUserId;
    name: string;
    role: "student" | "host";
  };
  competition: {
    status: "draft" | "active" | "paused" | "ended";
  };
  team: {
    id: string;
    name: string;
    status: "active" | "frozen" | "disqualified";
    version: number;
  } | null;
  portfolio: {
    cashCents: number;
    totalValueCents: number;
  } | null;
  holdings: Array<{
    symbol: string;
    quantity: number;
  }>;
  recentActivity: Array<{
    type: string;
    actorName: string;
    detail: string;
  }>;
};

async function assertOk(response: Awaited<ReturnType<APIRequestContext["post"]>>, action: string) {
  if (response.ok()) return response;

  throw new Error(
    `${action} failed with ${response.status()}: ${await response.text()}`,
  );
}

export async function loginAs(
  request: APIRequestContext,
  userId: DemoUserId,
): Promise<void> {
  const response = await request.post("/api/auth/demo-login", {
    data: { userId },
  });
  await assertOk(response, `Demo login as ${userId}`);
}

export async function resetPrototype(request: APIRequestContext): Promise<void> {
  await loginAs(request, "host");
  const response = await request.post("/api/admin/reset");
  await assertOk(response, "Prototype reset");
}

export async function readDashboard(
  request: APIRequestContext,
): Promise<DashboardResponse> {
  const response = await request.get("/api/dashboard");
  await assertOk(response, "Dashboard request");
  return (await response.json()) as DashboardResponse;
}
