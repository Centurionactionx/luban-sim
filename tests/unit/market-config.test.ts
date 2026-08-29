import { describe, expect, it } from "vitest";

import {
  MARKET_REFRESH_INTERVAL_MS,
  TEAM_SYNC_INTERVAL_MS,
} from "@/lib/market-config";

describe("automatic refresh cadence", () => {
  it("paces both the team ledger and market data at one minute", () => {
    expect(TEAM_SYNC_INTERVAL_MS).toBe(60_000);
    expect(MARKET_REFRESH_INTERVAL_MS).toBe(60_000);
  });
});
