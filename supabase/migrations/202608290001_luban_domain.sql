-- Luban's server connects through Supabase's pooled POSTGRES_URL. The browser
-- must not query these ledger tables directly, so RLS is enabled without any
-- anon/authenticated policies. Re-running this migration is safe. Transaction
-- ownership belongs to the migration runner so it can hold an advisory lock.

create table if not exists public.schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default clock_timestamp()
);

create table if not exists public.users (
  id text primary key,
  name text not null,
  email text not null unique,
  role text not null check (role in ('student', 'host')),
  created_at timestamptz not null
);

create table if not exists public.competitions (
  id text primary key,
  name text not null,
  status text not null check (status in ('draft', 'active', 'paused', 'ended')),
  base_currency text not null default 'CAD' check (base_currency = 'CAD'),
  starting_cash_cents bigint not null check (starting_cash_cents >= 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null
);

create table if not exists public.teams (
  id text primary key,
  competition_id text not null references public.competitions(id) on delete cascade,
  name text not null,
  status text not null check (status in ('active', 'frozen', 'disqualified')),
  cash_cents bigint not null check (cash_cents >= 0),
  version bigint not null default 0 check (version >= 0),
  created_at timestamptz not null,
  unique (competition_id, name)
);

create table if not exists public.team_members (
  team_id text not null references public.teams(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  is_captain smallint not null default 0 check (is_captain in (0, 1)),
  joined_at timestamptz not null,
  primary key (team_id, user_id),
  unique (user_id)
);

create table if not exists public.instruments (
  symbol text primary key,
  name text not null,
  exchange text not null,
  sector text not null,
  listing_currency text not null check (listing_currency in ('CAD', 'USD')),
  base_price_cents bigint not null check (base_price_cents > 0),
  previous_close_cents bigint not null check (previous_close_cents > 0),
  fx_rate_basis_points bigint not null check (fx_rate_basis_points > 0),
  is_active smallint not null default 1 check (is_active in (0, 1)),
  auto_refresh smallint not null default 1 check (auto_refresh in (0, 1))
);

create table if not exists public.holdings (
  team_id text not null references public.teams(id) on delete cascade,
  symbol text not null references public.instruments(symbol),
  quantity bigint not null check (quantity >= 0),
  average_cost_cents bigint not null check (average_cost_cents >= 0),
  updated_at timestamptz not null,
  primary key (team_id, symbol)
);

create table if not exists public.orders (
  id text primary key,
  idempotency_key text not null unique,
  request_fingerprint text not null,
  team_id text not null references public.teams(id) on delete cascade,
  actor_user_id text not null references public.users(id),
  symbol text not null references public.instruments(symbol),
  side text not null check (side in ('BUY', 'SELL')),
  quantity bigint not null check (quantity > 0),
  fill_price_cents bigint not null check (fill_price_cents > 0),
  fill_price_cad_cents bigint not null check (fill_price_cad_cents > 0),
  gross_cents bigint not null check (gross_cents > 0),
  cash_after_cents bigint not null check (cash_after_cents >= 0),
  holding_quantity_after bigint not null check (holding_quantity_after >= 0),
  portfolio_version bigint not null check (portfolio_version >= 0),
  status text not null check (status in ('FILLED', 'REJECTED')),
  created_at timestamptz not null
);

create table if not exists public.idempotency_records (
  actor_user_id text not null references public.users(id) on delete cascade,
  idempotency_key text not null,
  request_fingerprint text not null,
  outcome_type text not null check (outcome_type in ('FILLED', 'REJECTED')),
  order_id text references public.orders(id) on delete cascade,
  result_json text,
  error_json text,
  created_at timestamptz not null,
  primary key (actor_user_id, idempotency_key),
  check (
    (
      outcome_type = 'FILLED'
      and order_id is not null
      and result_json is not null
      and error_json is null
    )
    or
    (
      outcome_type = 'REJECTED'
      and order_id is null
      and result_json is null
      and error_json is not null
    )
  )
);

create table if not exists public.ledger_entries (
  id text primary key,
  team_id text not null references public.teams(id) on delete cascade,
  order_id text references public.orders(id) on delete set null,
  entry_type text not null check (
    entry_type in ('STARTING_CASH', 'BUY', 'SELL', 'ADJUSTMENT')
  ),
  amount_cents bigint not null,
  symbol text references public.instruments(symbol),
  quantity bigint,
  note text not null,
  created_at timestamptz not null
);

create table if not exists public.activity_events (
  id text primary key,
  competition_id text not null references public.competitions(id) on delete cascade,
  team_id text references public.teams(id) on delete cascade,
  actor_user_id text references public.users(id) on delete set null,
  type text not null,
  title text not null,
  detail text not null,
  created_at timestamptz not null
);

create table if not exists public.portfolio_snapshots (
  id text primary key,
  team_id text not null references public.teams(id) on delete cascade,
  total_value_cents bigint not null check (total_value_cents >= 0),
  captured_at timestamptz not null
);

create table if not exists public.sessions (
  token_hash text primary key,
  user_id text not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists idx_activity_competition_created
  on public.activity_events (competition_id, created_at desc);
create index if not exists idx_activity_team_created
  on public.activity_events (team_id, created_at desc);
create index if not exists idx_orders_team_created
  on public.orders (team_id, created_at desc);
create index if not exists idx_holdings_symbol_quantity
  on public.holdings (symbol, quantity);
create index if not exists idx_idempotency_order
  on public.idempotency_records (order_id);
create index if not exists idx_snapshots_team_captured
  on public.portfolio_snapshots (team_id, captured_at asc);
create index if not exists idx_sessions_user
  on public.sessions (user_id);
create index if not exists idx_instruments_auto_refresh
  on public.instruments (auto_refresh, is_active);

alter table public.users enable row level security;
alter table public.schema_migrations enable row level security;
alter table public.competitions enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.instruments enable row level security;
alter table public.holdings enable row level security;
alter table public.orders enable row level security;
alter table public.idempotency_records enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.activity_events enable row level security;
alter table public.portfolio_snapshots enable row level security;
alter table public.sessions enable row level security;

-- Supabase creates these roles. The conditional block also keeps the migration
-- runnable against a plain PostgreSQL instance used for verification.
do $$
declare
  table_name text;
  role_name text;
begin
  foreach table_name in array array[
    'schema_migrations',
    'users',
    'competitions',
    'teams',
    'team_members',
    'instruments',
    'holdings',
    'orders',
    'idempotency_records',
    'ledger_entries',
    'activity_events',
    'portfolio_snapshots',
    'sessions'
  ] loop
    foreach role_name in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format(
          'revoke all privileges on table public.%I from %I',
          table_name,
          role_name
        );
      end if;
    end loop;
  end loop;
end
$$;
