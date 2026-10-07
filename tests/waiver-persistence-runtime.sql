\set ON_ERROR_STOP on
begin;
set timezone='UTC';
set request.jwt.claim.role='service_role';

-- The harness supplies the minimal canonical booking tables before replaying the
-- waiver migration. These assertions execute the actual functions/ACLs, not SQL
-- text matching.
do $$
declare project_id uuid; booking_id uuid; waiver_id uuid; duplicate_id uuid; dispatch_id uuid;
  result record; second_claim record; reclaim record; missing_email record;
begin
  insert into public.tour_projects(id,slug,active) values(gen_random_uuid(),'8-lakes-tours',true) returning id into project_id;
  insert into public.bookings(id,project_id,public_reference) values(gen_random_uuid(),project_id,'8L-TEST01') returning id into booking_id;
  insert into public.booking_travellers(id,booking_id,position,first_name,last_name,email,date_of_birth)
    values(gen_random_uuid(),booking_id,1,'Alice','Rider','alice@example.invalid','1990-02-03');
  insert into public.booking_travellers(id,booking_id,position,first_name,last_name,email,date_of_birth)
    values(gen_random_uuid(),booking_id,2,'Alice','Rider','other-alice@example.invalid','1990-02-03');

  select * into result from public.record_rider_waiver('8L-TEST01','8-lakes-tours','Alice Rider','ALICE@example.invalid','1990-02-03',null,null,'Alice Rider','2026-10-06',repeat('legal text ',20),repeat('a',64),null,'unavailable',null);
  if result.match_status <> 'matched' or not result.should_email then raise exception 'exact rider match failed: %', result; end if;
  waiver_id := result.waiver_id;

  select * into missing_email from public.record_rider_waiver('8L-TEST01','8-lakes-tours','Alice Rider','wrong@example.invalid','1990-02-03',null,null,'Alice Rider','2026-10-06',repeat('legal text ',20),repeat('b',64),null,'unavailable',null);
  if missing_email.match_status <> 'unmatched' then raise exception 'different traveller email was falsely certified: %', missing_email; end if;

  select * into result from public.record_rider_waiver('8L-TEST01','8-lakes-tours','Alice Rider','alice@example.invalid','1990-02-03',null,null,'Alice Rider','2026-10-06',repeat('legal text ',20),repeat('a',64),null,'unavailable',null);
  duplicate_id := result.waiver_id;
  if duplicate_id <> waiver_id or result.should_email then raise exception 'submission idempotency failed: %', result; end if;

  begin
    perform * from public.record_rider_waiver('8L-TEST01','8-lakes-tours','Alice Rider','alice@example.invalid','1990-02-03',null,null,'Different Name','2026-10-06',repeat('legal text ',20),repeat('c',64),null,'unavailable',null);
    raise exception 'adult signature mismatch was accepted';
  exception when others then
    if position('rider signature must match rider name' in sqlerrm)=0 then raise; end if;
  end;

  insert into public.booking_travellers(id,booking_id,position,first_name,last_name,email,date_of_birth)
    values(gen_random_uuid(),booking_id,3,'Minor','Rider','minor@example.invalid','2010-02-03');
  begin
    perform * from public.record_rider_waiver('8L-TEST01','8-lakes-tours','Minor Rider','minor@example.invalid','2010-02-03','Guardian Rider','parent','Wrong Guardian','2026-10-06',repeat('legal text ',20),repeat('d',64),null,'unavailable',null);
    raise exception 'minor guardian mismatch was accepted';
  exception when others then
    if position('guardian signature must match guardian name' in sqlerrm)=0 then raise; end if;
  end;
  select * into result from public.record_rider_waiver('8L-TEST01','8-lakes-tours','Minor Rider','minor@example.invalid','2010-02-03','Guardian Rider','parent','Guardian Rider','2026-10-06',repeat('legal text ',20),repeat('e',64),null,'unavailable',null);
  if not result.is_minor or result.match_status <> 'matched' then raise exception 'minor guardian valid signature rejected: %', result; end if;

  select * into result from public.claim_rider_waiver_email_dispatch(waiver_id,'rider','alice@example.invalid',gen_random_uuid(),clock_timestamp());
  if not result.should_send then raise exception 'first durable dispatch claim failed: %', result; end if;
  dispatch_id := result.dispatch_id;
  select * into second_claim from public.claim_rider_waiver_email_dispatch(waiver_id,'rider','attacker@example.invalid',gen_random_uuid(),clock_timestamp());
  if second_claim.should_send or second_claim.recipient_email <> 'alice@example.invalid' then raise exception 'active dispatch leaked/replaced recipient: %', second_claim; end if;
  if not public.mark_rider_waiver_email_provider_attempted(dispatch_id,(select claim_token from public.rider_waiver_email_dispatches where id=dispatch_id),clock_timestamp()) then raise exception 'could not mark provider attempt'; end if;
  if not public.complete_rider_waiver_email_dispatch(dispatch_id,(select claim_token from public.rider_waiver_email_dispatches where id=dispatch_id),false,false,null,clock_timestamp()) then raise exception 'could not preserve unknown provider outcome'; end if;
  select * into second_claim from public.claim_rider_waiver_email_dispatch(waiver_id,'rider','attacker@example.invalid',gen_random_uuid(),clock_timestamp());
  if second_claim.should_send or second_claim.reason <> 'reconciliation_required' then raise exception 'unknown provider outcome was blindly retried: %', second_claim; end if;
end $$;

-- RLS and function ACLs: an anon role has neither direct evidence access nor RPC access.
set role anon;
do $$
begin
  begin perform 1 from public.rider_waivers; raise exception 'anon selected private waiver evidence'; exception when insufficient_privilege then null; end;
  begin perform * from public.record_rider_waiver('8L-TEST01','8-lakes-tours','Alice Rider','alice@example.invalid','1990-02-03',null,null,'Alice Rider','2026-10-06',repeat('legal text ',20),repeat('f',64),null,'unavailable',null); raise exception 'anon executed waiver RPC'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
