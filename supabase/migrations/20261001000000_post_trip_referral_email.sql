-- Post-trip thank-you and referral email (template 'post_trip_referral').
--
-- Additive only: the lifecycle claim is reproduced exactly from
-- 20260924010000_external_email_attestations.sql with one new template key,
-- and that key alone may reach a 'completed' booking. Every pre-trip template
-- keeps its original key list and booking-status eligibility. No rows change.
--
-- The website only selects this template when POST_TRIP_EMAIL_ENABLED=true, so
-- apply this migration first, read the function back, then set the flag.

alter table public.lifecycle_email_dispatches drop constraint lifecycle_email_dispatches_template_key_check;
alter table public.lifecycle_email_dispatches add constraint lifecycle_email_dispatches_template_key_check
  check (template_key in ('payment_confirmed','preparation_packing','insurance_final_check','arrival_coordination','final_checklist','post_trip_referral'));

CREATE OR REPLACE FUNCTION public.claim_lifecycle_email_dispatch(p_booking_id uuid, p_customer_id uuid, p_template_key text, p_to_email text, p_subject text, p_body_snapshot text, p_sent_by text, p_claim_token uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b public.bookings; d public.lifecycle_email_dispatches; eid uuid; day_utc date := (p_now at time zone 'UTC')::date;
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
    or (p_template_key='post_trip_referral' and b.status not in ('confirmed','prep_sent','ready_for_departure','completed')) then
    return jsonb_build_object('should_send',false,'reason','booking_ineligible');
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
          when 'post_trip_referral' then 'post_trip_referral'
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
      update public.email_events set status='queued',claim_token=p_claim_token,claimed_at=p_now,provider_attempted_at=null,provider_completed_at=null,provider_message_id=null,raw_response=jsonb_build_object('retrying',true) where id=d.email_event_id and status='failed';
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
  update public.bookings set lifecycle_email_token=p_claim_token,lifecycle_email_claimed_at=p_now,lifecycle_email_provider_attempted_at=null where id=b.id;
  select email_event_id into eid from public.lifecycle_email_dispatches where booking_id=b.id and utc_day=day_utc;
  return jsonb_build_object('should_send',true,'event_id',eid,'idempotency_key','8l-lifecycle-'||eid::text);
end $function$
;
revoke all on function public.claim_lifecycle_email_dispatch(uuid,uuid,text,text,text,text,text,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_lifecycle_email_dispatch(uuid,uuid,text,text,text,text,text,uuid,timestamptz) to service_role;
