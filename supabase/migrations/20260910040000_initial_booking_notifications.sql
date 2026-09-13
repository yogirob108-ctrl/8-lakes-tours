-- Retryable initial notifications with immutable provider request and fenced
-- leases. The provider idempotency window is finite: after 23h ambiguous sends
-- require provider-log reconciliation, never a blind new send/key.
create table public.public_booking_notifications (
 booking_id uuid not null references public.bookings(id) on delete cascade,
 template_key text not null check(template_key in ('booking_received','internal_booking_notification')),
 email_event_id uuid not null unique references public.email_events(id) on delete cascade,
 payload jsonb not null,
 status text not null check(status in ('queued','failed','sent','review')),
 claim_token uuid not null default gen_random_uuid(),
 first_attempt_at timestamptz not null default clock_timestamp(),
 lease_until timestamptz not null default clock_timestamp()+interval '15 minutes',
 primary key(booking_id,template_key)
);
alter table public.public_booking_notifications enable row level security;
revoke all on public.public_booking_notifications from public,anon,authenticated;

create function public.claim_public_booking_email_v2(p_booking_id uuid,p_customer_id uuid,p_template_key text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.public_booking_notifications; eid uuid;
begin
 perform public.checkout_service_role();
 perform 1 from public.bookings b join public.tour_projects p on p.id=b.project_id
 where b.id=p_booking_id and b.customer_id=p_customer_id and p.slug='8-lakes-tours' for update of b;
 if not found then raise exception 'booking not found'; end if;
 select * into a from public.public_booking_notifications where booking_id=p_booking_id and template_key=p_template_key for update;
 if found then
  if a.status in ('sent','review') or (a.status='queued' and a.lease_until>clock_timestamp()) then
   return jsonb_build_object('should_send',false);
  end if;
  if a.first_attempt_at<clock_timestamp()-interval '23 hours' then
   update public.public_booking_notifications set status='review' where email_event_id=a.email_event_id;
   update public.email_events set status='failed',raw_response=jsonb_build_object('error','Ambiguous initial email: reconcile provider logs before retry; idempotency window elapsed') where id=a.email_event_id;
   return jsonb_build_object('should_send',false);
  end if;
  update public.public_booking_notifications set status='queued',claim_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '15 minutes'
   where email_event_id=a.email_event_id returning * into a;
  update public.email_events set status='queued' where id=a.email_event_id;
 else
  -- Adopt no v1 send implicitly: it may already have reached the provider.
  if exists(select 1 from public.email_events where public_submission_email_key=p_booking_id::text||':'||p_template_key) then
   return jsonb_build_object('should_send',false);
  end if;
  if p_template_key not in ('booking_received','internal_booking_notification') or p_payload->>'to' is null or p_payload->>'subject' is null then raise exception 'invalid initial email'; end if;
  insert into public.email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status,public_submission_email_key)
  values(p_booking_id,p_customer_id,p_template_key,p_payload->>'to',p_payload->>'subject',p_payload->>'text','website-form','queued',p_booking_id::text||':'||p_template_key) returning id into eid;
  insert into public.public_booking_notifications(booking_id,template_key,email_event_id,payload,status)
  values(p_booking_id,p_template_key,eid,p_payload,'queued') returning * into a;
 end if;
 return jsonb_build_object('should_send',true,'email_event_id',a.email_event_id,'claim_token',a.claim_token,'payload',a.payload);
end $$;

create function public.finalize_public_booking_email_v2(p_email_event_id uuid,p_claim_token uuid,p_sent boolean,p_provider_message_id text,p_raw_response jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.checkout_service_role();
 update public.public_booking_notifications set status=case when p_sent then 'sent' else 'failed' end
 where email_event_id=p_email_event_id and claim_token=p_claim_token and status='queued';
 if not found then return; end if;
 update public.email_events set status=case when p_sent then 'sent'::public.email_event_status else 'failed'::public.email_event_status end,
 provider_message_id=p_provider_message_id,raw_response=p_raw_response,sent_at=clock_timestamp() where id=p_email_event_id;
end $$;
revoke all on function public.claim_public_booking_email_v2(uuid,uuid,text,jsonb),public.finalize_public_booking_email_v2(uuid,uuid,boolean,text,jsonb) from public,anon,authenticated;
grant execute on function public.claim_public_booking_email_v2(uuid,uuid,text,jsonb),public.finalize_public_booking_email_v2(uuid,uuid,boolean,text,jsonb) to service_role;
