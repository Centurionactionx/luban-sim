import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";
import {
  getMarketDataProvider,
  setMarketDataProvider,
  type MarketDataProvider,
  type MarketInstrument,
} from "@/lib/server/quotes";
import { quoteForInstrument } from "@/lib/server/postgres/queries";

const originalProvider = getMarketDataProvider();
const instrument: MarketInstrument = {
  symbol: "NICH",
  name: "Niche Corp.",
  exchange: "NASDAQ",
  sector: "Technology",
  listingCurrency: "USD",
  basePriceCents: 10_001,
  previousCloseCents: 9_900,
  fxRateBasisPoints: 13_600,
};

afterEach(() => {
  setMarketDataProvider(originalProvider);
});

function unavailableProvider(): MarketDataProvider {
  return {
    id: "YAHOO_FINANCE",
    quote() {
      throw new AppError(
        "MARKET_DATA_RATE_LIMITED",
        "The quote provider is rate limited.",
        503,
      );
    },
    async refreshQuote() {
      throw new AppError(
        "MARKET_DATA_RATE_LIMITED",
        "The quote provider is rate limited.",
        503,
      );
    },
  };
}

describe("PostgreSQL portfolio quote fallback", () => {
  it("uses persisted market metadata only when an admin mutation requests a fallback", async () => {
    setMarketDataProvider(unavailableProvider());
    const at = new Date("2026-08-29T15:00:00.000Z");

    const quote = await quoteForInstrument(instrument, at, true, true);

    expect(quote).toMatchObject({
      symbol: "NICH",
      priceCents: 10_001,
      priceCadCents: 13_601,
      previousCloseCents: 9_900,
      previousCloseCadCents: 13_464,
      changeCents: 101,
      isStale: true,
      asOf: at.toISOString(),
    });
  });

  it("does not hide market failures on ordinary portfolio reads", async () => {
    setMarketDataProvider(unavailableProvider());

    await expect(
      quoteForInstrument(instrument, new Date(), true, false),
    ).rejects.toMatchObject({ code: "MARKET_DATA_RATE_LIMITED" });
  });
});
