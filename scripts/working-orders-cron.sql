-- Price checker for limit, stop loss, and take profit orders.
--
-- Run once in the Supabase SQL editor (Database -> Extensions must have
-- pg_cron and pg_net enabled). Replace <CRON_SECRET> with the same value set
-- as CRON_SECRET in Vercel (Production). Every 3 minutes on weekdays, 13:00
-- to 21:59 UTC (covering the TSX and US sessions), it calls the app's checker,
-- but only while at least one order is waiting, so quiet periods cost nothing.
-- Outside those hours, dashboard loads still run the checker as a backup.
--
-- To change it later, run cron.unschedule('luban-working-orders') first.
-- To check it is running: select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'luban-working-orders')
--   order by start_time desc limit 10;

select cron.schedule(
  'luban-working-orders',
  '*/3 13-21 * * 1-5',
  $job$
    select net.http_post(
      url := 'https://sim.lubancanada.com/api/cron/working-orders',
      headers := jsonb_build_object(
        'Authorization', 'Bearer <CRON_SECRET>',
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    )
    where exists (
      select 1 from public.working_orders
      where status in ('WORKING', 'PENDING_PARENT')
    );
  $job$
);
