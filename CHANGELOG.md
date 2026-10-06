# Changelog

What's changed in each release of the Luban Market Lab, newest first.
Releases before v1.28.0 didn't have numbers, so they're listed by date.

<!-- Generated from lib/changelog.ts by `pnpm changelog`. Edit that file, not this one. -->

## v1.40.0: A clearer portfolio summary and leaderboard (2026-10-06)

### New

- If your team isn't in the top five, its row is pinned under the leaderboard so you can always see where you stand.

### Improved

- A redesigned portfolio summary. Today's and total return sit beside your total, a bar shows how it splits into holdings, buying power and cash set aside for waiting buys (with your cash total beside it), and the ? buttons explain set aside, unrealized and realized gains.
- A change of exactly zero shows in grey without a plus sign, on the portfolio summary, the leaderboard and everywhere else gains appear.
- The leaderboard shows each team's return as a bar on one shared scale, which runs to at least ±10% so small moves look small. In the narrow side panel, a team's value moves under its name.
- The Watch button beside a quote's price has a star.
- Hosts and admins get a new Accounts page: an invite bar, a roster of team cards showing who signed in recently, and a panel with each person's details.

## v1.39.0: The Luban logo and account deletion (2026-10-06)

### New

- Delete your own account from the Account page. A public page at /delete-account explains what's removed, what your team keeps, and how to ask for deletion if you can't sign in.
- If your connection drops, you'll see a page saying you're offline instead of a browser error. It reloads by itself when you're back online.

### Improved

- The Luban bridge logo now appears in the header, on the sign-in and other standalone pages, in your browser tab, and in the preview when you share an invitation link.

## v1.38.0: Ready for a full class (2026-10-05)

### Improved

- Each minute's update is about 93% smaller. It only carries the prices your screen shows and the new points on your portfolio chart, not every stock anyone has looked up.
- Servers share the prices they fetch, so a busy class asks Yahoo Finance for each price about once a minute instead of once per server.
- Your browser makes one less request a minute: the price of the stock on screen now comes with the regular update.

### Fixed

- On a busy day, watchlist prices could show a dash until you opened the stock.

## v1.37.1: Flat buttons in the dark theme (2026-10-05)

### Improved

- Purple buttons and the stock badge in the dark theme are a flat lavender instead of a gradient.

## v1.37.0: A compact order ticket and display names (2026-10-05)

### New

- Change the name your team sees from the Account page. It updates the header, your team's member list and every trade you've placed.
- The portfolio map credits the Finviz stock market map that inspired it, with a link.

### Improved

- A more compact order ticket. Your choices sit on the left and a receipt on the right adds up the total and shows the cash or shares you'll have left. Take profit and stop loss fold away until you add them.
- Students no longer see the Host controls panel at all.
- Account and Sign out moved into a menu that opens when you hover over your name (or tap it). Platform admins also find the valuation lab and user feedback there.
- A refreshed dark theme: neutral near-black panels that float on soft shadows instead of bright outlines, with purple kept for buttons, charts and highlights.
- The app always opens in the light theme, even if your device is set to dark. Switch to dark with the sun/moon button in the header and it'll stay that way.

## v1.36.0: Team watchlists and trade history (2026-10-05)

### New

- Team watchlist. Press Watch beside a quote's price to add it. Your whole team shares one list of up to 20 symbols, and each row has a small chart of today's price. Sort it by symbol, price or the day's move.
- A trade history panel. It shows who placed each trade and what every sale made or lost, and can load your last 100 trades.
- Holdings now show what you paid per share on average. The portfolio splits its gain into unrealized (shares you still hold) and realized (shares you've sold).
- Download your holdings or your full trade history as a CSV file.
- A dark theme. It matches your device until you flip it with the sun/moon button in the header, and it remembers your pick.
- Platform admins can reset their private test portfolio back to the cash they funded it with.
- A Feedback button in the header, and a /feedback page, for telling us what's working and what isn't on the website or in the simulator. Platform admins read it all in one list.
- This What's new page. Click the version number in the footer to get here.

### Fixed

- The Sell button's label used to vanish when you hovered over it.
- Two trades filled in the same instant could show up in the wrong order.

## v1.35.1: Mobile fixes (2026-10-05)

### Fixed

- On phones, the Advanced view header now wraps so its close button stays on screen. The price readout wraps too instead of getting cut off.
- Hovering or tapping the cash area on the portfolio map no longer pulls it on top of your holdings.

## v1.35.0: Activity bell and How to use link (2026-10-05)

### New

- Team activity lives in a bell in the header now. A red bubble counts what you haven't seen yet.
- A How to use link to the beginner's guide on lubancanada.com.

### Improved

- The portfolio's update counter explains what it's counting.

## v1.34.0: Advanced charts and the portfolio map (2026-10-04)

### New

- Advanced chart view. Switch between line, candle and bar styles, pick your own date range and bar size, and read open, high, low, close and volume for any bar.
- Portfolio map: a treemap of your holdings grouped by sector and industry, coloured by total return or by today's move. Hosts and admins can open any team's map from the leaderboard.

### Improved

- Charts got proper price and time axes and volume bars, plus lines marking the current price and yesterday's close.
- Max and All now ask before filling in the ticket. The 1W portfolio history range is called 7D.

## v1.33.0: Detached dashboard tiles (2026-10-04)

### Improved

- Each part of the dashboard now sits on the purple background as its own card, with the quote workbench in the middle.

## v1.32.0: Live quote before a waiting order (2026-10-04)

### Fixed

- Limit, stop loss and take profit orders sometimes got refused as "paused" right after a server started up. They now fetch a live price before placing.

## v1.31.0: Limit, stop loss and take profit orders (2026-10-04)

### New

- Limit, stop loss and take profit orders. They wait for your price and last for the day or until you cancel them.
- Exits on a buy. Attach a take profit and a stop loss, and whichever fills first cancels the other.
- A Waiting orders panel. Anyone on the team can see and cancel the team's orders there.
- Prices get checked every minute, and each order that hits its price fills exactly once.

### Improved

- Cash and shares tied up in waiting orders are set aside, so they don't count toward buying power.

## v1.30.0: Groundwork for waiting orders (2026-10-03)

### New

- Behind-the-scenes work for limit, stop loss and take profit orders. Nothing visible in the app yet.

## v1.29.0: Full version in the footer (2026-10-03)

### Improved

- The footer shows the full version number and links to the maker's profiles.

## v1.28.0: Release number in the footer (2026-10-03)

### New

- The footer shows which release you're on and who built the simulator.

## 2026-10-03: Crypto, ETFs and quicker search

### New

- ETFs and crypto, each switched on separately. Crypto trades around the clock in fixed lots. Leveraged and inverse funds aren't allowed.
- Suggestions show up under the search box as you type, starting with listings the page already knows about.
- Click the empty search box to see popular picks, like what the competition traded most and the day's busiest stocks.
- Max / All fills in the biggest quantity you can afford or hold. Press / anywhere to jump to the search box.

### Improved

- When the order button is greyed out, it tells you why: the market's closed, the competition isn't running, your team is frozen, or you're short on cash or shares.
- Search prefers CAD crypto pairs and opens the best match, so typing btc gets you Bitcoin.
- The portfolio value chart works for real teams now and its range buttons actually filter. The big number at the top is cash plus holdings, the same figure the leaderboard uses.

### Fixed

- Times all show in Eastern time. Before, the page could error on load when your computer and the server were in different time zones.
- If market data goes down, holdings keep their last known price instead of breaking the dashboard.
- The chart's hover box sits next to the bar you're pointing at instead of on top of it.

## 2026-10-02: Database keep-alive

### New

- A daily job pings the hosted database so it doesn't go to sleep.

## 2026-09-24: Trading integrity and rules links

### Improved

- Competition orders only go through during the exchange's regular hours and on a recent price. You can't trade after-hours news at yesterday's prices.
- The sign-in, sign-up and invitation pages link to the contest rules and the privacy policy.

### Security

- If a host is removed or loses their role, their unused invitations stop working. Every invitation also re-checks who sent it when someone accepts it.
- A team whose books don't balance no longer stops trading for everyone else. Server error details stay in the server log.

## 2026-09-12: Team management

### New

- Hosts can add, rename and remove teams from a compact set of team controls.

## 2026-09-01: Admin test portfolios

### New

- Platform admins get a private test portfolio with its own cash. It trades like a team but never shows up on the leaderboard.

## 2026-08-30: Real sign-in and competition schedules

### New

- Real accounts. You can only sign up with an invitation, and every account is a student, host or admin. Sign-ins and account changes go in an audit log.
- Competition schedules. Hosts set the start, the end and the starting cash, and trading opens and closes on its own.
- Hosts and admins can suspend accounts, change roles, move people between teams and delete accounts.
- PostgreSQL support next to the local SQLite database, plus a health check endpoint.
- The Past → Present valuation lab for admins.

### Security

- Limits on how fast anyone can place orders, send invitations or reload the dashboard, along with fixes from a full security review.

## 2026-08-29: First prototype

### New

- The shared team trading room. A team portfolio, quotes and charts from real market data, market orders and the competition leaderboard.
