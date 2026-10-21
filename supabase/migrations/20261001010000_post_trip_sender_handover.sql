-- One database-authorized post-trip sender. The deployed default remains the
-- legacy Ops feedback sender until an owner explicitly calls the handover RPC.
create table if not exists public.post_trip_sender_control (
  singleton boolean primary key default true check (singleton),
  active_owner text not null check (active_owner in ('legacy','public')),
  activated_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.post_trip_sender_control enable row level security;
revoke all on public.post_trip_sender_control from public, anon, authenticated;
grant select, insert, update, delete on public.post_trip_sender_control to service_role;
insert into public.post_trip_sender_control(singleton,active_owner) values(true,'legacy') on conflict (singleton) do nothing;

create or replace function public.set_post_trip_sender_owner(p_owner text)
returns void language plpgsql security definer set search_path to '' as $$
begin
 perform public.checkout_service_role();
 if p_owner not in ('legacy','public') then raise exception 'invalid post-trip sender owner'; end if;
 perform 1 from public.post_trip_sender_control where singleton=true for update;
 if exists (select 1 from public.email_events where template_key in ('post_trip_followup','post_trip_referral') and status='queued')
 then raise exception 'post-trip sender handover blocked by unresolved queued dispatch'; end if;
 update public.post_trip_sender_control set active_owner=p_owner,activated_at=clock_timestamp(),updated_at=clock_timestamp() where singleton=true;
end $$;
revoke all on function public.set_post_trip_sender_owner(text) from public, anon, authenticated;
grant execute on function public.set_post_trip_sender_owner(text) to service_role;

create or replace function public.claim_post_trip_email_dispatch(p_owner text,p_booking_id uuid,p_customer_id uuid,p_template_key text,p_to_email text,p_subject text,p_body_snapshot text,p_sent_by text,p_claim_token uuid,p_now timestamptz default clock_timestamp())
returns jsonb language plpgsql security definer set search_path to '' as $$
declare b public.bookings; control public.post_trip_sender_control; eid uuid;
begin
 perform public.checkout_service_role();
 if p_owner<>'legacy' or p_template_key<>'post_trip_followup' or p_claim_token is null or nullif(trim(p_to_email),'') is null or nullif(trim(p_subject),'') is null then raise exception 'invalid post-trip dispatch claim'; end if;
 select * into b from public.bookings where id=p_booking_id and customer_id=p_customer_id for update;
 if not found or b.status<>'completed' or b.status='cancelled' then return jsonb_build_object('should_send',false,'reason','booking_ineligible'); end if;
 select * into control from public.post_trip_sender_control where singleton=true for update;
 -- Missing/corrupt control must default-deny; SQL's NULL comparison would
 -- otherwise fall through and authorize the legacy sender.
 if not found or control.active_owner is distinct from p_owner then return jsonb_build_object('should_send',false,'reason','post_trip_sender_not_owner'); end if;
 if exists(select 1 from public.email_events where booking_id=b.id and template_key in ('post_trip_followup','post_trip_referral') and status in ('sent','delivered')) then return jsonb_build_object('should_send',false,'reason','lifecycle_already_attested'); end if;
 if exists(select 1 from public.email_events where booking_id=b.id and template_key in ('post_trip_followup','post_trip_referral') and status='queued') then return jsonb_build_object('should_send',false,'reason','unresolved_post_trip_provider_outcome'); end if;
 insert into public.email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status,is_canonical,claim_token,claimed_at,raw_response)
 values(b.id,p_customer_id,p_template_key,p_to_email,p_subject,p_body_snapshot,p_sent_by,'queued',true,p_claim_token,p_now,jsonb_build_object('queued',true,'post_trip_owner',p_owner)) returning id into eid;
 return jsonb_build_object('should_send',true,'event_id',eid,'idempotency_key','8l-post-trip-'||eid::text);
end $$;

create or replace function public.mark_post_trip_email_provider_attempted(p_booking_id uuid,p_event_id uuid,p_claim_token uuid,p_now timestamptz default clock_timestamp())
returns boolean language plpgsql security definer set search_path to '' as $$
begin
 perform public.checkout_service_role();
 update public.email_events set provider_attempted_at=p_now where id=p_event_id and booking_id=p_booking_id and template_key='post_trip_followup' and status='queued' and claim_token=p_claim_token::text;
 return found;
end $$;

create or replace function public.complete_post_trip_email_dispatch(p_booking_id uuid,p_event_id uuid,p_claim_token uuid,p_sent boolean,p_definite_failure boolean,p_provider_message_id text,p_raw_response jsonb,p_now timestamptz default clock_timestamp())
returns boolean language plpgsql security definer set search_path to '' as $$
begin
 perform public.checkout_service_role();
 if not p_sent and not p_definite_failure then update public.email_events set raw_response=coalesce(p_raw_response,'{}'::jsonb)||jsonb_build_object('reconciliation_required',true),provider_completed_at=p_now where id=p_event_id and booking_id=p_booking_id and template_key='post_trip_followup' and status='queued' and claim_token=p_claim_token::text; return found; end if;
 update public.email_events set status=case when p_sent then 'sent'::public.email_event_status else 'failed'::public.email_event_status end,provider_message_id=p_provider_message_id,provider_completed_at=p_now,raw_response=coalesce(p_raw_response,'{}'::jsonb),claim_token=null,claimed_at=null where id=p_event_id and booking_id=p_booking_id and template_key='post_trip_followup' and status='queued' and claim_token=p_claim_token::text;
 return found;
end $$;
revoke all on function public.claim_post_trip_email_dispatch(text,uuid,uuid,text,text,text,text,text,uuid,timestamptz),public.mark_post_trip_email_provider_attempted(uuid,uuid,uuid,timestamptz),public.complete_post_trip_email_dispatch(uuid,uuid,uuid,boolean,boolean,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_post_trip_email_dispatch(text,uuid,uuid,text,text,text,text,text,uuid,timestamptz),public.mark_post_trip_email_provider_attempted(uuid,uuid,uuid,timestamptz),public.complete_post_trip_email_dispatch(uuid,uuid,uuid,boolean,boolean,text,jsonb,timestamptz) to service_role;

-- The public lifecycle claimant takes the same row lock after the booking lock.
-- Do not activate public ownership until the public deployment and recipient review are complete.
create or replace function public.post_trip_public_owner_allows()
returns boolean language sql security definer set search_path to '' as $$
 select coalesce((select active_owner='public' from public.post_trip_sender_control where singleton=true),false)
$$;
revoke all on function public.post_trip_public_owner_allows() from public,anon,authenticated;
grant execute on function public.post_trip_public_owner_allows() to service_role;

-- Replace the public claimant so it participates in the same locked owner decision.
CREATE OR REPLACE FUNCTION public.claim_lifecycle_email_dispatch(p_booking_id uuid, p_customer_id uuid, p_template_key text, p_to_email text, p_subject text, p_body_snapshot text, p_sent_by text, p_claim_token uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b public.bookings; d public.lifecycle_email_dispatches; control public.post_trip_sender_control; eid uuid; day_utc date := (p_now at time zone 'UTC')::date;
begin
  perform public.checkout_service_role();
  if p_claim_token is null or p_template_key not in ('payment_confirmed','preparation_packing','insurance_final_check','arrival_coordination','final_checklist','post_trip_referral')
    or nullif(trim(p_to_email),'') is null or nullif(trim(p_subject),'') is null then
    raise exception 'invalid lifecycle dispatch claim';
  end if;
  select * into b from public.bookings where id=p_booking_id and customer_id=p_customer_id for update;
  -- Only the post-trip email may reach a completed booking; every pre-trip
  -- template keeps its original eligibility unchanged.
  if not found or b.status='cancelled'
    or (p_template_key<>'post_trip_referral' and b.status not in ('awaiting_payment','confirmed','prep_sent','ready_for_departure'))
    or (p_template_key='post_trip_referral' and b.status<>'completed') then
    return jsonb_build_object('should_send',false,'reason','booking_ineligible');
  end if;
  if p_template_key='post_trip_referral' then
    select * into control from public.post_trip_sender_control where singleton=true for update;
    -- Default-deny when the singleton has not been inserted or is malformed.
    if not found or control.active_owner is distinct from 'public' then
      return jsonb_build_object('should_send',false,'reason','post_trip_sender_not_owner');
    end if;
  end if;
  -- A successful customer email recorded by either automatic delivery or the
  -- Gmail-attestation RPC wins over a stale automatic preflight. This runs only
  -- after the booking lock, so the manual writer and every automatic claimant
  -- share one serialized cross-system deduplication decision.
  if exists(
    select 1 from public.email_events e
    where e.booking_id=b.id and e.status in ('sent','delivered')
      and e.template_key in (
        p_template_key,
        case p_template_key
          when 'payment_confirmed' then 'booking_confirmed'
          when 'preparation_packing' then 'packing_list'
          when 'insurance_final_check' then 'insurance_reminder'
          when 'arrival_coordination' then 'arrival_details'
          when 'final_checklist' then 'final_checklist'
          when 'post_trip_referral' then 'post_trip_followup'
        end
      )
  ) then
    return jsonb_build_object('should_send',false,'reason','lifecycle_already_attested');
  end if;
  -- A cancellation/deletion action uses this same booking-level token. An absent
  -- timestamp is unknown, never treated as a stale lease.
  if b.lifecycle_email_token is not null and (b.lifecycle_email_claimed_at is null or b.lifecycle_email_claimed_at >= p_now-interval '5 minutes') then
    return jsonb_build_object('should_send',false,'reason','booking_lifecycle_lease_active');
  end if;
  -- Any queued/ambiguous provider outcome blocks every later lifecycle template.
  if exists(select 1 from public.lifecycle_email_dispatches x where x.booking_id=b.id and x.status in ('queued','reconciliation_required')) then
    return jsonb_build_object('should_send',false,'reason','unresolved_lifecycle_provider_outcome');
  end if;
  select * into d from public.lifecycle_email_dispatches where booking_id=b.id and utc_day=day_utc for update;
  if found then
    if d.status='sent' then return jsonb_build_object('should_send',false,'reason','lifecycle_already_sent_utc_day'); end if;
    if d.status='failed' and d.template_key=p_template_key and d.provider_attempted_at is not null then
      update public.lifecycle_email_dispatches set status='queued',claim_token=p_claim_token,claimed_at=p_now,provider_attempted_at=null,provider_completed_at=null,updated_at=clock_timestamp() where booking_id=b.id and utc_day=day_utc;
      update public.email_events set status='queued',claim_token=p_claim_token::text,claimed_at=p_now,provider_attempted_at=null,provider_completed_at=null,provider_message_id=null,raw_response=jsonb_build_object('retrying',true) where id=d.email_event_id and status='failed';
      if not found then raise exception 'lifecycle retry event conflict'; end if;
    else
      return jsonb_build_object('should_send',false,'reason','lifecycle_day_claim_unavailable');
    end if;
  else
    insert into public.email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status,is_canonical,claim_token,claimed_at,raw_response)
    values(b.id,p_customer_id,p_template_key,p_to_email,p_subject,p_body_snapshot,p_sent_by,'queued',true,p_claim_token,p_now,jsonb_build_object('queued',true)) returning id into eid;
    insert into public.lifecycle_email_dispatches(booking_id,utc_day,template_key,email_event_id,status,claim_token,claimed_at)
    values(b.id,day_utc,p_template_key,eid,'queued',p_claim_token,p_now);
  end if;
  update public.bookings set lifecycle_email_token=p_claim_token::text,lifecycle_email_claimed_at=p_now,lifecycle_email_provider_attempted_at=null where id=b.id;
  select email_event_id into eid from public.lifecycle_email_dispatches where booking_id=b.id and utc_day=day_utc;
  return jsonb_build_object('should_send',true,'event_id',eid,'idempotency_key','8l-lifecycle-'||eid::text);
end $function$
;
revoke all on function public.claim_lifecycle_email_dispatch(uuid,uuid,text,text,text,text,text,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_lifecycle_email_dispatch(uuid,uuid,text,text,text,text,text,uuid,timestamptz) to service_role;

-- Correct the UUID-token completion path used by the public sender.
create or replace function public.complete_lifecycle_email_dispatch(
 p_booking_id uuid,p_event_id uuid,p_claim_token uuid,p_sent boolean,p_definite_failure boolean,p_provider_message_id text,p_raw_response jsonb,p_now timestamptz default clock_timestamp()
) returns boolean language plpgsql security definer set search_path='' as $$
declare final_status text;
begin
 perform public.checkout_service_role();
 if not p_sent and not p_definite_failure then
   update public.lifecycle_email_dispatches set status='reconciliation_required',provider_completed_at=p_now,updated_at=clock_timestamp() where booking_id=p_booking_id and email_event_id=p_event_id and status='queued' and claim_token=p_claim_token;
   if not found then return false; end if;
   update public.email_events set raw_response=coalesce(p_raw_response,'{}'::jsonb)||jsonb_build_object('reconciliation_required',true),provider_completed_at=p_now where id=p_event_id and status='queued' and claim_token=p_claim_token::text;
   update public.bookings set lifecycle_email_token=null,lifecycle_email_claimed_at=null,lifecycle_email_provider_attempted_at=null where id=p_booking_id and lifecycle_email_token=p_claim_token::text;
   return true;
 end if;
 final_status:=case when p_sent then 'sent' else 'failed' end;
 update public.lifecycle_email_dispatches set status=final_status,provider_completed_at=p_now,updated_at=clock_timestamp() where booking_id=p_booking_id and email_event_id=p_event_id and status='queued' and claim_token=p_claim_token;
 if not found then return false; end if;
 update public.email_events set status=final_status::public.email_event_status,provider_message_id=p_provider_message_id,provider_completed_at=p_now,raw_response=coalesce(p_raw_response,'{}'::jsonb),claim_token=null,claimed_at=null where id=p_event_id and status='queued' and claim_token=p_claim_token::text;
 if not found then raise exception 'lifecycle completion email event conflict'; end if;
 update public.bookings set lifecycle_email_token=null,lifecycle_email_claimed_at=null,lifecycle_email_provider_attempted_at=null where id=p_booking_id and lifecycle_email_token=p_claim_token::text;
 if not found then raise exception 'lifecycle completion booking lease lost'; end if;
 return true;
end $$;
