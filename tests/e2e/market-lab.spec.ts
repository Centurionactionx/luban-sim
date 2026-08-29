import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  loginAs,
  readDashboard,
  resetPrototype,
  type DemoUserId,
} from "./support/api";

test.beforeEach(async ({ request }) => {
  await resetPrototype(request);
});

async function openAs(
  context: BrowserContext,
  page: Page,
  userId: DemoUserId,
): Promise<void> {
  await loginAs(context.request, userId);
  await page.goto("/");
  await expect(page.getByLabel("Switch demo user")).toHaveValue(userId);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
}

async function placeOneShareBuy(page: Page): Promise<void> {
  await page.getByRole("spinbutton", { name: /Quantity/ }).fill("1");
  await page.getByRole("button", { name: "Place simulated buy" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /BUY 1 SHOP\.TO filled once/ }),
  ).toBeVisible();
}

async function reloadSyncedPage(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
}

test("an unauthenticated visitor is safely signed into the default demo account", async ({
  context,
  page,
}) => {
  await context.clearCookies();
  const beforeLogin = await page.request.get("/api/auth/session");
  expect(beforeLogin.status()).toBe(200);
  await expect(beforeLogin.json()).resolves.toMatchObject({
    authenticated: false,
    demoUsers: expect.arrayContaining([expect.objectContaining({ id: "alex" })]),
  });

  await page.goto("/");

  await expect(page.getByLabel("Switch demo user")).toHaveValue("alex");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Team portfolio", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Northstar Capital", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Portfolio value", exact: true }),
  ).toContainText("$0.00");
  await expect(
    page
      .getByText("Cash (CAD)", { exact: true })
      .locator("..")
      .getByText("$100,000.00", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/No holdings yet/)).toBeVisible();
  await expect(page.getByLabel("Prototype disclosure")).toContainText(
    "Simulated trading only. No real money or investment advice.",
  );

  const afterLogin = await page.request.get("/api/auth/session");
  expect(afterLogin.ok()).toBeTruthy();
  await expect(afterLogin.json()).resolves.toMatchObject({
    authenticated: true,
    user: { id: "alex", role: "student" },
  });
});

test("market prices and the shared ledger both use a one-minute cadence", async ({
  context,
  page,
}) => {
  const dashboardRefreshModes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/dashboard") {
      dashboardRefreshModes.push(url.searchParams.get("refreshMarket") ?? "default");
    }
  });

  await openAs(context, page, "alex");
  await expect(
    page.getByText("Team ledger every 60 seconds", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Market prices every 60 seconds", { exact: true }),
  ).toBeVisible();

  const cadence = page.locator(".status-cadence");
  await expect(cadence).toHaveAttribute("data-team-sync-ms", "60000");
  await expect(cadence).toHaveAttribute("data-market-refresh-ms", "60000");
  expect(dashboardRefreshModes).toContain("1");
});

test("search results can resolve a niche supported stock without preloading every price", async ({
  context,
  page,
}) => {
  const quote = {
    symbol: "DAKT",
    name: "Daktronics, Inc.",
    exchange: "NASDAQ",
    sector: "Technology",
    listingCurrency: "USD",
    priceCents: 1_842,
    priceCadCents: 2_505,
    previousCloseCents: 1_795,
    previousCloseCadCents: 2_441,
    changeCents: 47,
    changePercent: 2.62,
    fxRateBasisPoints: 13_600,
    asOf: "2026-08-28T15:30:00.000Z",
    source: "YAHOO_FINANCE",
    sourceUrl: "https://finance.yahoo.com/quote/DAKT/",
    isStale: false,
  } as const;

  await page.route("**/api/quotes**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/quotes" && url.searchParams.has("q")) {
      await route.fulfill({
        json: {
          results: [
            {
              symbol: "DAKT",
              name: "Daktronics, Inc.",
              exchange: "NASDAQ",
              sector: "Technology",
              listingCurrency: "USD",
            },
            {
              symbol: "DRX.TO",
              name: "ADF Group Inc.",
              exchange: "TSX",
              sector: "Industrials",
              listingCurrency: "CAD",
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/quotes" && url.searchParams.get("symbol") === "DAKT") {
      await route.fulfill({ json: { results: [quote] } });
      return;
    }
    if (
      url.pathname === "/api/quotes/history" &&
      url.searchParams.get("symbol") === "DAKT"
    ) {
      await route.fulfill({
        json: {
          quote,
          history: {
            symbol: "DAKT",
            range: url.searchParams.get("range") ?? "1D",
            interval: "5m",
            listingCurrency: "USD",
            exchangeTimeZone: "America/New_York",
            points: [
              { at: "2026-08-28T15:25:00.000Z", openCents: 1_825, highCents: 1_835, lowCents: 1_820, closeCents: 1_830, volume: 1_200 },
              { at: "2026-08-28T15:30:00.000Z", openCents: 1_830, highCents: 1_845, lowCents: 1_828, closeCents: 1_842, volume: 1_500 },
            ],
            asOf: "2026-08-28T15:30:00.000Z",
            fetchedAt: "2026-08-28T15:30:05.000Z",
            source: "YAHOO_FINANCE",
            sourceUrl: "https://finance.yahoo.com/quote/DAKT/",
            isStale: false,
          },
        },
      });
      return;
    }
    await route.fallback();
  });

  await openAs(context, page, "alex");
  await page.getByLabel("Search supported symbols").fill("display maker");
  await page.getByRole("button", { name: "Search symbols" }).click();

  const results = page.getByRole("region", { name: "Symbol results" });
  await expect(results.getByRole("button", { name: /DAKT.*Daktronics.*NASDAQ/ })).toBeVisible();
  await expect(results.getByRole("button", { name: /DRX\.TO.*ADF Group.*TSX/ })).toBeVisible();
  await results.getByRole("button", { name: /DAKT.*Daktronics.*NASDAQ/ }).click();

  await expect(page.getByRole("heading", { name: "DAKT", exact: true })).toBeVisible();
  await expect(page.getByLabel("DAKT price chart")).toContainText("5m bars");
  await expect(page.getByPlaceholder("NYSE / NASDAQ / TSX")).toBeVisible();
});

test("quote ranges request and render distinct timestamped history", async ({
  context,
  page,
}) => {
  await openAs(context, page, "alex");
  const quoteChart = page.getByLabel("SHOP.TO price chart");
  await expect(quoteChart).toContainText("5m bars");
  const path = quoteChart.locator("path.chart__line");
  const oneDayPath = await path.getAttribute("d");

  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/quotes/history" && url.searchParams.get("range") === "5D";
  });
  await quoteChart.getByRole("button", { name: "5D" }).click();
  const response = await responsePromise;

  expect(response.ok()).toBeTruthy();
  await expect(quoteChart).toContainText("15m bars");
  await expect(path).not.toHaveAttribute("d", oneDayPath ?? "");
  await expect(quoteChart).toContainText(
    "Raw close · trading gaps compressed · CAD",
  );
});

test("a student BUY renders one committed result and replays idempotently", async ({
  context,
  page,
}) => {
  await openAs(context, page, "alex");
  const before = await readDashboard(context.request);

  const orderRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/orders",
  );
  await placeOneShareBuy(page);

  const orderRequest = await orderRequestPromise;
  const firstResponse = await orderRequest.response();
  expect(firstResponse).not.toBeNull();
  expect(firstResponse!.status()).toBe(201);
  const firstReceipt = (await firstResponse!.json()) as {
    duplicate: boolean;
    order: { id: string; quantity: number; symbol: string };
    portfolioVersion: number;
  };
  expect(firstReceipt).toMatchObject({
    duplicate: false,
    order: { quantity: 1, symbol: "SHOP.TO" },
    portfolioVersion: before.team!.version + 1,
  });

  const idempotencyKey = orderRequest.headers()["idempotency-key"];
  expect(idempotencyKey).toBeTruthy();
  const replay = await context.request.post("/api/orders", {
    data: orderRequest.postDataJSON(),
    headers: { "Idempotency-Key": idempotencyKey },
  });
  expect(replay.status()).toBe(201);
  const replayReceipt = (await replay.json()) as typeof firstReceipt;
  expect(replayReceipt).toMatchObject({
    duplicate: true,
    order: { id: firstReceipt.order.id },
    portfolioVersion: firstReceipt.portfolioVersion,
  });

  const after = await readDashboard(context.request);
  expect(after.team!.version).toBe(firstReceipt.portfolioVersion);
  expect(after.portfolio!.cashCents).toBeLessThan(before.portfolio!.cashCents);
  expect(
    after.recentActivity.filter(
      (item) => item.type === "ORDER_FILLED" && /Johnny.*1 share.*SHOP\.TO/i.test(item.detail),
    ),
  ).toHaveLength(1);
});

test("Johnny and Menon observe the same committed team version and attribution", async ({
  browser,
}) => {
  const alexContext = await browser.newContext();
  const mayaContext = await browser.newContext();

  try {
    const alexPage = await alexContext.newPage();
    const mayaPage = await mayaContext.newPage();
    await Promise.all([
      openAs(alexContext, alexPage, "alex"),
      openAs(mayaContext, mayaPage, "maya"),
    ]);

    const before = await readDashboard(alexContext.request);
    await Promise.all([
      alexPage.getByRole("spinbutton", { name: /Quantity/ }).fill("1"),
      mayaPage.getByRole("spinbutton", { name: /Quantity/ }).fill("1"),
    ]);
    await Promise.all([
      alexPage.getByRole("button", { name: "Place simulated buy" }).click(),
      mayaPage.getByRole("button", { name: "Place simulated buy" }).click(),
    ]);
    await Promise.all([
      expect(
        alexPage.getByRole("status").filter({
          hasText: /BUY 1 SHOP\.TO filled once/,
        }),
      ).toBeVisible(),
      expect(
        mayaPage.getByRole("status").filter({
          hasText: /BUY 1 SHOP\.TO filled once/,
        }),
      ).toBeVisible(),
    ]);

    const [alexAfter, mayaAfter] = await Promise.all([
      readDashboard(alexContext.request),
      readDashboard(mayaContext.request),
    ]);
    const committedVersion = alexAfter.team!.version;
    expect(committedVersion).toBe(before.team!.version + 2);

    await Promise.all([
      reloadSyncedPage(alexPage),
      reloadSyncedPage(mayaPage),
    ]);

    await Promise.all([
      expect(
        alexPage.getByText(`v${committedVersion} shared`, { exact: true }),
      ).toBeVisible({ timeout: 8_000 }),
      expect(
        mayaPage.getByText(`v${committedVersion} shared`, { exact: true }),
      ).toBeVisible({ timeout: 8_000 }),
      expect(
        alexPage.getByRole("listitem").filter({
          hasText: /Menon bought 1 share of SHOP\.TO/i,
        }),
      ).toBeVisible({ timeout: 8_000 }),
      expect(
        mayaPage.getByRole("listitem").filter({
          hasText: /Johnny bought 1 share of SHOP\.TO/i,
        }),
      ).toBeVisible({ timeout: 8_000 }),
    ]);

    expect(mayaAfter.team!.version).toBe(alexAfter.team!.version);
    expect(mayaAfter.portfolio!.cashCents).toBe(alexAfter.portfolio!.cashCents);
    expect(mayaAfter.holdings).toEqual(alexAfter.holdings);
    await expect(alexPage.getByLabel("Switch demo user")).toHaveValue("alex");
    await expect(mayaPage.getByLabel("Switch demo user")).toHaveValue("maya");
  } finally {
    await Promise.all([alexContext.close(), mayaContext.close()]);
  }
});

test("host controls pause trading and reversibly disqualify a team", async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const alexContext = await browser.newContext();

  try {
    const hostPage = await hostContext.newPage();
    const alexPage = await alexContext.newPage();
    await Promise.all([
      openAs(hostContext, hostPage, "host"),
      openAs(alexContext, alexPage, "alex"),
    ]);

    const studentTrade = alexPage.getByRole("button", {
      name: "Place simulated buy",
    });
    await expect(studentTrade).toBeEnabled();

    await hostPage.getByRole("button", { name: "Pause trading" }).click();
    await expect(
      hostPage.getByRole("button", { name: "Resume trading" }),
    ).toBeEnabled();
    await reloadSyncedPage(alexPage);
    await expect(studentTrade).toBeDisabled({ timeout: 8_000 });

    await hostPage.getByRole("button", { name: "Resume trading" }).click();
    await expect(
      hostPage.getByRole("button", { name: "Pause trading" }),
    ).toBeEnabled();
    await reloadSyncedPage(alexPage);
    await expect(studentTrade).toBeEnabled({ timeout: 8_000 });

    const teamManager = hostPage.getByLabel("Manage competition teams");
    const northstar = teamManager.getByRole("listitem").filter({
      hasText: "Northstar Capital",
    });
    await expect(northstar).toContainText("active");
    await northstar.getByRole("button", { name: "Disqualify" }).click();
    await expect(
      northstar.getByRole("button", { name: "Confirm disqualify" }),
    ).toBeVisible();
    await northstar.getByRole("button", { name: "Confirm disqualify" }).click();
    await expect(northstar).toContainText("disqualified");
    await reloadSyncedPage(alexPage);
    await expect(studentTrade).toBeDisabled({ timeout: 8_000 });

    await northstar.getByRole("button", { name: "Restore" }).click();
    await expect(northstar).toContainText("active");
    await reloadSyncedPage(alexPage);
    await expect(studentTrade).toBeEnabled({ timeout: 8_000 });

    const restored = await readDashboard(alexContext.request);
    expect(restored.competition.status).toBe("active");
    expect(restored.team?.status).toBe("active");
  } finally {
    await Promise.all([hostContext.close(), alexContext.close()]);
  }
});

test("the host can set a team's cash and every member receives the new balance", async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const alexContext = await browser.newContext();

  try {
    const hostPage = await hostContext.newPage();
    const alexPage = await alexContext.newPage();
    await Promise.all([
      openAs(hostContext, hostPage, "host"),
      openAs(alexContext, alexPage, "alex"),
    ]);

    const forbidden = await alexContext.request.patch(
      "/api/admin/teams/northstar/cash",
      { data: { cashCents: 1_000_000 } },
    );
    expect(forbidden.status()).toBe(403);

    const cashInput = hostPage.getByLabel("Cash for Northstar Capital");
    await expect(cashInput).toBeVisible();
    await cashInput.fill("123456.78");

    const cashResponse = hostPage.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname ===
          "/api/admin/teams/northstar/cash",
    );
    await cashInput
      .locator("../..")
      .getByRole("button", { name: "Set cash" })
      .click();
    expect((await cashResponse).status()).toBe(200);

    await expect(
      hostPage.getByRole("status").filter({
        hasText: "Northstar Capital's cash is now $123,456.78.",
      }),
    ).toBeVisible();
    await reloadSyncedPage(alexPage);
    await expect(
      alexPage
        .getByText("Cash (CAD)", { exact: true })
        .locator("..")
        .getByText("$123,456.78", { exact: true }),
    ).toBeVisible({ timeout: 8_000 });

    const dashboard = await readDashboard(alexContext.request);
    expect(dashboard.portfolio?.cashCents).toBe(12_345_678);
    expect(dashboard.recentActivity[0]).toMatchObject({
      type: "TEAM_CASH_ADJUSTED",
      actorName: "Joe (Host)",
    });
  } finally {
    await Promise.all([hostContext.close(), alexContext.close()]);
  }
});

test("the complete student task works at 320px without page-level overflow", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 780 },
  });

  try {
    const page = await context.newPage();
    await openAs(context, page, "alex");

    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      document:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(overflow).toEqual({ body: 0, document: 0 });

    await placeOneShareBuy(page);
    await expect(page.getByRole("heading", { name: "Team activity" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the loaded student workspace has no detectable axe violations", async ({
  context,
  page,
}) => {
  await openAs(context, page, "alex");

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("the production interface renders without an error overlay or browser errors", async ({
  context,
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await openAs(context, page, "alex");

  await expect(page.locator("body")).not.toHaveText("");
  await expect(
    page.locator(
      "[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay",
    ),
  ).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});
