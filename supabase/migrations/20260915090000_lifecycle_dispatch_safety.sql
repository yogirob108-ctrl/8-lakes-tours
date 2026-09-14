-- Durable lifecycle outbox shared by automatic and manual senders.
-- One booking can own at most one lifecycle dispatch per UTC calendar day.

alter table public.bookings
  add column if not exists lifecycle_email_token uuid,
  add column if not exists lifecycle_email_claimed_at timestamptz,
  add column if not exists lifecycle_email_provider_attempted_at timestamptz;

alter table public.email_events
  add column if not exists is_canonical boolean not null default false,
  add column if not exists claim_token uuid,
  add column if not exists claimed_at timestamptz,
  add column if not exists provider_attempted_at timestamptz,
  add column if not exists provider_completed_at timestamptz;

create table public.lifecycle_email_dispatches (
  booking_id uuid not null references public.bookings(id) on delete cascade,
  utc_day date not null,
  template_key text not null check (template_key in ('payment_confirmed','preparation_packing','insurance_final_check','arrival_coordination','final_checklist')),
  email_event_id uuid not null unique references public.email_events(id) on delete restrict,
  status text not null check (status in ('queued','failed','sent','reconciliation_required')),
  claim_token uuid not null,
  claimed_at timestamptz not null default clock_timestamp(),
  provider_attempted_at timestamptz,
  provider_completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (booking_id, utc_day)
);
alter table public.lifecycle_email_dispatches enable row level security;
revoke all on public.lifecycle_email_dispatches from public, anon, authenticated;
create index lifecycle_email_dispatches_open_idx on public.lifecycle_email_dispatches (booking_id) where status in ('queued','reconciliation_required');

create or replace function public.claim_lifecycle_email_dispatch(
  p_booking_id uuid, p_customer_id uuid, p_template_key text, p_to_email text,
  p_subject text, p_body_snapshot text, p_sent_by text, p_claim_token uuid,
  p_now timestamptz default clock_timestamp()
) returns jsonb language plpgsql security definer set search_path='' as $$
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
end $$;

create or replace function public.mark_lifecycle_email_provider_attempted(p_booking_id uuid,p_event_id uuid,p_claim_token uuid,p_now timestamptz default clock_timestamp())
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform public.checkout_service_role();
 update public.lifecycle_email_dispatches set provider_attempted_at=p_now,updated_at=clock_timestamp()
 where booking_id=p_booking_id and email_event_id=p_event_id and status='queued' and claim_token=p_claim_token and provider_attempted_at is null;
 if not found then return false; end if;
 update public.email_events set provider_attempted_at=p_now where id=p_event_id and status='queued' and claim_token=p_claim_token::text;
 if not found then raise exception 'lifecycle provider-attempt email event conflict'; end if;
 update public.bookings set lifecycle_email_provider_attempted_at=p_now where id=p_booking_id and lifecycle_email_token=p_claim_token::text;
 if not found then raise exception 'lifecycle provider-attempt booking lease lost'; end if;
 return true;
end $$;

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

-- Cancellation and deletion must hold the same row lock and reject unresolved outbox state.
create or replace function public.delete_ops_booking_record(p_project_id uuid,p_booking_id uuid,p_reference text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.bookings; deleted_id uuid; written integer;
begin
 perform public.checkout_service_role();
 select * into b from public.bookings where id=p_booking_id and project_id=p_project_id and public_reference=p_reference for update;
 if not found then raise exception 'Booking deletion conflict: scoped booking not found'; end if;
 if (b.payment_confirmation_token is not null and (b.payment_confirmation_claimed_at is null or b.payment_confirmation_claimed_at>=clock_timestamp()-interval '5 minutes'))
 or (b.lifecycle_email_token is not null and (b.lifecycle_email_claimed_at is null or b.lifecycle_email_claimed_at>=clock_timestamp()-interval '5 minutes'))
 or exists(select 1 from public.payment_confirmation_dispatch where booking_id=b.id and status='dispatching')
 or exists(select 1 from public.lifecycle_email_dispatches where booking_id=b.id and status in ('queued','reconciliation_required')) then
  return jsonb_build_object('blocked','confirmation_or_lifecycle_dispatch_in_progress');
 end if;
 delete from public.email_events where booking_id=b.id;
 delete from public.bookings where id=b.id and project_id=p_project_id and public_reference=p_reference returning id into deleted_id;
 get diagnostics written=row_count;
 if written<>1 or deleted_id is distinct from b.id then raise exception 'Booking deletion conflict: expected one affected booking'; end if;
 return jsonb_build_object('deleted_booking_id',deleted_id);
end $$;

create or replace function public.lifecycle_email_dispatch_is_clear(p_booking_id uuid) returns boolean language sql security definer set search_path='' as $$
 select not exists(select 1 from public.lifecycle_email_dispatches where booking_id=p_booking_id and status in ('queued','reconciliation_required'));
$$;

revoke all on function public.delete_ops_booking_record(uuid,uuid,text),public.claim_lifecycle_email_dispatch(uuid,uuid,text,text,text,text,text,uuid,timestamptz),public.mark_lifecycle_email_provider_attempted(uuid,uuid,uuid,timestamptz),public.complete_lifecycle_email_dispatch(uuid,uuid,uuid,boolean,boolean,text,jsonb,timestamptz),public.lifecycle_email_dispatch_is_clear(uuid) from public,anon,authenticated;
grant execute on function public.delete_ops_booking_record(uuid,uuid,text),public.claim_lifecycle_email_dispatch(uuid,uuid,text,text,text,text,text,uuid,timestamptz),public.mark_lifecycle_email_provider_attempted(uuid,uuid,uuid,timestamptz),public.complete_lifecycle_email_dispatch(uuid,uuid,uuid,boolean,boolean,text,jsonb,timestamptz),public.lifecycle_email_dispatch_is_clear(uuid) to service_role;
