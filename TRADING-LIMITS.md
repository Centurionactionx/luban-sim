# Trading limits

Every rule a student runs into while trading, in one place. All of them are checked on the server when the order is placed, so the order ticket can't skip them. A few numbers can be changed in the deployment's configuration; the values below are the defaults.

## How often you can trade

| Limit | Default | Window |
| --- | --- | --- |
| Market orders | 10 per student | rolling minute |
| Market orders | 200 per student | rolling 24 hours |
| Limit, stop loss and take profit placements | 30 per student | rolling minute |
| Limit, stop loss and take profit placements | 100 per student | rolling 24 hours |
| Waiting orders open at once | 20 per team | — |

"Rolling 24 hours" means the last 24 hours from now, not a calendar day, so the count doesn't reset at midnight. There's no hourly limit.

Every new order attempt counts, filled or rejected. A retry of the same order (say, after a dropped connection) doesn't count twice and is never charged twice. When a waiting order triggers and fills, that fill doesn't use up the student's allowance.

Hitting a limit returns `429 ORDER_RATE_LIMITED`, with how long to wait.

## What a single order can be

| Rule | Limit |
| --- | --- |
| Quantity | up to 100,000 shares (or crypto lots) per order |
| Price on a limit or stop order | up to $100 million per share or lot |
| Waiting order duration | `DAY` (expires at the end of the trading day) or `GTC` (until filled, cancelled or the competition ends) |
| Bracket exits on a buy | one take profit and/or one stop loss, counted toward the 20 waiting orders |

## What a portfolio can hold

| Rule | Limit |
| --- | --- |
| One holding | no more than 25% of the team's total value, long or short |
| Different listings | 25 per team, counting holdings and waiting buys |
| Buying power | cash, minus cash set aside for waiting buys, minus what it would cost to buy back open shorts |
| Long and short | a team can't be long and short the same listing; close one side first |

Money from a short sale is owed back, so it never pays for new buys.

## What can be bought

These rules stop new buys and shorts only. Selling and buying to cover always work, so nobody gets stuck in a position.

| Rule | Error |
| --- | --- |
| Stocks and ETFs priced under $1.00 (in the listing's own currency) | `PRICE_TOO_LOW` |
| Crypto where one lot is worth under $1.00 CAD | `LOT_TOO_SMALL` |
| Listings removed from the simulator | `SYMBOL_BLOCKED` |
| ETFs or crypto when the competition hasn't turned them on | `ASSET_CLASS_DISABLED` |

Under $1, whole-cent prices round a share by 10% or more, which would make trades unfair. Because the check uses the listing's currency, a US stock at $0.95 USD is blocked even though it's worth more than $1 CAD. The order ticket shows the reason before anyone tries.

## When you can trade

- **Market hours.** Orders fill only during the listing's regular session. Outside it, orders get `MARKET_CLOSED`.
- **Competition status.** The competition must be active and inside the start and end times the host set. A host pause returns `TRADING_CLOSED`.
- **Team status.** Frozen and disqualified teams can't trade.
- **Fresh prices.** An order won't fill on a stale or halted quote (`MARKET_DATA_STALE`, `TRADING_HALTED`), or on a quote older than 20 minutes. Trading in that listing resumes once prices recover.
- **Hosts** run the competition and can't trade (`HOST_CANNOT_TRADE`).

## Fair use

Signed-in users also have per-minute request budgets for things like market data lookups, the dashboard and the watchlist. Normal use never comes close. Going over returns `429 REQUEST_RATE_LIMITED` for a few seconds.

## Admin test accounts

A platform admin's private test account skips market hours, the daily order limit, the 25% holding cap and the 25-listing cap, so admins can test at any time. It never touches a competition team.
