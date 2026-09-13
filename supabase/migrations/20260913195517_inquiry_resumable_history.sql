begin;
alter table public.inquiry_sync_state add column continuation jsonb;
create function public.checkpoint_inquiry_sync(p_project_id uuid,p_gmail_account_email text,p_lease_token uuid,p_continuation jsonb)
returns setof public.inquiry_sync_state language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.inquiry_sync_state s where s.provider='gmail' and s.project_id=p_project_id and s.gmail_account_email=lower(btrim(p_gmail_account_email)) for update;
 perform public.require_inquiry_sync_lease('gmail',p_project_id,p_gmail_account_email,p_lease_token);
 return query update public.inquiry_sync_state s set continuation=p_continuation where s.provider='gmail' and s.project_id=p_project_id and s.gmail_account_email=lower(btrim(p_gmail_account_email)) and s.lease_token=p_lease_token and s.lease_expires_at>clock_timestamp() returning s.*;
end $$;
-- Cursor and continuation are finalized together under the active lease.
create or replace function public.finish_inquiry_sync(
  p_provider text, p_project_id uuid, p_gmail_account_email text, p_lease_token uuid, p_gmail_history_id text
)
returns table (provider text, project_id uuid, gmail_account_email text, gmail_history_id text)
language plpgsql security definer set search_path = '' as $$
begin
  if p_gmail_history_id is null or p_gmail_history_id !~ '^[0-9]+$' then
    raise exception 'A numeric Gmail history ID is required' using errcode = '22023';
  end if;
  return query update public.inquiry_sync_state sync
  set continuation = null, gmail_history_id = p_gmail_history_id, lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
  where sync.provider = lower(btrim(p_provider)) and sync.project_id = p_project_id
    and sync.gmail_account_email = lower(btrim(p_gmail_account_email))
    and sync.lease_token = p_lease_token and sync.lease_expires_at > clock_timestamp()
    and (sync.continuation is null or (sync.continuation->>'discoveryDone' = 'true' and sync.continuation->'pending' = '[]'::jsonb))
    and (sync.gmail_history_id is null or p_gmail_history_id::numeric >= sync.gmail_history_id::numeric)
  returning sync.provider, sync.project_id, sync.gmail_account_email, sync.gmail_history_id;
end;
$$;

-- Only already-selected inquiry threads. No new leads, drafts or outbound delivery operations.
create function public.import_inquiry_thread_history(p_project_id uuid,p_gmail_account_email text,p_lease_token uuid,p_thread_id text,p_messages jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare i public.inquiries%rowtype; m jsonb; n integer:=0; sender text; direction text;
begin
 perform 1 from public.inquiry_sync_state s where s.provider='gmail' and s.project_id=p_project_id and s.gmail_account_email=lower(btrim(p_gmail_account_email)) for update;
 perform public.require_inquiry_sync_lease('gmail',p_project_id,p_gmail_account_email,p_lease_token);
 if jsonb_typeof(p_messages)<>'array' or jsonb_array_length(p_messages)>500 then raise exception 'Bounded thread required'; end if;
 select * into i from public.inquiries where project_id=p_project_id and gmail_account_email=lower(btrim(p_gmail_account_email)) and gmail_thread_id=p_thread_id for update;
 if not found then raise exception 'Existing scoped inquiry required'; end if;
 for m in select value from jsonb_array_elements(p_messages) loop
  sender=lower(btrim(m->>'from'));
  direction=case when sender in (i.gmail_account_email,'info@8lakestours.com') then 'outbound' else 'inbound' end;
  -- Do not attach unrelated participants to the customer's history.
  if direction='inbound' and sender<>lower(i.contact_email) then continue; end if;
  if direction='outbound' and not (coalesce(m->'to','[]') ? lower(i.contact_email)) then continue; end if;
  if coalesce(m->>'id','')='' or m->>'occurredAt' is null then raise exception 'Message evidence required'; end if;
  insert into public.inquiry_messages(project_id,inquiry_id,direction,gmail_account_email,gmail_thread_id,gmail_message_id,provider,sync_lease_token,idempotency_key,from_email,to_emails,subject,body_text,raw_headers,occurred_at)
  values(p_project_id,i.id,direction,i.gmail_account_email,p_thread_id,m->>'id','gmail',case when direction='inbound' then p_lease_token else null end,'thread-history:'||i.gmail_account_email||':'||(m->>'id'),sender,array(select jsonb_array_elements_text(m->'to')),coalesce(m->>'subject',''),coalesce(m->>'body',''),coalesce(m->'headers','{}')||'{"history_only":true}',(m->>'occurredAt')::timestamptz)
  on conflict (project_id,gmail_account_email,gmail_message_id) do nothing;
  n=n+1;
 end loop;
 update public.inquiries set first_outbound_at=(select min(occurred_at) from public.inquiry_messages where inquiry_id=i.id and inquiry_messages.direction='outbound'),last_outbound_at=(select max(occurred_at) from public.inquiry_messages where inquiry_id=i.id and inquiry_messages.direction='outbound') where id=i.id;
 return n;
end $$;

-- Operator supplies the exact booking UUID. Unique identity PLUS settled booking evidence,
-- never email-only auto-conversion or arbitrary first-customer matching.
create function public.reconcile_inquiry_booking(p_project_id uuid,p_gmail_account_email text,p_lease_token uuid,p_inquiry_id uuid,p_booking_id uuid,p_expected_status public.inquiry_status)
returns table(inquiry_id uuid,booking_id uuid,status text,converted_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare i public.inquiries%rowtype; b public.bookings%rowtype; c uuid;
begin
 perform 1 from public.inquiry_sync_state s where s.provider='gmail' and s.project_id=p_project_id and s.gmail_account_email=lower(btrim(p_gmail_account_email)) for update;
 perform public.require_inquiry_sync_lease('gmail',p_project_id,p_gmail_account_email,p_lease_token);
 select * into i from public.inquiries where id=p_inquiry_id and project_id=p_project_id and gmail_account_email=lower(btrim(p_gmail_account_email)) and inquiries.status=p_expected_status for update;
 if not found or i.status not in ('contacted','replied','qualified') then return; end if;
 select * into b from public.bookings where id=p_booking_id and project_id=p_project_id for update;
 if not found or b.status not in ('confirmed','prep_sent','ready_for_departure','completed') or b.online_due_usd<=0 or b.online_paid_usd<b.online_due_usd then return; end if;
 -- Lock matching customers; ambiguous addresses are explicitly not reconciled.
 perform id from public.customers where lower(email)=lower(i.contact_email) for share;
 if (select count(*) from public.customers where lower(email)=lower(i.contact_email))<>1 then return; end if;
 select id into c from public.customers where lower(email)=lower(i.contact_email);
 if b.customer_id<>c or (i.customer_id is not null and i.customer_id<>c) then return; end if;
 update public.inquiries set customer_id=c,sync_provider='gmail',sync_lease_token=p_lease_token where id=i.id;
 return query select * from public.convert_inquiry(p_project_id,p_gmail_account_email,p_inquiry_id,p_booking_id,p_expected_status);
end $$;
revoke all on function public.checkpoint_inquiry_sync(uuid,text,uuid,jsonb), public.import_inquiry_thread_history(uuid,text,uuid,text,jsonb),public.reconcile_inquiry_booking(uuid,text,uuid,uuid,uuid,public.inquiry_status) from public,anon,authenticated;
grant execute on function public.checkpoint_inquiry_sync(uuid,text,uuid,jsonb),public.import_inquiry_thread_history(uuid,text,uuid,text,jsonb),public.reconcile_inquiry_booking(uuid,text,uuid,uuid,uuid,public.inquiry_status) to service_role;
commit;
