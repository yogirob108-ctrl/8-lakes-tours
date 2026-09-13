-- New intakes only: no backfill, no historical booking or money updates.
create table public.abandoned_checkout_recovery (
 booking_id uuid primary key references public.bookings(id) on delete cascade,
 tour_date text not null,
 eligible_at timestamptz not null default clock_timestamp()+interval '1 hour',
 expires_at timestamptz not null default clock_timestamp()+interval '48 hours'
);
alter table public.abandoned_checkout_recovery enable row level security;
revoke all on public.abandoned_checkout_recovery from public,anon,authenticated;
grant select on public.abandoned_checkout_recovery to service_role;
create function public.enroll_abandoned_checkout() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.submission_key is not null and exists(select 1 from public.tour_projects where id=new.project_id and slug='8-lakes-tours') then
  insert into public.abandoned_checkout_recovery(booking_id,tour_date) values(new.id,new.tour_date);
 end if;
 return new;
end $$;
create trigger enroll_abandoned_checkout after insert on public.bookings for each row execute function public.enroll_abandoned_checkout();
alter table public.public_booking_notifications drop constraint public_booking_notifications_template_key_check;
alter table public.public_booking_notifications add constraint public_booking_notifications_template_key_check check(template_key in ('booking_received','internal_booking_notification','abandoned_checkout'));
create or replace function public.claim_public_booking_email_v2(p_booking_id uuid,p_customer_id uuid,p_template_key text,p_payload jsonb)
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
  if p_template_key not in ('booking_received','internal_booking_notification','abandoned_checkout') or p_payload->>'to' is null or p_payload->>'subject' is null then raise exception 'invalid initial email'; end if;
  insert into public.email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status,public_submission_email_key)
  values(p_booking_id,p_customer_id,p_template_key,p_payload->>'to',p_payload->>'subject',p_payload->>'text','website-form','queued',p_booking_id::text||':'||p_template_key) returning id into eid;
  insert into public.public_booking_notifications(booking_id,template_key,email_event_id,payload,status)
  values(p_booking_id,p_template_key,eid,p_payload,'queued') returning * into a;
 end if;
 return jsonb_build_object('should_send',true,'email_event_id',a.email_event_id,'claim_token',a.claim_token,'payload',a.payload);
end $$;


create function public.abandoned_checkout_eligible(p_booking_id uuid,p_allowed_dates text[]) returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from public.bookings b
 join public.tour_projects p on p.id=b.project_id
 join public.abandoned_checkout_recovery q on q.booking_id=b.id
 where b.id=p_booking_id and p.slug='8-lakes-tours' and p.active
 and b.submission_key is not null and b.status='awaiting_payment'
 and b.online_paid_usd=0 and b.online_due_usd>0 and b.guest_count between 1 and 8
 and b.tour_date=q.tour_date and b.tour_date=any(p_allowed_dates)
 and q.eligible_at<=clock_timestamp() and q.expires_at>clock_timestamp()
 and not exists(select 1 from public.payments pay where pay.booking_id=b.id and pay.status::text not in ('pending','failed')));
$$;
create function public.claim_abandoned_checkout(p_booking_id uuid,p_allowed_dates text[],p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid;
begin
 perform public.checkout_service_role();
 select customer_id into c from public.bookings where id=p_booking_id for update;
 if not public.abandoned_checkout_eligible(p_booking_id,p_allowed_dates) then return jsonb_build_object('should_send',false); end if;
 return public.claim_public_booking_email_v2(p_booking_id,c,'abandoned_checkout',p_payload);
end $$;
create function public.authorize_abandoned_checkout(p_booking_id uuid,p_claim_token uuid,p_allowed_dates text[]) returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform public.checkout_service_role();
 perform 1 from public.bookings where id=p_booking_id for update;
 return public.abandoned_checkout_eligible(p_booking_id,p_allowed_dates) and exists(
 select 1 from public.public_booking_notifications where booking_id=p_booking_id and template_key='abandoned_checkout'
 and status='queued' and claim_token=p_claim_token and lease_until>clock_timestamp());
end $$;
create function public.list_abandoned_checkouts(p_allowed_dates text[]) returns table(booking_id uuid,public_reference text,email text) language plpgsql security definer set search_path='' as $$
begin
 perform public.checkout_service_role();
 return query select b.id,b.public_reference,t.email from public.abandoned_checkout_recovery q
 join public.bookings b on b.id=q.booking_id
 join public.booking_travellers t on t.booking_id=b.id and t.position=1
 left join public.public_booking_notifications n on n.booking_id=b.id and n.template_key='abandoned_checkout'
 where public.abandoned_checkout_eligible(b.id,p_allowed_dates) and t.email is not null
 and (n.booking_id is null or n.status='failed' or (n.status='queued' and n.lease_until<=clock_timestamp()))
 order by q.eligible_at,b.id limit 20;
end $$;
revoke all on function public.list_abandoned_checkouts(text[]) from public,anon,authenticated;
grant execute on function public.list_abandoned_checkouts(text[]) to service_role;
revoke all on function public.enroll_abandoned_checkout(),public.abandoned_checkout_eligible(uuid,text[]),public.claim_abandoned_checkout(uuid,text[],jsonb),public.authorize_abandoned_checkout(uuid,uuid,text[]) from public,anon,authenticated;
grant execute on function public.claim_abandoned_checkout(uuid,text[],jsonb),public.authorize_abandoned_checkout(uuid,uuid,text[]) to service_role;
