-- Price checker for limit, stop loss, and take profit orders.
--
-- Run once in the Supabase SQL editor (Database -> Extensions must have
-- pg_cron and pg_net enabled). Replace <CRON_SECRET> with the same value set
-- as CRON_SECRET in Vercel (Production). Every minute it calls the app's
-- checker, but only while at least one order is waiting, so quiet periods
-- cost nothing.
--
-- To change it later, run cron.unschedule('luban-working-orders') first.
-- To check it is running: select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'luban-working-orders')
--   order by start_time desc limit 10;

select cron.schedule(
  'luban-working-orders',
  '* * * * *',
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
