# Security

**Joseph Wang**, Lead Developer and AI Security Engineer

Market Lab runs a real competition with real students, and the people most likely to poke at it are the students themselves, often with an AI agent doing the poking. So the protections here are aimed at two things. Nobody should be able to give their team money the market didn't give them, and nobody should be able to knock the site offline or burn through its hosting budget mid-competition. This page lists what's in place.

## Students and their data

Many of the students who use Market Lab are minors at secondary schools, so the app was built with the privacy and cybersecurity expectations of the school boards our participants come from in mind: the Toronto District School Board, the York Region District School Board, the Toronto Catholic District School Board, Conseil scolaire Viamonde, Conseil scolaire catholique MonAvenir, the Peel District School Board and the Waterloo Region District School Board.

In practice that means the app keeps as little about a student as it can. It stores a display name, the email the invitation was sent to and their team, plus the trades they place. There's no payment information, no location, no tracking for advertising, and nothing is sold or shared. Students can see only their own team's portfolio and activity, never another student's email. Anyone can delete their own account from the account page, and rosters and database backups never leave the machines they're made on.

## Accounts and access

Registration is invite-only. A host creates a single-use invitation link, the token behind it is 256 bits of randomness stored only as a hash, and it expires. Sign-in runs through Clerk, but roles, teams and account status live in our own database and the server checks them on every request. Nothing a user can edit in their Clerk profile decides what they're allowed to do, and accounts are only linked by verified email.

Every host and admin route checks the caller's role on the server. The routes that change cash or holdings re-check that role inside the same database transaction that makes the change, so an account demoted or suspended a second earlier can't slip one last edit through. Suspended accounts are refused even with a live session. Hosts and admins can be required to sign in with a second factor before touching any host control, exports included, and students never see that step.

A student can only read their own team's holdings, orders and activity. Demo mode, which lets anyone switch identities for local testing, is switched off in code on every Vercel deployment no matter what the environment says.

## Trading integrity

The browser never sends a price, a cash amount or a timestamp that the server trusts. It sends the symbol, the side and the quantity. The server fetches the quote itself, refuses to fill on a stale one, and refuses orders outside each exchange's regular hours. Limit and stop orders fill at the live price when they trigger, never at the trigger price and never at a price from before the order existed.

Every trade runs under a lock on the team's row with a version check, and the database itself refuses negative cash or negative share counts as a last line of defence. Two orders racing each other can't both spend the same dollar or sell the same share. Each order also carries a retry key, so a network hiccup that makes the browser send the same order twice still produces exactly one fill.

Some limits keep the game fair and keep scripts from going wild. A team can hold at most 25 different stocks, with no more than a quarter of its portfolio in any one. A student can place 10 orders a minute and 200 a day. Stocks priced under $1 can't be bought or shorted, because whole-cent prices round them by 10% or more and a bot could farm the rounding. They still show up in search, with a banner explaining why. Splits are handled by hand if one ever comes up.

## Keeping the site up

The site runs on free tiers, so a flood of requests is a real threat to the competition even when it can't break anything. Vercel's firewall rate-limits the API per network, challenges anything that isn't a real browser, and turns away known AI crawlers and agents. Requests it stops never reach the app and don't count against the monthly quota. If an attack does get through, attack mode can put every visitor behind a challenge with one command.

Inside the app, each signed-in user has a request budget that's checked before any database work happens, and the public pages that do touch the database are throttled per network. Market data comes from Yahoo, and one student hammering lookups could otherwise get the whole site blocked. So every Yahoo call shares one small pool, and the first sign of rate-limiting stops all calls for two minutes, across every server, instead of making things worse. The dashboard stops polling in tabs nobody is looking at and slows down when markets are closed.

Database queries give up after a few seconds of waiting instead of piling up. One user's burst of orders is queued so it can't take every database connection. Daily caps on orders, waiting orders and feedback stop anyone from filling the database, and a nightly job clears out caches and expired records. It never touches orders, the ledger or anything else that makes up the competition record.

## The code and its supply chain

Every page ships with a strict Content Security Policy built on a fresh nonce for each request, so if a script injection bug ever slips in, the injected script won't run. Pages can't be framed by other sites. Every state-changing request has to come from the app's own origin, and request bodies are size-capped and validated before use. Error messages never echo database details or stack traces, and spreadsheet exports are escaped so a team name can't run as a formula when a host opens the file.

Dependencies are audited and kept patched. Secrets live only in Vercel's encrypted settings, never in the repository, and a `.vercelignore` keeps database backups, rosters and local data out of any upload. Database connections verify the server's certificate, and every table has row-level security switched on, so the database's public API can't read or write anything.

## Reporting a problem

If you find a security issue, please don't post it publicly or test it against the live competition. Send it to Joseph Wang through the contact link on [lubancanada.com](https://lubancanada.com) and it'll get looked at quickly.
