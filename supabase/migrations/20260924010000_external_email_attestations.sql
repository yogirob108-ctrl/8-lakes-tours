-- Operator attestations, never provider deliveries. Preserve existing history.
create unique index email_events_external_attestation_idempotency_idx
  on public.email_events (booking_id, (raw_response->>'external_attestation_idempotency_key'))
  where raw_response ? 'external_attestation_idempotency_key';

create or replace function public.record_external_email_attestation(
  p_project_id uuid, p_reference text, p_template_key text,
  p_actual_sent_at timestamptz, p_operator_note text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  b public.bookings; previous public.email_events; email_address text;
  eid uuid; stored_key text; operator_note text:=nullif(btrim(p_operator_note),'');
  recorded_at timestamptz:=clock_timestamp();
begin
  perform public.checkout_service_role();
  -- Use the existing Ops stored vocabulary; all consumers already support it.
  stored_key:=case p_template_key
    when 'payment_confirmed' then 'booking_confirmed'
    when 'booking_confirmed' then 'booking_confirmed'
    when 'preparation_packing' then 'packing_list'
    when 'packing_list' then 'packing_list'
    when 'insurance_final_check' then 'insurance_reminder'
    when 'insurance_reminder' then 'insurance_reminder'
    when 'arrival_details' then 'arrival_details'
    when 'arrival_coordination' then 'arrival_details'
    when 'final_checklist' then 'final_checklist'
    when 'post_trip_followup' then 'post_trip_followup'
    else null end;
  if stored_key is null or p_actual_sent_at is null
     or not isfinite(p_actual_sent_at) or p_actual_sent_at < '1900-01-01'::timestamptz
     or p_actual_sent_at > recorded_at or length(coalesce(p_operator_note,''))>1000
     or nullif(btrim(p_idempotency_key),'') is null or length(p_idempotency_key)>512 then
    raise exception 'invalid external email attestation';
  end if;
  select * into b from public.bookings
    where project_id=p_project_id and public_reference=p_reference for update;
  if not found then raise exception 'scoped booking not found'; end if;

  select * into previous from public.email_events where booking_id=b.id
    and raw_response->>'external_attestation_idempotency_key'=p_idempotency_key;
  if found then
    if previous.template_key<>stored_key or previous.sent_at<>p_actual_sent_at
       or (previous.raw_response->>'operator_note') is distinct from operator_note then
      raise exception 'external email attestation retry payload conflict';
    end if;
    return jsonb_build_object('outcome','already_recorded','event_id',previous.id);
  end if;
  if b.status='cancelled' then return jsonb_build_object('outcome','booking_cancelled'); end if;
  if (b.lifecycle_email_token is not null and (b.lifecycle_email_claimed_at is null or b.lifecycle_email_claimed_at >= recorded_at-interval '5 minutes'))
     or (b.payment_confirmation_token is not null and (b.payment_confirmation_claimed_at is null or b.payment_confirmation_claimed_at>=recorded_at-interval '5 minutes'))
     or exists(select 1 from public.lifecycle_email_dispatches where booking_id=b.id and status in ('queued','reconciliation_required'))
     or exists(select 1 from public.payment_confirmation_dispatch where booking_id=b.id and status='dispatching')
     or exists(select 1 from public.email_events where booking_id=b.id and status='queued') then
    return jsonb_build_object('outcome','dispatch_busy');
  end if;
  select email into email_address from public.customers where id=b.customer_id;
  if nullif(btrim(email_address),'') is null then raise exception 'booking customer email missing'; end if;
  insert into public.email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,provider,sent_by,status,sent_at,raw_response)
  values(b.id,b.customer_id,stored_key,email_address,'Gmail send recorded by operator','','gmail','gmail-manual','sent',p_actual_sent_at,
    jsonb_build_object('channel','gmail_manual','provider_delivery',false,'external_attestation',true,
      'external_attestation_idempotency_key',p_idempotency_key,'operator_note',operator_note,'recorded_at',recorded_at)) returning id into eid;
  insert into public.booking_events(booking_id,event_type,direction,title,body,metadata,created_by,occurred_at)
  values(b.id,'email','outbound','Gmail send recorded',
    'Operator recorded a message already sent from Gmail. No email was sent by Ops; delivery is not verified.',
    jsonb_build_object('email_event_id',eid,'template_key',stored_key,'actual_sent_at',p_actual_sent_at,'recorded_at',recorded_at,'operator_note',operator_note),
    'gmail-manual',recorded_at);
  return jsonb_build_object('outcome','recorded','event_id',eid);
end $$;
revoke all on function public.record_external_email_attestation(uuid,text,text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.record_external_email_attestation(uuid,text,text,timestamptz,text,text) to service_role;

-- Cross-system fence: preserve the captured shared lifecycle claim in full.
CREATE OR REPLACE FUNCTION public.claim_lifecycle_email_dispatch(p_booking_id uuid, p_customer_id uuid, p_template_key text, p_to_email text, p_subject text, p_body_snapshot text, p_sent_by text, p_claim_token uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b public.bookings; d public.lifecycle_email_dispatches; eid uuid; day_utc date := (p_now at time zone 'UTC')::date;
begin
  perform public.checkout_service_role();
  if p_claim_token is null or p_template_key not in ('payment_confirmed','preparation_packing','insurance_final_check','arrival_coordination','final_checklist')
    or nullif(trim(p_to_email),'') is null or nullif(trim(p_subject),'') is null then
    raise exception 'invalid lifecycle dispatch claim';
  end if;
  select * into b from public.bookings where id=p_booking_id and customer_id=p_customer_id for update;
  if not found or b.status='cancelled' or b.status not in ('awaiting_payment','confirmed','prep_sent','ready_for_departure') then
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
