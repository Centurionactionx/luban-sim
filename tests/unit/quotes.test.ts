import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeterministicMarketDataProvider,
  QUOTE_DELAY_MINUTES,
  YahooFinanceMarketDataProvider,
  getMarketDataProvider,
  getQuote,
  getQuoteHistory,
  getDashboard,
  listQuotes,
  placeOrder,
  refreshQuote,
  resetPrototype,
  searchMarketInstruments,
  searchInstruments,
  setMarketDataProvider,
} from "@/lib";
import type { MarketDataProvider } from "@/lib";
import { MARKET_REFRESH_INTERVAL_MS } from "@/lib/market-config";
import { getDatabase } from "@/lib/server/db";

const originalProvider = getMarketDataProvider();

afterEach(() => {
  setMarketDataProvider(originalProvider);
});

function yahooChartFixture({
  price = 102,
  previousClose = 99.5,
  timestamps = [1_700_000_000, 1_700_000_300, 1_700_000_600],
  closes = [100, null, 102],
  meta = {},
}: {
  price?: number;
  previousClose?: number;
  timestamps?: number[];
  closes?: Array<number | null>;
  meta?: Record<string, unknown>;
} = {}) {
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketTime: timestamps.at(-1),
            regularMarketPrice: price,
            chartPreviousClose: previousClose,
            exchangeTimezoneName: "America/Toronto",
            dataGranularity: "5m",
            ...meta,
          },
          timestamp: timestamps,
          indicators: {
            quote: [
              {
                open: closes,
                high: closes,
                low: closes,
                close: closes,
                volume: closes.map((value) => (value === null ? null : 1_000)),
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

function fakeFetch(
  handler: (url: string) => Promise<Response> | Response,
): typeof fetch {
  return vi.fn(async (input: string | URL | Request) =>
    handler(String(input)),
  ) as unknown as typeof fetch;
}

describe("Yahoo Finance market data adapter", () => {
  it("finds obscure stocks across the supported exchanges and rejects other markets and security types", async () => {
    const fetcher = fakeFetch(() =>
      Response.json({
        quotes: [
          { symbol: "DAKT", longname: "Daktronics, Inc.", exchange: "NMS", quoteType: "EQUITY", sector: "Technology" },
          { symbol: "SOUN", shortname: "SoundHound AI, Inc.", exchange: "NGM", quoteType: "EQUITY" },
          { symbol: "ONDS", longname: "Ondas Holdings Inc.", exchange: "NCM", quoteType: "EQUITY" },
          { symbol: "BW", longname: "Babcock & Wilcox Enterprises", exchange: "NYQ", quoteType: "EQUITY" },
          { symbol: "KULR", longname: "KULR Technology Group, Inc.", exchange: "ASE", quoteType: "EQUITY" },
          { symbol: "JOBY", longname: "Joby Aviation, Inc.", exchange: "PCX", quoteType: "EQUITY" },
          { symbol: "DRX.TO", longname: "ADF Group Inc.", exchange: "TOR", quoteType: "EQUITY", sector: "Industrials" },
          { symbol: "DRX.TO", longname: "Duplicate", exchange: "TOR", quoteType: "EQUITY" },
          { symbol: "PNG.V", longname: "Kraken Robotics Inc.", exchange: "VAN", quoteType: "EQUITY" },
          { symbol: "OTCM", longname: "OTC Markets Group Inc.", exchange: "PNK", quoteType: "EQUITY" },
          { symbol: "SPY", longname: "SPDR S&P 500 ETF Trust", exchange: "PCX", quoteType: "ETF" },
          { symbol: "RNAQU", longname: "FutureTech II Acquisition Corp. Units", exchange: "NCM", quoteType: "EQUITY" },
        ],
      }),
    );
    const provider = new YahooFinanceMarketDataProvider(
      fetcher,
      () => 1_700_000_100_000,
    );

    const first = await provider.search("obscure exchange fixture 2026");
    const second = await provider.search("obscure exchange fixture 2026");

    expect(first).toEqual([
      { symbol: "DAKT", name: "Daktronics, Inc.", exchange: "NASDAQ", sector: "Technology", listingCurrency: "USD" },
      { symbol: "SOUN", name: "SoundHound AI, Inc.", exchange: "NASDAQ", sector: "Unclassified", listingCurrency: "USD" },
      { symbol: "ONDS", name: "Ondas Holdings Inc.", exchange: "NASDAQ", sector: "Unclassified", listingCurrency: "USD" },
      { symbol: "BW", name: "Babcock & Wilcox Enterprises", exchange: "NYSE", sector: "Unclassified", listingCurrency: "USD" },
      { symbol: "KULR", name: "KULR Technology Group, Inc.", exchange: "NYSE American", sector: "Unclassified", listingCurrency: "USD" },
      { symbol: "JOBY", name: "Joby Aviation, Inc.", exchange: "NYSE Arca", sector: "Unclassified", listingCurrency: "USD" },
      { symbol: "DRX.TO", name: "ADF Group Inc.", exchange: "TSX", sector: "Industrials", listingCurrency: "CAD" },
    ]);
    expect(second).toEqual(first);
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(1);
    const url = String(vi.mocked(fetcher).mock.calls[0][0]);
    expect(url).toContain("/v1/finance/search?");
    expect(url).toContain("quotesCount=25");
    expect(url).toContain("newsCount=0");
    expect(url).toContain("listsCount=0");
  });

  it("discovers one niche stock on selection, persists it, and supports charting and a shared-team order", async () => {
    setMarketDataProvider(originalProvider);
    resetPrototype("host");
    const now = 1_700_008_000_000;
    const fetcher = fakeFetch((url) => {
      if (url.includes("/v1/finance/search")) {
        return Response.json({
          quotes: [
            {
              symbol: "DAKT",
              longname: "Daktronics, Inc.",
              exchange: "NMS",
              quoteType: "EQUITY",
              sector: "Technology",
            },
          ],
        });
      }
      if (url.includes("CAD%3DX")) {
        return Response.json(
          yahooChartFixture({ price: 1.36, previousClose: 1.35, closes: [1.36] }),
        );
      }
      return Response.json(
        yahooChartFixture({
          price: 18.42,
          previousClose: 17.95,
          closes: [18.1, 18.25, 18.42],
          meta: {
            currency: "USD",
            symbol: "DAKT",
            exchangeName: "NMS",
            instrumentType: "EQUITY",
            exchangeTimezoneName: "America/New_York",
          },
        }),
      );
    });
    setMarketDataProvider(new YahooFinanceMarketDataProvider(fetcher, () => now));

    try {
      const results = await searchMarketInstruments("Daktronics");
      expect(results).toEqual([
        expect.objectContaining({ symbol: "DAKT", exchange: "NASDAQ" }),
      ]);
      expect(getQuote("DAKT")).toBeNull();

      const quote = await refreshQuote("DAKT");
      expect(quote).toMatchObject({
        symbol: "DAKT",
        priceCents: 1_842,
        previousCloseCents: 1_795,
        fxRateBasisPoints: 13_600,
        priceCadCents: 2_505,
        source: "YAHOO_FINANCE",
      });
      expect(
        getDatabase()
          .prepare("SELECT symbol, auto_refresh FROM instruments WHERE symbol = 'DAKT'")
          .get(),
      ).toEqual({ symbol: "DAKT", auto_refresh: 0 });

      const history = await getQuoteHistory("DAKT", "1D");
      expect(history).toMatchObject({
        symbol: "DAKT",
        exchangeTimeZone: "America/New_York",
        source: "YAHOO_FINANCE",
      });
      const receipt = placeOrder({
        actorUserId: "alex",
        symbol: "DAKT",
        side: "BUY",
        quantity: 1,
        idempotencyKey: "discover-dakt-order-001",
      });
      expect(receipt.order).toMatchObject({ symbol: "DAKT", quantity: 1 });
      expect(
        getDashboard("maya").holdings.find((holding) => holding.symbol === "DAKT"),
      ).toMatchObject({ quantity: 1, name: "Daktronics, Inc." });
      expect(
        vi.mocked(fetcher).mock.calls.filter(([input]) =>
          String(input).includes("/v1/finance/search"),
        ),
      ).toHaveLength(1);
    } finally {
      setMarketDataProvider(originalProvider);
      resetPrototype("host");
    }
  });

  it("coalesces requests and preserves exact timestamped closes without interpolation", async () => {
    const fetcher = fakeFetch(() => Response.json(yahooChartFixture()));
    setMarketDataProvider(
      new YahooFinanceMarketDataProvider(fetcher, () => 1_700_001_000_000),
    );

    const [first, second] = await Promise.all([
      refreshQuote("SHOP.TO"),
      refreshQuote("SHOP.TO"),
    ]);
    const [history, duplicateHistory] = await Promise.all([
      getQuoteHistory("SHOP.TO", "1D"),
      getQuoteHistory("SHOP.TO", "1D"),
    ]);

    expect(first).toMatchObject({
      priceCents: 10_200,
      previousCloseCents: 9_950,
      source: "YAHOO_FINANCE",
      isStale: false,
    });
    expect(second).toEqual(first);
    expect(history.points).toEqual([
      expect.objectContaining({
        at: new Date(1_700_000_000_000).toISOString(),
        closeCents: 10_000,
      }),
      expect.objectContaining({
        at: new Date(1_700_000_600_000).toISOString(),
        closeCents: 10_200,
      }),
    ]);
    expect(duplicateHistory).toEqual(history);
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetcher).mock.calls[1][0])).toContain(
      "range=1d&interval=5m",
    );
  });

  it("waits a full minute before refreshing a successful quote", async () => {
    let now = 1_700_001_500_000;
    const fetcher = fakeFetch(() => Response.json(yahooChartFixture()));
    setMarketDataProvider(new YahooFinanceMarketDataProvider(fetcher, () => now));

    const first = await refreshQuote("RY.TO");
    now += MARKET_REFRESH_INTERVAL_MS - 1;
    const cached = await refreshQuote("RY.TO");

    expect(cached).toEqual(first);
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(1);

    now += 1;
    await refreshQuote("RY.TO");
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(2);
  });

  it("maps every UI range to a distinct provider range and interval", async () => {
    const fetcher = fakeFetch(() => Response.json(yahooChartFixture()));
    setMarketDataProvider(
      new YahooFinanceMarketDataProvider(fetcher, () => 1_700_002_000_000),
    );

    await getQuoteHistory("BNS.TO", "1D");
    await getQuoteHistory("BNS.TO", "5D");
    await getQuoteHistory("BNS.TO", "1M");
    await getQuoteHistory("BNS.TO", "3M");

    const urls = vi.mocked(fetcher).mock.calls.map(([input]) => String(input));
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("range=1d&interval=5m"),
        expect.stringContaining("range=5d&interval=15m"),
        expect.stringContaining("range=1mo&interval=1d"),
        expect.stringContaining("range=3mo&interval=1d"),
      ]),
    );
  });

  it("marks the last real quote stale when refresh fails and never invents a replacement", async () => {
    let now = 1_700_003_000_000;
    let requestCount = 0;
    const fetcher = fakeFetch(() => {
      requestCount += 1;
      return requestCount === 1
        ? Response.json(yahooChartFixture({ price: 145.25 }))
        : new Response("upstream unavailable", { status: 503 });
    });
    setMarketDataProvider(new YahooFinanceMarketDataProvider(fetcher, () => now));

    const fresh = await refreshQuote("CNR.TO");
    now += 61_000;
    const stale = await refreshQuote("CNR.TO");

    expect(fresh).toMatchObject({ priceCents: 14_525, isStale: false });
    expect(stale).toMatchObject({
      priceCents: fresh?.priceCents,
      asOf: fresh?.asOf,
      source: "YAHOO_FINANCE",
      isStale: true,
    });
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(2);

    now += MARKET_REFRESH_INTERVAL_MS - 1;
    const backedOff = await refreshQuote("CNR.TO");
    expect(backedOff).toEqual(stale);
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(2);

    now += 1;
    await refreshQuote("CNR.TO");
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(3);
  });

  it("rejects an upstream failure when no real cached quote exists", async () => {
    let now = 1_700_004_000_000;
    const fetcher = fakeFetch(() => new Response("unavailable", { status: 503 }));
    setMarketDataProvider(
      new YahooFinanceMarketDataProvider(fetcher, () => now),
    );

    await expect(refreshQuote("TD.TO")).rejects.toMatchObject({
      code: "MARKET_DATA_UNAVAILABLE",
      status: 503,
    });
    now += MARKET_REFRESH_INTERVAL_MS - 1;
    await expect(refreshQuote("TD.TO")).rejects.toMatchObject({
      code: "MARKET_DATA_UNAVAILABLE",
    });
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(refreshQuote("TD.TO")).rejects.toMatchObject({
      code: "MARKET_DATA_UNAVAILABLE",
    });
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(2);
  });

  it("uses the provider USD/CAD quote for U.S. portfolio valuation", async () => {
    const fetcher = fakeFetch((url) =>
      Response.json(
        url.includes("CAD%3DX")
          ? yahooChartFixture({ price: 1.4, previousClose: 1.39, closes: [1.4] })
          : yahooChartFixture({ price: 100, previousClose: 90, closes: [100] }),
      ),
    );
    setMarketDataProvider(
      new YahooFinanceMarketDataProvider(fetcher, () => 1_700_005_000_000),
    );

    const quote = await refreshQuote("AAPL");

    expect(quote).toMatchObject({
      listingCurrency: "USD",
      priceCents: 10_000,
      fxRateBasisPoints: 14_000,
      priceCadCents: 14_000,
      previousCloseCadCents: 12_600,
    });
    expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(2);
  });

  it("returns a stable rate-limit error with retry metadata", async () => {
    const fetcher = fakeFetch(() => new Response("busy", { status: 429 }));
    setMarketDataProvider(
      new YahooFinanceMarketDataProvider(fetcher, () => 1_700_006_000_000),
    );

    await expect(refreshQuote("MSFT")).rejects.toMatchObject({
      code: "MARKET_DATA_RATE_LIMITED",
      status: 503,
      details: { retryAfterSeconds: 60 },
    });
  });

  it("rejects malformed history instead of drawing generated fallback points", async () => {
    const fetcher = fakeFetch(() =>
      Response.json({ chart: { result: [], error: null } }),
    );
    setMarketDataProvider(
      new YahooFinanceMarketDataProvider(fetcher, () => 1_700_007_000_000),
    );

    await expect(getQuoteHistory("NVDA", "1M")).rejects.toMatchObject({
      code: "MARKET_DATA_INVALID",
      status: 503,
    });
  });
});

describe("deterministic market data", () => {
  it("returns the same delayed quote throughout a minute bucket", () => {
    const first = getQuote("AAPL", new Date("2026-08-28T12:34:05.000Z"));
    const second = getQuote("AAPL", new Date("2026-08-28T12:34:55.000Z"));

    expect(QUOTE_DELAY_MINUTES).toBe(15);
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(first?.asOf).toBe("2026-08-28T12:19:00.000Z");
    expect(first?.source).toBe("LUBAN_SIMULATED");
  });

  it("exposes Canadian and US listings with explicit FX conversion", () => {
    const quotes = listQuotes(new Date("2026-08-28T12:34:05.000Z"));
    const canadian = quotes.find((quote) => quote.symbol === "SHOP.TO");
    const american = quotes.find((quote) => quote.symbol === "AAPL");

    expect(canadian).toMatchObject({ exchange: "TSX", listingCurrency: "CAD" });
    expect(canadian?.priceCadCents).toBe(canadian?.priceCents);
    expect(american).toMatchObject({ exchange: "NASDAQ", listingCurrency: "USD" });
    expect(american?.priceCadCents).toBe(
      Math.round(
        ((american?.priceCents ?? 0) * (american?.fxRateBasisPoints ?? 0)) /
          10_000,
      ),
    );
    expect(searchInstruments("tsx").every((quote) => quote.exchange === "TSX")).toBe(true);
  });

  it("keeps the quote source replaceable behind a provider seam", () => {
    const fallback = new DeterministicMarketDataProvider();
    const provider: MarketDataProvider = {
      id: "TEST_PROVIDER",
      quote(instrument, at) {
        const base = fallback.quote(instrument, at);
        return { ...base, priceCents: 12_345, priceCadCents: 12_345 };
      },
    };

    setMarketDataProvider(provider);

    expect(getMarketDataProvider().id).toBe("TEST_PROVIDER");
    expect(getQuote("RY.TO")?.priceCents).toBe(12_345);
  });
});
