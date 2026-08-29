import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { loginAs, resetPrototype } from "./support/api";

const SHOP_QUOTE = {
  symbol: "SHOP.TO",
  name: "Shopify Inc.",
  exchange: "TSX",
  sector: "Technology",
  listingCurrency: "CAD",
  priceCents: 11_235,
  priceCadCents: 11_235,
  previousCloseCents: 10_720,
  previousCloseCadCents: 10_720,
  changeCents: 515,
  changePercent: 4.8,
  fxRateBasisPoints: 10_000,
  asOf: "2026-08-26T13:45:00.000Z",
  source: "YAHOO_FINANCE",
  sourceUrl: "https://finance.yahoo.com/quote/SHOP.TO/",
  isStale: false,
} as const;

// Two bars around each session boundary make an overnight wall-clock jump
// unambiguous while keeping the fixture compact. Values are intentionally
// distinct so pointer and keyboard assertions cannot pass on the wrong bar.
const FIVE_DAY_POINTS = [
  {
    at: "2026-08-24T19:30:00.000Z",
    openCents: 9_990,
    highCents: 10_080,
    lowCents: 9_970,
    closeCents: 10_025,
    volume: 101_001,
  },
  {
    at: "2026-08-24T19:45:00.000Z",
    openCents: 10_025,
    highCents: 10_180,
    lowCents: 10_010,
    closeCents: 10_150,
    volume: 102_002,
  },
  {
    at: "2026-08-25T13:30:00.000Z",
    openCents: 10_930,
    highCents: 11_015,
    lowCents: 10_900,
    closeCents: 10_975,
    volume: 201_003,
  },
  {
    at: "2026-08-25T13:45:00.000Z",
    openCents: 10_975,
    highCents: 11_020,
    lowCents: 10_780,
    closeCents: 10_825,
    volume: 202_004,
  },
  {
    at: "2026-08-25T19:30:00.000Z",
    openCents: 10_825,
    highCents: 11_120,
    lowCents: 10_810,
    closeCents: 11_040,
    volume: 203_005,
  },
  {
    at: "2026-08-25T19:45:00.000Z",
    openCents: 11_040,
    highCents: 11_210,
    lowCents: 11_020,
    closeCents: 11_160,
    volume: 204_006,
  },
  {
    at: "2026-08-26T13:30:00.000Z",
    openCents: 10_680,
    highCents: 10_760,
    lowCents: 10_650,
    closeCents: 10_720,
    volume: 301_007,
  },
  {
    at: "2026-08-26T13:45:00.000Z",
    openCents: 10_720,
    highCents: 11_250,
    lowCents: 10_700,
    closeCents: 11_235,
    volume: 302_008,
  },
] as const;

const FIVE_DAY_RESPONSE = {
  quote: SHOP_QUOTE,
  history: {
    symbol: "SHOP.TO",
    range: "5D",
    interval: "15m",
    listingCurrency: "CAD",
    exchangeTimeZone: "America/Toronto",
    points: FIVE_DAY_POINTS,
    asOf: FIVE_DAY_POINTS.at(-1)!.at,
    fetchedAt: "2026-08-26T13:46:00.000Z",
    source: "YAHOO_FINANCE",
    sourceUrl: "https://finance.yahoo.com/quote/SHOP.TO/",
    isStale: false,
  },
} as const;

test.beforeEach(async ({ request }) => {
  await resetPrototype(request);
});

async function installFiveDayHistoryFixture(page: Page): Promise<void> {
  await page.route("**/api/quotes/history?**", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("symbol") === "SHOP.TO" &&
      url.searchParams.get("range") === "5D"
    ) {
      await route.fulfill({ json: FIVE_DAY_RESPONSE });
      return;
    }
    await route.fallback();
  });
}

async function openFiveDayChart(
  context: BrowserContext,
  page: Page,
): Promise<ReturnType<Page["locator"]>> {
  await installFiveDayHistoryFixture(page);
  await loginAs(context.request, "alex");
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();

  const quoteChart = page.getByLabel("SHOP.TO price chart");
  await quoteChart.getByRole("button", { name: "5D" }).click();
  await expect(quoteChart).toContainText("15m bars");
  await expect(quoteChart.locator("[data-chart-point]")).toHaveCount(
    FIVE_DAY_POINTS.length,
  );
  return quoteChart;
}

function numericAttribute(value: string | null, attribute: string): number {
  expect(value, `${attribute} should be present`).not.toBeNull();
  const parsed = Number(value);
  expect(Number.isFinite(parsed), `${attribute} should be numeric`).toBe(true);
  return parsed;
}

test("5D history compresses closed-market time and keeps one continuous line across sessions", async ({
  context,
  page,
}) => {
  const quoteChart = await openFiveDayChart(context, page);
  const interactiveChart = quoteChart.locator(
    '.chart--interactive[data-chart-mode="market"][data-gap-scale="compressed"]',
  );
  await expect(interactiveChart).toBeVisible();

  const points = interactiveChart.locator("circle[data-chart-point]");
  const xCoordinates = await points.evaluateAll((nodes) =>
    nodes.map((node) => Number(node.getAttribute("cx"))),
  );
  expect(xCoordinates.every(Number.isFinite)).toBe(true);

  const intradayGap = xCoordinates[1] - xCoordinates[0];
  const firstOvernightGap = xCoordinates[2] - xCoordinates[1];
  const secondOvernightGap = xCoordinates[6] - xCoordinates[5];
  expect(intradayGap).toBeGreaterThan(0);
  expect(firstOvernightGap).toBeCloseTo(intradayGap, 1);
  expect(secondOvernightGap).toBeCloseTo(intradayGap, 1);

  const pathData = await interactiveChart.locator("path.chart__line").getAttribute("d");
  expect(pathData).not.toBeNull();
  expect(pathData!.match(/\bM/g)).toHaveLength(1);
  expect(pathData!.match(/\bL/g)).toHaveLength(FIVE_DAY_POINTS.length - 1);
});

test("pointer hover reports the exact API timestamp and OHLC close for an older bar", async ({
  context,
  page,
}) => {
  const quoteChart = await openFiveDayChart(context, page);
  const interactiveChart = quoteChart.locator(".chart--interactive");
  const expectedPoint = FIVE_DAY_POINTS[3];
  const point = interactiveChart.locator(
    `circle[data-chart-point][data-at="${expectedPoint.at}"]`,
  );
  await expect(point).toHaveCount(1);

  const chartBox = await interactiveChart.boundingBox();
  const svgBox = await interactiveChart.locator("svg").boundingBox();
  expect(chartBox).not.toBeNull();
  expect(svgBox).not.toBeNull();
  const viewBoxWidth = 640;
  const pointX = numericAttribute(await point.getAttribute("cx"), "cx");
  const pointY = numericAttribute(await point.getAttribute("cy"), "cy");
  const viewBoxHeight = 250;
  await page.mouse.move(
    svgBox!.x + (pointX / viewBoxWidth) * svgBox!.width,
    svgBox!.y + (pointY / viewBoxHeight) * svgBox!.height,
  );

  const tooltip = interactiveChart.locator("[data-chart-tooltip]");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator("time")).toHaveAttribute("datetime", expectedPoint.at);
  await expect(tooltip).toContainText("Close");
  await expect(tooltip).toContainText("$108.25");
  await expect(tooltip).toContainText("Open");
  await expect(tooltip).toContainText("High");
  await expect(tooltip).toContainText("Low");
  await expect(tooltip).toContainText("Volume");
});

test("Left and Right Arrow keys move the historical inspector one exact bar", async ({
  context,
  page,
}) => {
  const quoteChart = await openFiveDayChart(context, page);
  const interactiveChart = quoteChart.locator(".chart--interactive");
  const tooltipTime = interactiveChart.locator("[data-chart-tooltip] time");

  await interactiveChart.focus();
  await expect(interactiveChart).toBeFocused();
  await expect(tooltipTime).toHaveAttribute("datetime", FIVE_DAY_POINTS.at(-1)!.at);

  await interactiveChart.press("ArrowLeft");
  await expect(tooltipTime).toHaveAttribute("datetime", FIVE_DAY_POINTS.at(-2)!.at);
  await expect(interactiveChart.locator("[data-chart-tooltip]")).toContainText(
    "$107.20",
  );

  await interactiveChart.press("ArrowRight");
  await expect(tooltipTime).toHaveAttribute("datetime", FIVE_DAY_POINTS.at(-1)!.at);
  await expect(interactiveChart.locator("[data-chart-tooltip]")).toContainText(
    "$112.35",
  );
});

test("the interactive historical inspector does not create page overflow at 320px", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 780 } });
  try {
    const page = await context.newPage();
    const quoteChart = await openFiveDayChart(context, page);
    const interactiveChart = quoteChart.locator(".chart--interactive");
    await interactiveChart.focus();
    await interactiveChart.press("Home");
    for (let index = 0; index < 4; index += 1) {
      await interactiveChart.press("ArrowRight");
    }
    await expect(
      interactiveChart.locator("[data-chart-tooltip] time"),
    ).toHaveAttribute("datetime", FIVE_DAY_POINTS[4].at);
    await expect(interactiveChart.locator("[data-chart-tooltip]")).toBeVisible();

    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      document:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(overflow).toEqual({ body: 0, document: 0 });

    const tooltipBox = await interactiveChart
      .locator("[data-chart-tooltip]")
      .boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(320);
  } finally {
    await context.close();
  }
});
