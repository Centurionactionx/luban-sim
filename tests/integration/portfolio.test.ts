import { beforeEach, describe, expect, it } from "vitest";

import {
  AppError,
  getDashboard,
  placeOrder,
  reconcileLedgers,
  resetPrototype,
  setTeamCash,
  updateCompetitionStatus,
  updateTeamStatus,
} from "@/lib";
import { getDatabase } from "@/lib/server/db";

function expectAppError(
  operation: () => unknown,
  code: string,
  status: number,
): AppError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code, status });
    return error as AppError;
  }

  throw new Error(`Expected ${code} to be thrown.`);
}

function ledgerBalance(teamId: string): number {
  const row = getDatabase()
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger_entries WHERE team_id = ?",
    )
    .get(teamId) as { balance: number };
  return Number(row.balance);
}

beforeEach(() => {
  resetPrototype("host");
});

describe("shared team portfolio", () => {
  it("starts with buying cash but zero invested portfolio value", () => {
    const dashboard = getDashboard("alex");

    expect(dashboard.portfolio).toMatchObject({
      cashCents: 10_000_000,
      buyingPowerCents: 10_000_000,
      holdingsValueCents: 0,
      totalValueCents: 10_000_000,
    });
    expect(dashboard.team?.version).toBe(0);
    expect(dashboard.holdings).toEqual([]);
    expect(dashboard.recentOrders).toEqual([]);
    expect(dashboard.portfolioHistory.every((point) => point.valueCents === 0)).toBe(
      true,
    );
  });

  it("starts every seeded team with a reconciled cash ledger", () => {
    const report = reconcileLedgers();

    expect(report).toHaveLength(4);
    expect(report.every((team) => team.reconciled)).toBe(true);
    expect(report.every((team) => team.differenceCents === 0)).toBe(true);
  });

  it("commits one student's order to every teammate's dashboard", () => {
    const before = getDashboard("alex");
    const receipt = placeOrder({
      actorUserId: "alex",
      symbol: "CNR.TO",
      side: "BUY",
      quantity: 2,
      idempotencyKey: "test-shared-order-001",
    });
    const alex = getDashboard("alex");
    const maya = getDashboard("maya");

    expect(receipt.duplicate).toBe(false);
    expect(alex.team?.version).toBe((before.team?.version ?? 0) + 1);
    expect(maya.team?.version).toBe(alex.team?.version);
    expect(maya.portfolio?.cashCents).toBe(receipt.cashAfterCents);
    expect(maya.holdings.find((holding) => holding.symbol === "CNR.TO")?.quantity).toBe(2);
    expect(maya.recentActivity[0]).toMatchObject({
      actorUserId: "alex",
      type: "ORDER_FILLED",
    });
    expect(ledgerBalance("northstar")).toBe(maya.portfolio?.cashCents);
  });

  it("replays an identical idempotent request without charging twice", () => {
    const input = {
      actorUserId: "maya",
      symbol: "XEQT.TO",
      side: "BUY" as const,
      quantity: 3,
      idempotencyKey: "test-idempotent-order-001",
    };
    const first = placeOrder(input);
    const second = placeOrder(input);
    const dashboard = getDashboard("alex");

    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({
      duplicate: true,
      cashAfterCents: first.cashAfterCents,
      portfolioVersion: first.portfolioVersion,
    });
    expect(second.order.id).toBe(first.order.id);
    expect(
      dashboard.recentOrders.filter(
        (order) => order.idempotencyKey === input.idempotencyKey,
      ),
    ).toHaveLength(1);

    expectAppError(
      () => placeOrder({ ...input, quantity: 4 }),
      "IDEMPOTENCY_CONFLICT",
      409,
    );
  });

  it("replays a terminal rejection even after the portfolio state changes", () => {
    const rejected = {
      actorUserId: "alex",
      symbol: "XEQT.TO",
      side: "SELL" as const,
      quantity: 1,
      idempotencyKey: "test-stable-rejection-001",
    };

    expectAppError(
      () => placeOrder(rejected),
      "INSUFFICIENT_SHARES",
      409,
    );
    placeOrder({
      actorUserId: "maya",
      symbol: "XEQT.TO",
      side: "BUY",
      quantity: 1,
      idempotencyKey: "test-buy-after-reject-001",
    });
    expectAppError(
      () => placeOrder(rejected),
      "INSUFFICIENT_SHARES",
      409,
    );
    expect(
      getDashboard("alex").recentOrders.some(
        (order) =>
          order.actorUserId === "alex" &&
          order.symbol === "XEQT.TO" &&
          order.side === "SELL",
      ),
    ).toBe(false);
  });

  it("scopes the same raw idempotency key independently per student", () => {
    const key = "test-shared-raw-key-001";
    const alex = placeOrder({
      actorUserId: "alex",
      symbol: "CNR.TO",
      side: "BUY",
      quantity: 1,
      idempotencyKey: key,
    });
    const maya = placeOrder({
      actorUserId: "maya",
      symbol: "XEQT.TO",
      side: "BUY",
      quantity: 1,
      idempotencyKey: key,
    });

    expect(alex.order.id).not.toBe(maya.order.id);
    expect(alex.order.idempotencyKey).toBe(key);
    expect(maya.order.idempotencyKey).toBe(key);
    expect(
      getDashboard("jordan").recentOrders.filter(
        (order) => order.idempotencyKey === key,
      ),
    ).toHaveLength(2);
  });

  it("rejects overspending and overselling without changing durable state", () => {
    const before = getDashboard("alex");

    expectAppError(
      () =>
        placeOrder({
          actorUserId: "alex",
          symbol: "AAPL",
          side: "BUY",
          quantity: 100_000,
          idempotencyKey: "test-too-expensive-001",
        }),
      "INSUFFICIENT_CASH",
      409,
    );
    expectAppError(
      () =>
        placeOrder({
          actorUserId: "maya",
          symbol: "AAPL",
          side: "SELL",
          quantity: 21,
          idempotencyKey: "test-too-many-shares-001",
        }),
      "INSUFFICIENT_SHARES",
      409,
    );

    const after = getDashboard("maya");
    expect(after.team?.version).toBe(before.team?.version);
    expect(after.portfolio?.cashCents).toBe(before.portfolio?.cashCents);
    expect(ledgerBalance("northstar")).toBe(after.portfolio?.cashCents);
  });

  it("enforces host-only pause and team status controls", () => {
    expectAppError(
      () => updateCompetitionStatus({ actorUserId: "alex", status: "paused" }),
      "HOST_REQUIRED",
      403,
    );

    updateCompetitionStatus({ actorUserId: "host", status: "paused" });
    expectAppError(
      () =>
        placeOrder({
          actorUserId: "alex",
          symbol: "SHOP.TO",
          side: "BUY",
          quantity: 1,
          idempotencyKey: "test-paused-order-001",
        }),
      "TRADING_CLOSED",
      409,
    );

    updateCompetitionStatus({ actorUserId: "host", status: "active" });
    updateTeamStatus({
      actorUserId: "host",
      teamId: "northstar",
      status: "disqualified",
    });
    expectAppError(
      () =>
        placeOrder({
          actorUserId: "jordan",
          symbol: "SHOP.TO",
          side: "BUY",
          quantity: 1,
          idempotencyKey: "test-disqualified-order-001",
        }),
      "TEAM_NOT_ACTIVE",
      409,
    );
  });

  it("lets the host set any team's cash while keeping the ledger reconciled", () => {
    const before = getDashboard("alex");
    const overview = setTeamCash({
      actorUserId: "host",
      teamId: "northstar",
      cashCents: 12_345_678,
    });
    const alex = getDashboard("alex");
    const maya = getDashboard("maya");

    expect(alex.portfolio?.cashCents).toBe(12_345_678);
    expect(maya.portfolio?.cashCents).toBe(12_345_678);
    expect(alex.team?.version).toBe((before.team?.version ?? 0) + 1);
    expect(maya.team?.version).toBe(alex.team?.version);
    expect(ledgerBalance("northstar")).toBe(12_345_678);
    expect(
      reconcileLedgers().find((team) => team.teamId === "northstar"),
    ).toMatchObject({
      cashCents: 12_345_678,
      ledgerBalanceCents: 12_345_678,
      differenceCents: 0,
      reconciled: true,
    });
    expect(overview.recentActivity).toContainEqual(
      expect.objectContaining({
        actorUserId: "host",
        teamId: "northstar",
        type: "TEAM_CASH_ADJUSTED",
      }),
    );
  });

  it("rejects non-host and invalid cash adjustments without changing cash", () => {
    const before = getDashboard("alex").portfolio?.cashCents;

    expectAppError(
      () =>
        setTeamCash({
          actorUserId: "alex",
          teamId: "northstar",
          cashCents: 1_000_000,
        }),
      "HOST_REQUIRED",
      403,
    );
    expectAppError(
      () =>
        setTeamCash({
          actorUserId: "host",
          teamId: "northstar",
          cashCents: -1,
        }),
      "INVALID_CASH_BALANCE",
      400,
    );
    expectAppError(
      () =>
        setTeamCash({
          actorUserId: "host",
          teamId: "northstar",
          cashCents: 10.5,
        }),
      "INVALID_CASH_BALANCE",
      400,
    );

    expect(getDashboard("alex").portfolio?.cashCents).toBe(before);
    expect(ledgerBalance("northstar")).toBe(before);
  });
});
