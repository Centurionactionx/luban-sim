-- Idempotent prototype seed. Existing live balances, holdings, orders, and
-- operator changes are never deleted or reset by this script. Transaction
-- ownership belongs to the migration runner.

do $$
declare
  seed_now timestamptz := clock_timestamp();
  created_at_value timestamptz := seed_now - interval '7 days';
  starts_at_value timestamptz := seed_now - interval '4 days';
  ends_at_value timestamptz := seed_now + interval '25 days';
begin
  insert into public.users (id, name, email, role, created_at)
  values
    ('alex', 'Johnny', 'alex@demo.luban.org', 'student', created_at_value),
    ('maya', 'Menon', 'maya@demo.luban.org', 'student', created_at_value),
    ('jordan', 'Radin', 'jordan@demo.luban.org', 'student', created_at_value),
    ('host', 'Joe (Host)', 'host@demo.luban.org', 'host', created_at_value)
  on conflict do nothing;

  insert into public.competitions (
    id,
    name,
    status,
    base_currency,
    starting_cash_cents,
    starts_at,
    ends_at,
    created_at
  ) values (
    'fall-2026',
    'Luban Fall Market Challenge',
    'active',
    'CAD',
    10000000,
    starts_at_value,
    ends_at_value,
    created_at_value
  )
  on conflict (id) do nothing;

  insert into public.teams (
    id,
    competition_id,
    name,
    status,
    cash_cents,
    version,
    created_at
  ) values
    ('northstar', 'fall-2026', 'Northstar Capital', 'active', 10000000, 0, created_at_value),
    ('maple-alpha', 'fall-2026', 'Maple Alpha', 'active', 10000000, 0, created_at_value),
    ('aurora-fund', 'fall-2026', 'Aurora Fund', 'active', 10000000, 0, created_at_value),
    ('cedar-street', 'fall-2026', 'Cedar Street', 'active', 10000000, 0, created_at_value)
  on conflict (id) do nothing;

  insert into public.team_members (team_id, user_id, is_captain, joined_at)
  values
    (
      'northstar',
      'alex',
      1,
      seed_now - interval '5 days 23 hours'
    ),
    (
      'northstar',
      'maya',
      0,
      seed_now - interval '5 days 22 hours'
    ),
    (
      'northstar',
      'jordan',
      0,
      seed_now - interval '4 days 21 hours'
    )
  on conflict do nothing;

  insert into public.instruments (
    symbol,
    name,
    exchange,
    sector,
    listing_currency,
    base_price_cents,
    previous_close_cents,
    fx_rate_basis_points,
    is_active,
    auto_refresh
  ) values
    ('SHOP.TO', 'Shopify Inc.', 'TSX', 'Technology', 'CAD', 15840, 15610, 10000, 1, 1),
    ('RY.TO', 'Royal Bank of Canada', 'TSX', 'Financials', 'CAD', 21765, 21590, 10000, 1, 1),
    ('TD.TO', 'Toronto-Dominion Bank', 'TSX', 'Financials', 'CAD', 11520, 11440, 10000, 1, 1),
    ('ENB.TO', 'Enbridge Inc.', 'TSX', 'Energy', 'CAD', 6590, 6625, 10000, 1, 1),
    ('CNR.TO', 'Canadian National Railway', 'TSX', 'Industrials', 'CAD', 14480, 14390, 10000, 1, 1),
    ('XEQT.TO', 'iShares Core Equity ETF', 'TSX', 'ETF', 'CAD', 3925, 3901, 10000, 1, 1),
    ('BNS.TO', 'Bank of Nova Scotia', 'TSX', 'Financials', 'CAD', 9025, 8970, 10000, 1, 1),
    ('AAPL', 'Apple Inc.', 'NASDAQ', 'Technology', 'USD', 23845, 23610, 13600, 1, 1),
    ('MSFT', 'Microsoft Corporation', 'NASDAQ', 'Technology', 'USD', 51020, 50750, 13600, 1, 1),
    ('NVDA', 'NVIDIA Corporation', 'NASDAQ', 'Technology', 'USD', 18935, 18620, 13600, 1, 1)
  on conflict (symbol) do update set
    name = excluded.name,
    exchange = excluded.exchange,
    sector = excluded.sector,
    listing_currency = excluded.listing_currency;

  insert into public.ledger_entries (
    id,
    team_id,
    order_id,
    entry_type,
    amount_cents,
    symbol,
    quantity,
    note,
    created_at
  ) values
    ('seed-ledger-northstar', 'northstar', null, 'STARTING_CASH', 10000000, null, null, 'Competition starting balance', starts_at_value),
    ('seed-ledger-maple-alpha', 'maple-alpha', null, 'STARTING_CASH', 10000000, null, null, 'Competition starting balance', starts_at_value),
    ('seed-ledger-aurora-fund', 'aurora-fund', null, 'STARTING_CASH', 10000000, null, null, 'Competition starting balance', starts_at_value),
    ('seed-ledger-cedar-street', 'cedar-street', null, 'STARTING_CASH', 10000000, null, null, 'Competition starting balance', starts_at_value)
  on conflict (id) do nothing;

  insert into public.activity_events (
    id,
    competition_id,
    team_id,
    actor_user_id,
    type,
    title,
    detail,
    created_at
  ) values
    (
      'activity-created',
      'fall-2026',
      null,
      'host',
      'TEAM_CREATED',
      'Competition created',
      'Joe created the Luban Fall Market Challenge.',
      created_at_value
    ),
    (
      'activity-members',
      'fall-2026',
      'northstar',
      'alex',
      'MEMBER_JOINED',
      'Northstar Capital is ready',
      'Johnny, Menon, and Radin joined the shared team portfolio.',
      seed_now - interval '5 days'
    )
  on conflict (id) do nothing;

  insert into public.portfolio_snapshots (
    id,
    team_id,
    total_value_cents,
    captured_at
  )
  select
    'snapshot-northstar-' || snapshot.index,
    'northstar',
    0,
    seed_now + ((snapshot.index - 6) * interval '1 day')
  from generate_series(0, 6) as snapshot(index)
  on conflict (id) do nothing;
end
$$;

do $$
begin
  if exists (
    select 1
    from public.teams as team
    left join public.ledger_entries as entry on entry.team_id = team.id
    group by team.id, team.cash_cents
    having coalesce(sum(entry.amount_cents), 0) <> team.cash_cents
  ) then
    raise exception 'Luban seed refused: a team cash balance does not reconcile to its ledger';
  end if;
end
$$;
