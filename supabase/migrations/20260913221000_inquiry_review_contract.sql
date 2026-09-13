begin;
-- This candidate is not promoted. Alias ownership is pinned to the known project
-- AND its configured contact address, never inferred from a message participant.
create function public.inquiry_verified_business_alias(p_project_id uuid,p_email text) returns boolean
language sql stable security definer set search_path='' as $$
 select lower(btrim(p_email))='info@8lakestours.com' and exists(
  select 1 from public.tour_projects p where p.id=p_project_id and p.slug='8-lakes-tours'
  and lower(btrim(p.contact_email))='info@8lakestours.com');
$$;
revoke all on function public.inquiry_verified_business_alias(uuid,text) from public,anon,authenticated;
grant execute on function public.inquiry_verified_business_alias(uuid,text) to service_role;
-- Additive correction of the deployed September 8 contract. Generation version is NOT an edit CAS.
alter table public.inquiries add column participant_review_required boolean not null default false;
alter table public.inquiry_drafts add column content_revision integer not null default 1 check(content_revision>0),
  add column source_message_id uuid references public.inquiry_messages(id),
  add column superseded_at timestamptz;
-- Existing evidence is retained verbatim, but cannot authorize an unbound reply.
update public.inquiries i set participant_review_required=true where exists(
 select 1 from public.inquiry_messages m where m.inquiry_id=i.id and m.direction='inbound'
 and (lower(btrim(m.from_email)) is distinct from lower(btrim(i.contact_email))
 or exists(select 1 from unnest(m.to_emails || m.cc_emails) e where lower(btrim(e)) not in (lower(btrim(i.contact_email)),i.gmail_account_email) and not public.inquiry_verified_business_alias(i.project_id,e))));
create or replace function public.reconcile_inbound_inquiry_message(
  p_project_id uuid,
  p_gmail_account_email text,
  p_lease_token uuid,
  p_gmail_thread_id text,
  p_gmail_message_id text,
  p_contact_name text,
  p_contact_email text,
  p_to_emails text[],
  p_cc_emails text[],
  p_subject text,
  p_body_text text,
  p_raw_headers jsonb,
  p_occurred_at timestamptz,
  p_decision text,
  p_request_type text,
  p_inquiry_idempotency_key text,
  p_message_idempotency_key text
)
returns table (inquiry_id uuid, duplicate boolean, message_imported boolean, inquiry_created boolean, terminal_label text)
language plpgsql security definer set search_path = '' as $$
declare
  v_mailbox text := lower(btrim(coalesce(p_gmail_account_email, '')));
  v_inquiry public.inquiries%rowtype;
  v_message public.inquiry_messages%rowtype;
  v_lease uuid;
  v_created boolean := false;
  v_imported boolean := false;
  v_terminal text;
begin
  if p_project_id is null or v_mailbox = '' or length(btrim(coalesce(p_gmail_thread_id, ''))) = 0
    or length(btrim(coalesce(p_gmail_message_id, ''))) = 0 or p_decision not in ('import', 'review')
    or p_occurred_at is null then
    raise exception 'Valid scoped inbound message input is required' using errcode = '22023';
  end if;
  select sync.lease_token into v_lease from public.inquiry_sync_state sync
  where sync.provider = 'gmail' and sync.project_id = p_project_id and sync.gmail_account_email = v_mailbox
    and sync.lease_token = p_lease_token and sync.lease_expires_at > clock_timestamp()
  for update;
  if v_lease is null then
    raise exception 'An active scoped Gmail sync lease is required' using errcode = '55000';
  end if;

  select i.* into v_inquiry from public.inquiries i
  where i.project_id = p_project_id and i.gmail_account_email = v_mailbox and i.gmail_thread_id = btrim(p_gmail_thread_id)
  for update;
  if not found then
    insert into public.inquiries(project_id, customer_id, status, gmail_account_email, gmail_thread_id, idempotency_key,
      contact_name, contact_email, source, sync_provider, sync_lease_token, request_type, first_inbound_at, last_inbound_at)
    values (p_project_id, (select c.id from public.customers c where lower(c.email) = lower(btrim(p_contact_email)) order by c.created_at limit 1),
      case when p_decision = 'review' then 'needs_review'::public.inquiry_status else 'new'::public.inquiry_status end,
      v_mailbox, btrim(p_gmail_thread_id), p_inquiry_idempotency_key, nullif(btrim(p_contact_name), ''), lower(btrim(p_contact_email)),
      'gmail', 'gmail', v_lease, nullif(btrim(p_request_type), ''), p_occurred_at, p_occurred_at)
    returning * into v_inquiry;
    v_created := true;
  end if;

  -- Thread identity alone is not participant authorization. Never attach foreign content.
  if lower(btrim(p_contact_email)) is distinct from lower(btrim(v_inquiry.contact_email))
    or exists(select 1 from unnest(coalesce(p_to_emails,'{}') || coalesce(p_cc_emails,'{}')) e
      where lower(btrim(e)) not in (v_mailbox,lower(btrim(v_inquiry.contact_email))) and not public.inquiry_verified_business_alias(p_project_id,e)) then
    update public.inquiries set participant_review_required=true where id=v_inquiry.id;
    return query select v_inquiry.id,false,false,v_created,'review'::text;
    return;
  end if;

  select m.* into v_message from public.inquiry_messages m
  where m.project_id = p_project_id and m.gmail_account_email = v_mailbox and m.gmail_message_id = btrim(p_gmail_message_id);
  if not found then
    v_terminal := case when p_decision = 'review' then 'review' else 'imported' end;
    insert into public.inquiry_messages(project_id, inquiry_id, direction, gmail_account_email, gmail_thread_id, gmail_message_id,
      provider, sync_lease_token, idempotency_key, from_email, to_emails, cc_emails, subject, body_text, raw_headers, occurred_at)
    values (p_project_id, v_inquiry.id, 'inbound', v_mailbox, v_inquiry.gmail_thread_id, btrim(p_gmail_message_id), 'gmail', v_lease,
      p_message_idempotency_key, lower(btrim(p_contact_email)), coalesce(p_to_emails, '{}'::text[]), coalesce(p_cc_emails, '{}'::text[]),
      coalesce(p_subject, ''), coalesce(p_body_text, ''), coalesce(p_raw_headers, '{}'::jsonb) || jsonb_build_object('_terminal_label', v_terminal), p_occurred_at)
    returning * into v_message;
    v_imported := true;
  elsif v_message.inquiry_id <> v_inquiry.id or v_message.gmail_thread_id <> v_inquiry.gmail_thread_id then
    return;
  else
    v_terminal := coalesce(v_message.raw_headers ->> '_terminal_label', case when v_inquiry.status = 'needs_review' then 'review' else 'imported' end);
  end if;

  update public.inquiries i set
    sync_provider = 'gmail', sync_lease_token = v_lease,
    first_inbound_at = (select min(m.occurred_at) from public.inquiry_messages m where m.inquiry_id = i.id and m.direction = 'inbound'),
    last_inbound_at = (select max(m.occurred_at) from public.inquiry_messages m where m.inquiry_id = i.id and m.direction = 'inbound'),
    status = case when i.status in ('new', 'needs_review', 'drafted', 'contacted') and i.last_outbound_at is not null
      and (select max(m.occurred_at) from public.inquiry_messages m where m.inquiry_id = i.id and m.direction = 'inbound') > i.last_outbound_at
      then 'replied'::public.inquiry_status else i.status end,
    updated_at = clock_timestamp()
  where i.id = v_inquiry.id and i.project_id = p_project_id and i.gmail_account_email = v_mailbox
  returning * into v_inquiry;
  return query select v_inquiry.id, not v_imported, v_imported, v_created, v_terminal;
end;
$$;

create or replace function public.create_inquiry_draft(
  p_project_id uuid, p_gmail_account_email text, p_inquiry_id uuid, p_expected_status public.inquiry_status,
  p_subject text, p_body_text text, p_to_email text, p_created_by text, p_in_reply_to text,
  p_reference_message_ids text[], p_idempotency_key text
)
returns table (id uuid, inquiry_id uuid, version integer, state text, subject text, body_text text, to_emails text[])
language plpgsql security definer set search_path = '' as $$
declare v_inquiry public.inquiries%rowtype; v_draft public.inquiry_drafts%rowtype; v_source public.inquiry_messages%rowtype; v_mailbox text := lower(btrim(p_gmail_account_email));
begin
  if length(btrim(coalesce(p_subject,'')))=0 or length(btrim(coalesce(p_body_text,'')))=0
    or length(btrim(coalesce(p_to_email,'')))=0 or length(btrim(coalesce(p_created_by,'')))=0
    or length(btrim(coalesce(p_in_reply_to,'')))=0 or cardinality(coalesce(p_reference_message_ids,'{}'::text[]))=0 then
    raise exception 'Complete draft content and reply evidence are required' using errcode='22023';
  end if;
  select i.* into v_inquiry from public.inquiries i where i.id=p_inquiry_id and i.project_id=p_project_id
    and i.gmail_account_email=v_mailbox and i.status=p_expected_status for update;
  if not found or v_inquiry.status not in ('new','needs_review','drafted','contacted','replied','qualified') then return; end if;
  select d.* into v_draft from public.inquiry_drafts d where d.project_id=p_project_id and d.gmail_account_email=v_mailbox
    and d.inquiry_id=p_inquiry_id and d.idempotency_key=p_idempotency_key;
  if found then
    if v_draft.subject=p_subject and v_draft.body_text=p_body_text and v_draft.to_emails=array[lower(btrim(p_to_email))]
      and v_draft.in_reply_to=p_in_reply_to and v_draft.reference_message_ids=coalesce(p_reference_message_ids,'{}'::text[]) then
      return query select v_draft.id,v_draft.inquiry_id,v_draft.version,v_draft.state::text,v_draft.subject,v_draft.body_text,v_draft.to_emails;
    end if;
    return;
  end if;
  select m.* into v_source from public.inquiry_messages m
    where m.inquiry_id=p_inquiry_id and m.project_id=p_project_id and m.gmail_account_email=v_mailbox
      and m.direction='inbound' and lower(btrim(m.from_email))=lower(btrim(v_inquiry.contact_email))
    order by m.occurred_at desc,m.gmail_message_id desc limit 1;
  if v_inquiry.participant_review_required or v_source.id is null
    or v_source.raw_headers->>'message_id' is distinct from btrim(p_in_reply_to)
    or exists(select 1 from unnest(v_source.to_emails || v_source.cc_emails) e where lower(btrim(e)) not in (v_mailbox,lower(btrim(v_inquiry.contact_email))) and not public.inquiry_verified_business_alias(p_project_id,e))
    or lower(btrim(p_to_email)) is distinct from lower(btrim(v_source.from_email))
    or not (btrim(p_in_reply_to)=any(coalesce(p_reference_message_ids,'{}')))
    or (select count(*) from public.inquiry_messages m where m.inquiry_id=p_inquiry_id and m.direction='inbound'
      and m.raw_headers->>'message_id'=btrim(p_in_reply_to))<>1 then return; end if;
  -- Source identity, not caller retry keys, owns the generation sequence.
  return query select d.id,d.inquiry_id,d.version,d.state::text,d.subject,d.body_text,d.to_emails
    from public.inquiry_drafts d where d.inquiry_id=p_inquiry_id and d.source_message_id=v_source.id;
  if found then return; end if;
  -- Never hide an unresolved provider attempt behind a new draft.
  if exists(select 1 from public.inquiry_drafts d where d.inquiry_id=p_inquiry_id
    and d.state in ('sending','delivery_unknown','send_failed')) then return; end if;
  update public.inquiry_drafts d set state='cancelled',superseded_at=clock_timestamp()
    where d.inquiry_id=p_inquiry_id and d.state in ('draft','pending_review','approved','rejected') and d.superseded_at is null;
  insert into public.inquiry_drafts(project_id,inquiry_id,version,state,subject,body_text,to_emails,created_by,gmail_account_email,
    gmail_thread_id,in_reply_to,reference_message_ids,idempotency_key,source_message_id)
  values(p_project_id,p_inquiry_id,(select coalesce(max(d.version),0)+1 from public.inquiry_drafts d where d.inquiry_id=p_inquiry_id),
    'draft',btrim(p_subject),p_body_text,array[lower(btrim(p_to_email))],btrim(p_created_by),v_mailbox,v_inquiry.gmail_thread_id,
    btrim(p_in_reply_to),p_reference_message_ids,p_idempotency_key,v_source.id) returning * into v_draft;
  update public.inquiries i set status='drafted',updated_at=clock_timestamp() where i.id=v_inquiry.id and i.status in ('new','needs_review','drafted');
  return query select v_draft.id,v_draft.inquiry_id,v_draft.version,v_draft.state::text,v_draft.subject,v_draft.body_text,v_draft.to_emails;
end;
$$;
create function public.inquiry_draft_source_current(p_draft_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.inquiry_drafts d join public.inquiries i on i.id=d.inquiry_id
 join public.inquiry_messages m on m.id=d.source_message_id
 where d.id=p_draft_id and not i.participant_review_required and d.superseded_at is null
 and m.inquiry_id=i.id and m.project_id=d.project_id and m.gmail_account_email=d.gmail_account_email
 and m.direction='inbound' and lower(btrim(m.from_email))=lower(btrim(i.contact_email))
 and d.to_emails=array[lower(btrim(m.from_email))] and d.in_reply_to=m.raw_headers->>'message_id'
 and m.id=(select x.id from public.inquiry_messages x where x.inquiry_id=i.id and x.direction='inbound'
   and lower(btrim(x.from_email))=lower(btrim(i.contact_email)) order by x.occurred_at desc,x.gmail_message_id desc limit 1));
$$;
revoke all on function public.inquiry_draft_source_current(uuid) from public,anon,authenticated;
grant execute on function public.inquiry_draft_source_current(uuid) to service_role;
-- Defense in depth: direct service-role inserts/updates cannot bypass source binding or revision rules.
create function public.guard_inquiry_draft_content_revision() returns trigger language plpgsql set search_path='' as $$
declare m public.inquiry_messages%rowtype; i public.inquiries%rowtype;
begin
 if tg_op='UPDATE' then
  if new.source_message_id is distinct from old.source_message_id or new.version<>old.version then
   raise exception 'Draft source and generation are immutable'; end if;
  if old.state<>'draft' and (new.subject,new.body_text,new.body_html,new.to_emails,new.cc_emails,new.in_reply_to,new.reference_message_ids,new.content_revision)
    is distinct from (old.subject,old.body_text,old.body_html,old.to_emails,old.cc_emails,old.in_reply_to,old.reference_message_ids,old.content_revision) then
   raise exception 'Reviewed content is immutable'; end if;
  if (new.subject,new.body_text,new.body_html,new.to_emails,new.cc_emails,new.in_reply_to,new.reference_message_ids)
    is distinct from (old.subject,old.body_text,old.body_html,old.to_emails,old.cc_emails,old.in_reply_to,old.reference_message_ids)
    and new.content_revision<>old.content_revision+1 then raise exception 'Content revision must advance'; end if;
 end if;
 if tg_op='INSERT' or (new.state in ('pending_review','approved','sending') and new.state is distinct from old.state) then
  select * into i from public.inquiries where id=new.inquiry_id for update;
  select * into m from public.inquiry_messages where id=new.source_message_id;
  if i.participant_review_required or m.id is null or m.inquiry_id<>i.id or m.project_id<>new.project_id
   or m.gmail_account_email<>new.gmail_account_email or m.direction<>'inbound'
   or lower(btrim(m.from_email))<>lower(btrim(i.contact_email)) or new.to_emails<>array[lower(btrim(m.from_email))]
   or exists(select 1 from unnest(m.to_emails || m.cc_emails) e where lower(btrim(e)) not in (i.gmail_account_email,lower(btrim(i.contact_email))) and not public.inquiry_verified_business_alias(i.project_id,e))
   or cardinality(new.cc_emails)<>0 or new.in_reply_to is distinct from m.raw_headers->>'message_id'
   or m.id<>(select x.id from public.inquiry_messages x where x.inquiry_id=i.id and x.direction='inbound'
     and lower(btrim(x.from_email))=lower(btrim(i.contact_email)) order by x.occurred_at desc,x.gmail_message_id desc limit 1)
   then raise exception 'Draft requires current canonical source and recipient'; end if;
 end if;
 return new;
end $$;
create trigger inquiry_drafts_guard_content_revision before insert or update on public.inquiry_drafts
for each row execute function public.guard_inquiry_draft_content_revision();
create or replace function public.save_inquiry_draft(
  p_project_id uuid, p_gmail_account_email text, p_inquiry_id uuid, p_draft_id uuid, p_expected_version integer,
  p_subject text, p_body_text text, p_to_email text
)
returns table (id uuid, inquiry_id uuid, version integer, state text)
language sql security definer set search_path = '' as $$ select null::uuid,null::uuid,null::integer,null::text where false; $$;
create or replace function public.save_inquiry_draft(
  p_project_id uuid, p_gmail_account_email text, p_inquiry_id uuid, p_draft_id uuid, p_expected_version integer,
  p_subject text, p_body_text text, p_to_email text , p_expected_revision integer
)
returns table (id uuid, inquiry_id uuid, version integer, state text)
language sql security definer set search_path = '' as $$
  update public.inquiry_drafts d set content_revision=d.content_revision+1, subject=btrim(p_subject), body_text=p_body_text, to_emails=array[lower(btrim(p_to_email))], updated_at=clock_timestamp()
  where d.id=p_draft_id and d.inquiry_id=p_inquiry_id and d.project_id=p_project_id
    and d.gmail_account_email=lower(btrim(p_gmail_account_email)) and d.version=p_expected_version and d.content_revision=p_expected_revision and d.superseded_at is null and public.inquiry_draft_source_current(d.id) and d.state='draft'
    and length(btrim(coalesce(p_subject,'')))>0 and length(btrim(coalesce(p_body_text,'')))>0 and length(btrim(coalesce(p_to_email,'')))>0
    and array[lower(btrim(p_to_email))]=d.to_emails
  returning d.id,d.inquiry_id,d.version,d.state::text;
$$;

revoke all on function public.save_inquiry_draft(uuid,text,uuid,uuid,integer,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.save_inquiry_draft(uuid,text,uuid,uuid,integer,text,text,text,integer) to service_role;
create or replace function public.submit_inquiry_draft_for_review(
  p_project_id uuid, p_gmail_account_email text, p_inquiry_id uuid, p_draft_id uuid, p_expected_version integer
)
returns table (id uuid, inquiry_id uuid, version integer, state text)
language sql security definer set search_path = '' as $$ select null::uuid,null::uuid,null::integer,null::text where false; $$;
create or replace function public.submit_inquiry_draft_for_review(
  p_project_id uuid, p_gmail_account_email text, p_inquiry_id uuid, p_draft_id uuid, p_expected_version integer , p_expected_revision integer
)
returns table (id uuid, inquiry_id uuid, version integer, state text)
language sql security definer set search_path = '' as $$
  update public.inquiry_drafts d set state='pending_review',submitted_for_review_at=clock_timestamp(),updated_at=clock_timestamp()
  where d.id=p_draft_id and d.inquiry_id=p_inquiry_id and d.project_id=p_project_id
    and d.gmail_account_email=lower(btrim(p_gmail_account_email)) and d.version=p_expected_version and d.content_revision=p_expected_revision and d.superseded_at is null and public.inquiry_draft_source_current(d.id) and d.state='draft'
  returning d.id,d.inquiry_id,d.version,d.state::text;
$$;

revoke all on function public.submit_inquiry_draft_for_review(uuid,text,uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.submit_inquiry_draft_for_review(uuid,text,uuid,uuid,integer,integer) to service_role;
create or replace function public.approve_inquiry_draft(
  p_project_id uuid, p_gmail_account_email text, p_inquiry_id uuid, p_draft_id uuid, p_expected_version integer, p_reviewer text
)
returns table (id uuid, inquiry_id uuid, version integer, state text)
language sql security definer set search_path = '' as $$ select null::uuid,null::uuid,null::integer,null::text where false; $$;
create or replace function public.approve_inquiry_draft(
  p_project_id uuid, p_gmail_account_email text, p_inquiry_id uuid, p_draft_id uuid, p_expected_version integer, p_reviewer text , p_expected_revision integer
)
returns table (id uuid, inquiry_id uuid, version integer, state text)
language sql security definer set search_path = '' as $$
  update public.inquiry_drafts d set state='approved',reviewer=btrim(p_reviewer),reviewed_at=clock_timestamp(),approved_at=clock_timestamp(),updated_at=clock_timestamp()
  where d.id=p_draft_id and d.inquiry_id=p_inquiry_id and d.project_id=p_project_id
    and d.gmail_account_email=lower(btrim(p_gmail_account_email)) and d.version=p_expected_version and d.content_revision=p_expected_revision and d.superseded_at is null and public.inquiry_draft_source_current(d.id) and d.state='pending_review'
    and length(btrim(coalesce(p_reviewer,'')))>0
  returning d.id,d.inquiry_id,d.version,d.state::text;
$$;

revoke all on function public.approve_inquiry_draft(uuid,text,uuid,uuid,integer,text,integer) from public,anon,authenticated;
grant execute on function public.approve_inquiry_draft(uuid,text,uuid,uuid,integer,text,integer) to service_role;
create or replace function public.import_inquiry_thread_history(p_project_id uuid,p_gmail_account_email text,p_lease_token uuid,p_thread_id text,p_messages jsonb)
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
  direction=case when (sender=i.gmail_account_email or public.inquiry_verified_business_alias(i.project_id,sender)) then 'outbound' else 'inbound' end;
  -- Do not attach unrelated participants to the customer's history.
  if (direction='inbound' and sender is distinct from lower(i.contact_email))
    or exists(select 1 from jsonb_array_elements_text(coalesce(m->'to','[]') || coalesce(m->'cc','[]')) e
      where lower(btrim(e)) not in (lower(i.contact_email),i.gmail_account_email) and not public.inquiry_verified_business_alias(i.project_id,e)) then
    update public.inquiries set participant_review_required=true where id=i.id; continue; end if;
  if direction='outbound' and not (coalesce(m->'to','[]') ? lower(i.contact_email)) then continue; end if;
  if coalesce(m->>'id','')='' or m->>'occurredAt' is null then raise exception 'Message evidence required'; end if;
  insert into public.inquiry_messages(project_id,inquiry_id,direction,gmail_account_email,gmail_thread_id,gmail_message_id,provider,sync_lease_token,idempotency_key,from_email,to_emails,cc_emails,subject,body_text,raw_headers,occurred_at)
  values(p_project_id,i.id,direction,i.gmail_account_email,p_thread_id,m->>'id','gmail',case when direction='inbound' then p_lease_token else null end,'thread-history:'||i.gmail_account_email||':'||(m->>'id'),sender,array(select jsonb_array_elements_text(m->'to')),array(select jsonb_array_elements_text(coalesce(m->'cc','[]'))),coalesce(m->>'subject',''),coalesce(m->>'body',''),coalesce(m->'headers','{}')||'{"history_only":true}',(m->>'occurredAt')::timestamptz)
  on conflict (project_id,gmail_account_email,gmail_message_id) do nothing;
  n=n+1;
 end loop;
 update public.inquiries set first_inbound_at=(select min(occurred_at) from public.inquiry_messages where inquiry_id=i.id and inquiry_messages.direction='inbound'),last_inbound_at=(select max(occurred_at) from public.inquiry_messages where inquiry_id=i.id and inquiry_messages.direction='inbound'),first_outbound_at=(select min(occurred_at) from public.inquiry_messages where inquiry_id=i.id and inquiry_messages.direction='outbound'),last_outbound_at=(select max(occurred_at) from public.inquiry_messages where inquiry_id=i.id and inquiry_messages.direction='outbound') where id=i.id;
 return n;
end $$;


-- Durable no-draft outcomes are necessary to complete late/poison candidate retries.
create table public.inquiry_draft_dispositions (
 message_id uuid primary key references public.inquiry_messages(id),
 inquiry_id uuid not null references public.inquiries(id),
 project_id uuid not null references public.tour_projects(id),
 gmail_account_email text not null,
 reason text not null check(reason in ('inactive_thread','missing_message_id','participant_changed','superseded_source','generation_blocked')),
 created_at timestamptz not null default now()
);
alter table public.inquiry_draft_dispositions enable row level security;
revoke all on public.inquiry_draft_dispositions from public,anon,authenticated;
grant select,insert on public.inquiry_draft_dispositions to service_role;
create policy inquiry_dispositions_service on public.inquiry_draft_dispositions for all to service_role using(true) with check(true);
create function public.guard_inquiry_disposition_scope() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.inquiry_messages m where m.id=new.message_id and m.inquiry_id=new.inquiry_id
 and m.project_id=new.project_id and m.gmail_account_email=new.gmail_account_email) then raise exception 'Disposition source scope mismatch'; end if;
 return new;
end $$;
create trigger inquiry_dispositions_guard before insert on public.inquiry_draft_dispositions for each row execute function public.guard_inquiry_disposition_scope();

create unique index inquiry_draft_one_generation_per_source on public.inquiry_drafts(source_message_id) where source_message_id is not null;
create or replace function public.create_grounded_inquiry_draft(
 p_project_id uuid,p_gmail_account_email text,p_inquiry_id uuid,p_expected_status public.inquiry_status,
 p_subject text,p_body_text text,p_to_email text,p_created_by text,p_in_reply_to text,p_reference_message_ids text[],p_idempotency_key text,
 p_sources jsonb,p_unanswered_topics text[]
)
returns table(id uuid,inquiry_id uuid,version integer,state text,subject text,body_text text,to_emails text[])
language plpgsql security definer set search_path='' as $$
declare d record;
begin
 perform 1 from public.inquiries i where i.id=p_inquiry_id and i.project_id=p_project_id and i.gmail_account_email=lower(btrim(p_gmail_account_email)) for update;
 if not found then return; end if;
 -- Idempotency is per inbound message, independent of answer-library edits.
 return query select x.id,x.inquiry_id,x.version,x.state::text,x.subject,x.body_text,x.to_emails from public.inquiry_drafts x
 where x.project_id=p_project_id and x.inquiry_id=p_inquiry_id and x.gmail_account_email=lower(btrim(p_gmail_account_email)) and (x.idempotency_key=p_idempotency_key or
   (x.source_message_id is not null and x.in_reply_to=btrim(p_in_reply_to) and x.to_emails=array[lower(btrim(p_to_email))]));
 if found then return; end if;
 for d in select * from public.create_inquiry_draft(p_project_id,p_gmail_account_email,p_inquiry_id,p_expected_status,p_subject,p_body_text,p_to_email,p_created_by,p_in_reply_to,p_reference_message_ids,p_idempotency_key) loop
  insert into public.inquiry_draft_sources(draft_id,project_id,gmail_account_email,sources,unanswered_topics)
  values(d.id,p_project_id,lower(btrim(p_gmail_account_email)),p_sources,p_unanswered_topics) on conflict(draft_id) do nothing;
  return query select d.id,d.inquiry_id,d.version,d.state,d.subject,d.body_text,d.to_emails;
 end loop;
end;
$$;

commit;
