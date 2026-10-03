-- Post-submit abandoned-checkout cadence: at most TWO reminders per booking.
-- Stage 1 ~1h after submission (existing eligible_at anchor, still gated on
-- provider-verified expired+unpaid Sessions). Stage 2 no earlier than 24h
-- after stage 1 durably completed - no immediate catch-up. This migration is
-- additive: new column, broadened constraint, new/changed RPCs. It never
-- enrolls, backfills or contacts any existing booking; the enrollment trigger
-- (new intakes only) is untouched. The old 'abandoned_checkout' template key
-- remains valid so historical sent rows keep satisfying their constraint.
alter table public.abandoned_checkout_recovery
 add column if not exists stages jsonb not null default '{}'::jsonb;

do $$ begin
 alter table public.public_booking_notifications drop constraint public_booking_notifications_template_key_check;
 exception when undefined_object then null; end $$;
alter table public.public_booking_notifications add constraint public_booking_notifications_template_key_check
 check(template_key in ('booking_received','internal_booking_notification','abandoned_checkout','abandoned_checkout_1','abandoned_checkout_2'));

-- ============================================================================
-- Durable rollout gate (independent-review blocker B1).
-- The rollout state lives in THIS database, applied by migration, never in
-- website env vars (site env writes were unavailable: invalid token). Default
-- is OFF: until an explicit operator activation row exists, every queue, claim
-- and authorize path - including the legacy template-key functions that old
-- deployed code calls during the migration window - refuses. Fail-closed for
-- cadence sends; unrelated notifications (booking_received etc.) are untouched.
create table if not exists public.abandoned_cadence_rollout(
 one_row boolean primary key default true check(one_row),
 mode text not null default 'off' check(mode in ('off','test_allowlist','forward')),
 updated_at timestamptz not null default now());
insert into public.abandoned_cadence_rollout(one_row,mode) values(true,'off') on conflict (one_row) do nothing;

-- Immutable activation-time ledger: the moment of each operator enable is
-- recorded once and never rewritten (pre-notified activation instant).
create table if not exists public.abandoned_cadence_activation_log(
 activation_ref text not null,
 booking_id uuid not null references public.bookings(id) on delete cascade,
 activated_at timestamptz not null default now(),
 primary key(activation_ref,booking_id));
create table if not exists public.abandoned_cadence_booking_activation(
 booking_id uuid primary key references public.bookings(id) on delete cascade,
 activation_ref text not null,
 activated_at timestamptz not null default now());
create table if not exists public.abandoned_cadence_stage2_cohort(
 booking_id uuid primary key references public.bookings(id) on delete cascade,
 activation_ref text not null,
 added_at timestamptz not null default now());

-- Explicit operator enable: records the immutable activation instant and binds
-- the exact cohort booking. Later calls for the same ref/booking keep the FIRST
-- activation time (immutable); the ref never admits a second booking.
create or replace function public.abandoned_cadence_activate_booking(p_booking_id uuid,p_ref text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.checkout_service_role();
 if exists(select 1 from public.abandoned_cadence_booking_activation where activation_ref=p_ref and booking_id<>p_booking_id)
  or exists(select 1 from public.abandoned_cadence_activation_log where activation_ref=p_ref and booking_id<>p_booking_id) then
  raise exception 'activation_ref % already bound to a different booking',p_ref;
 end if;
 insert into public.abandoned_cadence_activation_log(activation_ref,booking_id) values(p_ref,p_booking_id)
  on conflict (activation_ref,booking_id) do nothing;
 insert into public.abandoned_cadence_booking_activation(booking_id,activation_ref) values(p_booking_id,p_ref)
  on conflict (booking_id) do nothing;
end $$;

create or replace function public.abandoned_cadence_gate_current()
returns text language plpgsql volatile security definer set search_path='' as $$
declare m text;
begin
 select mode into m from public.abandoned_cadence_rollout where one_row;
 return coalesce(m,'off');
end $$;

-- Gate decision for ONE booking under ONE mode. Empty allowlist default: only
-- an explicit operator activation admits a booking, and every admission
-- requires an approved activation_ref binding THAT booking.
create or replace function public.abandoned_cadence_gate_admits(p_mode text,p_booking_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare g record;
begin
 if p_mode is null or p_mode='off' then return false; end if;
 select * into g from public.abandoned_cadence_booking_activation where booking_id=p_booking_id;
 if not found or coalesce(g.activation_ref,'')='' then return false; end if;
 if not exists(select 1 from public.abandoned_cadence_activation_log
   where activation_ref=g.activation_ref and booking_id=p_booking_id) then return false; end if;
 return p_mode in ('test_allowlist','forward');
end $$;

-- ============================================================================
-- Legacy accepted-reminder accounting (independent-review blocker B2).
-- The previously deployed code sent the 'abandoned_checkout' template through
-- claim_public_booking_email_v2/finalize_public_booking_email_v2 and recorded
-- accepted sends in email_events. Those accepted reminders ARE stage 1 for
-- dedupe: seed the durable stage journal from that sent ledger using the
-- ledger's own verified sent_at timestamp - never a fabricated clock. Seeding
-- is idempotent and only touches bookings with no stage-1 record yet; queued/
-- failed/ambiguous legacy attempts are NOT seeded (no blind stage-1 send under
-- a new key for an outcome nobody verified) - those fence through the claim
-- paths below, and genuinely ambiguous attempts older than the 23h
-- idempotency window go to operator review.
create or replace function public.abandoned_cadence_seed_legacy_stage1()
returns integer language plpgsql security definer set search_path='' as $$
declare seeded integer:=0;
begin
 perform public.checkout_service_role();
 with legacy_sent as (
  select e.booking_id,min(e.sent_at) as sent_at
  from public.email_events e
  where e.template_key='abandoned_checkout' and e.status='sent'
   and e.sent_at is not null and e.booking_id is not null
  group by e.booking_id)
 update public.abandoned_checkout_recovery q
  set stages=jsonb_set(q.stages,array['abandoned_checkout_1'],jsonb_strip_nulls(jsonb_build_object(
   'completed_at',l.sent_at,'attempted_at',l.sent_at,
   'provider_message_id',(select e.provider_message_id from public.email_events e
     where e.booking_id=l.booking_id and e.template_key='abandoned_checkout'
      and e.status='sent' and e.sent_at=l.sent_at
     order by e.sent_at limit 1),
   'legacy',true)))
  from legacy_sent l
  where l.booking_id=q.booking_id
   and coalesce(q.stages->'abandoned_checkout_1'->>'completed_at','')='';
 get diagnostics seeded=row_count;
 return seeded;
end $$;

-- Stage-2 cohort fence: stage 2 is never an unsolicited historical follow-up.
-- Only bookings explicitly added to the cohort (by the same explicit operator
-- enable flow) may run stage 2.
create or replace function public.abandoned_cadence_stage2_allowed(p_booking_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.abandoned_cadence_stage2_cohort where booking_id=p_booking_id);
$$;

-- Internal single-source gate check used by every cadence entry point below.
-- Volatile on purpose: an operator gate flip must be visible to the very next
-- statement, never served from a per-statement plan cache.
create or replace function public.abandoned_cadence_gate_refuse(p_booking_id uuid,p_stage text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare mode text;
begin
 mode:=public.abandoned_cadence_gate_current();
 if not public.abandoned_cadence_gate_admits(mode,p_booking_id) then return true; end if;
 if p_stage='abandoned_checkout_2' and not public.abandoned_cadence_stage2_allowed(p_booking_id) then return true; end if;
 return false;
end $$;

revoke all on function public.abandoned_cadence_gate_current(),public.abandoned_cadence_gate_admits(text,uuid),public.abandoned_cadence_gate_refuse(uuid,text),public.abandoned_cadence_stage2_allowed(uuid),public.abandoned_cadence_activate_booking(uuid,text),public.abandoned_cadence_seed_legacy_stage1() from public,anon,authenticated;
grant execute on function public.abandoned_cadence_gate_current(),public.abandoned_cadence_gate_admits(text,uuid),public.abandoned_cadence_gate_refuse(uuid,text),public.abandoned_cadence_stage2_allowed(uuid),public.abandoned_cadence_activate_booking(uuid,text),public.abandoned_cadence_seed_legacy_stage1() to service_role;

-- ============================================================================
-- Stage clock: stage 1 due when the intake is eligible (~1h post-submission);
-- stage 2 only when stage 1 durably completed >=24h ago (open 48h, i.e. until
-- stage-1 completion + 72h), then the booking is done (max two total).
-- A provider block (no send accepted) does NOT consume the stage: it mutes the
-- stage for one bounded retry window (24h), after which the same stage is due
-- again - so a DNS/provider fix recovers reminders and stage 2 stays reachable
-- (its clock anchors on the stage-1 completion, however delayed - supporting
-- stage 2 beyond the legacy 48h intake window). No attempt means no retry:
-- untouched/expired rows are never batch-caught-up.
create or replace function public.due_abandoned_checkout_stage(p_booking_id uuid)
returns text language sql stable security definer set search_path='' as $$
 select case
  when q.stages->'abandoned_checkout_2'->>'completed_at' is not null then null
  when q.stages->'abandoned_checkout_1'->>'completed_at' is not null then
   case
    when q.stages->'abandoned_checkout_2'->>'blocked_at' is not null
     and (q.stages->'abandoned_checkout_2'->>'blocked_at')::timestamptz>clock_timestamp()-interval '24 hours' then null
    when (q.stages->'abandoned_checkout_1'->>'completed_at')::timestamptz+interval '24 hours'<=clock_timestamp()
     and clock_timestamp()<(q.stages->'abandoned_checkout_1'->>'completed_at')::timestamptz+interval '72 hours' then 'abandoned_checkout_2'
    else null end
  when q.stages->'abandoned_checkout_1'->>'blocked_at' is not null then
   case
    when (q.stages->'abandoned_checkout_1'->>'blocked_at')::timestamptz>clock_timestamp()-interval '24 hours' then null
    when clock_timestamp()<q.expires_at+interval '7 days' then 'abandoned_checkout_1'
    else null end
  when q.expires_at<=clock_timestamp() then null
  else 'abandoned_checkout_1' end
 from public.abandoned_checkout_recovery q where q.booking_id=p_booking_id;
$$;

-- Intake window widened ONLY by durable progress: a completed stage keeps the
-- booking eligible until its successor window closes (stage-1 completion +72h);
-- a provider-blocked attempt keeps the bounded retry reachable until
-- expires_at+7 days. Untouched rows still hard-expire at expires_at (48h):
-- no historical catch-up, no unbounded extension.
create or replace function public.abandoned_checkout_eligible(p_booking_id uuid,p_allowed_dates text[]) returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from public.bookings b
 join public.tour_projects p on p.id=b.project_id
 join public.abandoned_checkout_recovery q on q.booking_id=b.id
 join public.booking_checkout_ownership a on a.booking_id=b.id
 where b.id=p_booking_id and p.slug='8-lakes-tours' and p.active
 and b.submission_key is not null and b.status='awaiting_payment'
 and b.online_paid_usd=0 and b.online_due_usd>0 and b.guest_count between 1 and 8
 and b.tour_date=q.tour_date and b.tour_date=any(p_allowed_dates)
 and q.eligible_at<=clock_timestamp()
 and (q.expires_at>clock_timestamp()
   or coalesce((select bool_or(
        (v->>'completed_at' is not null
         and clock_timestamp()<(v->>'completed_at')::timestamptz+interval '72 hours')
        or (v->>'blocked_at' is not null
         and clock_timestamp()<q.expires_at+interval '7 days'))
      from jsonb_each(q.stages) as e(k,v)),false))
 and not exists(select 1 from public.payments pay where pay.booking_id=b.id and pay.status::text not in ('pending','failed')));
$$;

-- Durable per-stage completion journal. completed_at/failed_at/blocked_at are
-- written in the SAME transaction that finalizes the provider attempt, so the
-- 24h gap always anchors on a real observed send outcome, never on intent.
create or replace function public.finalize_abandoned_checkout_stage(
 p_email_event_id uuid,p_claim_token uuid,p_stage text,p_sent boolean,
 p_provider_message_id text,p_raw_response jsonb,p_provider_blocked boolean)
returns void language plpgsql security definer set search_path='' as $$
declare b uuid; attempted timestamptz;
begin
 perform public.checkout_service_role();
 update public.public_booking_notifications set status=case when p_sent then 'sent' else 'failed' end
  where email_event_id=p_email_event_id and claim_token=p_claim_token and status='queued' and template_key=p_stage
  returning booking_id, first_attempt_at into b, attempted;
 if not found then return; end if;
 if p_sent then
  update public.abandoned_checkout_recovery
   set stages=jsonb_set(stages,array[p_stage],jsonb_strip_nulls(jsonb_build_object(
    'completed_at',clock_timestamp(),'attempted_at',attempted,'provider_message_id',p_provider_message_id)))
   where booking_id=b and coalesce(stages->p_stage->>'completed_at','')='';
 else
  update public.abandoned_checkout_recovery
   set stages=jsonb_set(stages,array[p_stage],jsonb_strip_nulls(jsonb_build_object(
    'failed_at',clock_timestamp(),'attempted_at',attempted,'error',left(p_raw_response->>'error',300),
    'blocked_at',case when p_provider_blocked then clock_timestamp() end)))
   where booking_id=b and coalesce(stages->p_stage->>'completed_at','')='';
 end if;
 update public.email_events set status=case when p_sent then 'sent'::public.email_event_status else 'failed'::public.email_event_status end,
  provider_message_id=p_provider_message_id,raw_response=p_raw_response,sent_at=clock_timestamp() where id=p_email_event_id;
end $$;

-- Stage-aware claim: derives the currently-due stage from durable state and
-- stamps the stage into the payload so the runner and SQL agree on the sending
-- stage. Payload validation guards ONLY a genuinely new send; suppression
-- probes (empty/partial payloads) resolve through the lease paths below, and a
-- same claim/stage retry after failure follows the existing lease-expiry path
-- reusing the durable stored payload unchanged; a 23h-old ambiguous claim goes
-- to operator review, never a blind resend.
create or replace function public.claim_abandoned_checkout(p_booking_id uuid,p_allowed_dates text[],p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid; stage text; a public.public_booking_notifications; prior public.public_booking_notifications; payload jsonb:=p_payload;
begin
 perform public.checkout_service_role();
 -- Rollout gate first, before eligibility, locking or any state churn: a
 -- closed gate refuses every cadence send (fail-closed; unrelated notification
 -- templates keep flowing). The stage clock may run independently, but nothing
 -- is claimed, created or sent while the gate is closed.
 if public.abandoned_cadence_gate_refuse(p_booking_id,'abandoned_checkout_1') then
  return jsonb_build_object('should_send',false,'gate','off','gate_mode',public.abandoned_cadence_gate_current());
 end if;
 select customer_id into c from public.bookings where id=p_booking_id for update;
 if not public.abandoned_checkout_eligible(p_booking_id,p_allowed_dates) then return jsonb_build_object('should_send',false); end if;
 stage:=public.due_abandoned_checkout_stage(p_booking_id);
 if stage is null then return jsonb_build_object('should_send',false); end if;
 -- Stage-2-specific cohort fence on top of the general gate.
 if stage='abandoned_checkout_2' and not public.abandoned_cadence_stage2_allowed(p_booking_id) then
  return jsonb_build_object('should_send',false,'gate','stage2_cohort');
 end if;
 select * into a from public.public_booking_notifications
  where booking_id=p_booking_id and template_key=stage for update;
 if found then
  if a.status in ('sent','review') or (a.status='queued' and a.lease_until>clock_timestamp()) then
   return jsonb_build_object('should_send',false);
  end if;
  -- A provider-blocked attempt (e.g. unverified sending domain) carries durable
  -- proof that NOTHING was accepted, so it is not an ambiguous outcome: the
  -- bounded retry may reuse the same attempt row after the block window, and
  -- must NOT be forced into operator review (that would permanently lose the
  -- reminder after a DNS fix). Any other failure older than the idempotency
  -- window goes to operator review, never a blind resend.
  if not exists(select 1 from public.abandoned_checkout_recovery
    where booking_id=p_booking_id and stages->stage->>'blocked_at' is not null
    and (stages->stage->>'failed_at')::timestamptz>=a.first_attempt_at) then
   if a.first_attempt_at<clock_timestamp()-interval '23 hours' then
    update public.public_booking_notifications set status='review' where email_event_id=a.email_event_id;
    update public.email_events set status='failed',raw_response=jsonb_build_object('error','Ambiguous abandoned-checkout send: reconcile provider logs before retry; idempotency window elapsed') where id=a.email_event_id;
    return jsonb_build_object('should_send',false);
   end if;
  end if;
  update public.public_booking_notifications set status='queued',claim_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '15 minutes'
   where email_event_id=a.email_event_id returning * into a;
  update public.email_events set status='queued' where id=a.email_event_id;
 else
  -- New-send path only: full payload validation is preserved here, never
  -- weakened. Suppression and retry paths above never require p_payload.
  -- Legacy-key ambiguity fence (B2): an unresolved queued attempt under the OLD
  -- deployed template key is an outcome nobody verified. Inside the 23h
  -- idempotency window the legacy attempt may still finalize, so no parallel
  -- fresh send; older than that it is ambiguous - move it to operator review
  -- and refuse, never a blind stage-1 send under the new key.
  select * into prior from public.public_booking_notifications
   where booking_id=p_booking_id and template_key='abandoned_checkout' and status='queued' for update;
  if found then
   if prior.first_attempt_at<clock_timestamp()-interval '23 hours' then
    update public.public_booking_notifications set status='review' where email_event_id=prior.email_event_id;
    update public.email_events set status='failed',raw_response=jsonb_build_object('error','Ambiguous abandoned-checkout send: reconcile provider logs before retry; idempotency window elapsed') where id=prior.email_event_id;
   end if;
   return jsonb_build_object('should_send',false);
  end if;
  if payload->>'to' is null or payload->>'subject' is null then raise exception 'invalid email payload'; end if;
  payload:=jsonb_set(payload,'{stage}',to_jsonb(stage));
  insert into public.email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status,public_submission_email_key)
  values(p_booking_id,c,stage,payload->>'to',payload->>'subject',payload->>'text','website-form','queued',p_booking_id::text||':'||stage) returning id into a.email_event_id;
  insert into public.public_booking_notifications(booking_id,template_key,email_event_id,payload,status)
  values(p_booking_id,stage,a.email_event_id,payload,'queued') returning * into a;
 end if;
 return jsonb_build_object('should_send',true,'email_event_id',a.email_event_id,'claim_token',a.claim_token,'payload',a.payload);
end $$;

-- Post-claim authorization: stage must STILL be due (fresh paid/cancelled or
-- an advanced stage all refuse), session evidence unchanged, claim lease live.
create or replace function public.authorize_abandoned_checkout_v3(
 p_booking_id uuid,p_claim_token uuid,p_allowed_dates text[],p_generation uuid,p_expired_sessions text[],p_stage text)
returns boolean language plpgsql security definer set search_path='' as $$
declare a public.booking_checkout_ownership;
begin
 perform public.checkout_service_role();
 perform 1 from public.bookings where id=p_booking_id for update;
 -- Rollout gate re-checked at the send-commit boundary: a claim taken before a
 -- gate close (or before an operator flip) must never authorize afterwards.
 if public.abandoned_cadence_gate_refuse(p_booking_id,'abandoned_checkout_1') then return false; end if;
 if not public.abandoned_checkout_eligible(p_booking_id,p_allowed_dates) then return false; end if;
 if public.due_abandoned_checkout_stage(p_booking_id) is distinct from p_stage then return false; end if;
 -- Stage-2 cohort fence at authorization too (belt and braces with claim).
 if p_stage='abandoned_checkout_2' and not public.abandoned_cadence_stage2_allowed(p_booking_id) then return false; end if;
 select * into a from public.booking_checkout_ownership where booking_id=p_booking_id;
 -- Send-commit boundary: review fences are re-checked here with fresh readback
 -- (claim-time flags churn as side effects of payment/status probes, so the
 -- durable gate for invalidated or terms-drifted ownership is authorization).
 return coalesce(not (a.invalidated or a.terms_invalidated)
  and (select to_jsonb(bb) from public.bookings bb where bb.id=p_booking_id) @> a.expected
  and a.generation=p_generation and a.session_id=any(p_expired_sessions)
  and not exists(select 1 from public.payments where booking_id=p_booking_id and not (stripe_checkout_session_id=any(p_expired_sessions)))
  and exists(select 1 from public.public_booking_notifications where booking_id=p_booking_id and template_key=p_stage
   and status='queued' and claim_token=p_claim_token and lease_until>clock_timestamp()),false);
end $$;

-- Queue: only rows whose durable stage is currently due and claimable.
drop function if exists public.list_abandoned_checkouts(text[]);
create function public.list_abandoned_checkouts(p_allowed_dates text[])
returns table(booking_id uuid,public_reference text,email text,stage text,eligible_at timestamptz) language plpgsql security definer set search_path='' as $$
begin
 perform public.checkout_service_role();
 return query select b.id,b.public_reference,t.email,public.due_abandoned_checkout_stage(b.id) as stage,q.eligible_at
  from public.abandoned_checkout_recovery q
  join public.bookings b on b.id=q.booking_id
  join public.booking_travellers t on t.booking_id=b.id and t.position=1
  left join public.public_booking_notifications n on n.booking_id=b.id and n.template_key=public.due_abandoned_checkout_stage(b.id)
  where public.abandoned_checkout_eligible(b.id,p_allowed_dates)
  and public.due_abandoned_checkout_stage(b.id) is not null
  -- Durable rollout gate (blocker B1): a closed gate yields an empty queue.
  and not public.abandoned_cadence_gate_refuse(b.id,public.due_abandoned_checkout_stage(b.id))
  and (public.due_abandoned_checkout_stage(b.id)='abandoned_checkout_1' or public.abandoned_cadence_stage2_allowed(b.id))
  and t.email is not null
  and (n.booking_id is null or n.status='failed' or (n.status='queued' and n.lease_until<=clock_timestamp()))
  order by q.eligible_at,b.id limit 20;
end $$;
-- Evidence for the runner: durable stage state + the due stage + the eligibility
-- anchor, so the JS side can refuse to send outside the SQL-derived cadence even
-- against a stale queue view. Always current via due_abandoned_checkout_stage.
create or replace function public.read_abandoned_checkout_evidence(p_booking_id uuid,p_allowed_dates text[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.booking_checkout_ownership;b public.bookings;
begin
 perform public.checkout_service_role();
 select * into b from public.bookings where id=p_booking_id for update;
 if not public.abandoned_checkout_eligible(p_booking_id,p_allowed_dates) then return null; end if;
 select * into a from public.booking_checkout_ownership where booking_id=b.id;
 return jsonb_build_object('generation',a.generation,'session_id',a.session_id,'customer_id',b.customer_id,'guest_count',b.guest_count,'amount_cents',b.online_due_usd*100,
 'stage',public.due_abandoned_checkout_stage(b.id),'stages',(select stages from public.abandoned_checkout_recovery where booking_id=b.id),'eligible_at',(select eligible_at from public.abandoned_checkout_recovery where booking_id=b.id),'expires_at',(select expires_at from public.abandoned_checkout_recovery where booking_id=b.id),
 'session_ids',(select jsonb_agg(distinct pay.stripe_checkout_session_id) from public.payments pay where pay.booking_id=b.id));
end $$;

revoke all on function public.list_abandoned_checkouts(text[]) from public,anon,authenticated;
revoke all on function public.due_abandoned_checkout_stage(uuid),public.finalize_abandoned_checkout_stage(uuid,uuid,text,boolean,text,jsonb,boolean),public.authorize_abandoned_checkout_v3(uuid,uuid,text[],uuid,text[],text) from public,anon,authenticated;
grant execute on function public.due_abandoned_checkout_stage(uuid),public.finalize_abandoned_checkout_stage(uuid,uuid,text,boolean,text,jsonb,boolean),public.authorize_abandoned_checkout_v3(uuid,uuid,text[],uuid,text[],text) to service_role;

-- ============================================================================
-- Legacy send-commit boundary under the SAME durable gate (blocker B1).
-- Old deployed code (HEAD-era website build) still calls
-- claim_public_booking_email_v2 + authorize_abandoned_checkout_v2 during the
-- migration window; until an operator flips this durable switch, that legacy
-- abandon-checkout reminder must refuse here even though the old binary has no
-- knowledge of the gate. This is a no-op for unrelated notifications: they
-- never pass through this function.
create or replace function public.authorize_abandoned_checkout_v2(
 p_booking_id uuid,p_claim_token uuid,p_allowed_dates text[],p_generation uuid,p_expired_sessions text[])
returns boolean language plpgsql security definer set search_path='' as $$
declare a public.booking_checkout_ownership;
begin
 perform public.checkout_service_role();
 perform 1 from public.bookings where id=p_booking_id for update;
 -- Same durable gate, legacy path: fail-closed while OFF/unactivated.
 if public.abandoned_cadence_gate_refuse(p_booking_id,'abandoned_checkout_1') then return false; end if;
 if not public.abandoned_checkout_eligible(p_booking_id,p_allowed_dates) then return false; end if;
 select * into a from public.booking_checkout_ownership where booking_id=p_booking_id;
 return coalesce(a.generation=p_generation and a.session_id=any(p_expired_sessions)
 and not exists(select 1 from public.payments where booking_id=p_booking_id and not (stripe_checkout_session_id=any(p_expired_sessions)))
 and exists(select 1 from public.public_booking_notifications where booking_id=p_booking_id and template_key='abandoned_checkout'
  and status='queued' and claim_token=p_claim_token and lease_until>clock_timestamp()),false);
end $$;
revoke all on function public.authorize_abandoned_checkout_v2(uuid,uuid,text[],uuid,text[]) from public,anon,authenticated;
grant execute on function public.authorize_abandoned_checkout_v2(uuid,uuid,text[],uuid,text[]) to service_role;
revoke all on function public.claim_abandoned_checkout(uuid,text[],jsonb) from public,anon,authenticated;
grant execute on function public.claim_abandoned_checkout(uuid,text[],jsonb) to service_role;
