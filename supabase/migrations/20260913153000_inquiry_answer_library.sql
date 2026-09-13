begin;
create table public.inquiry_answers (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null references public.tour_projects(id),
 topic text not null check (topic in ('availability','dates','price','riding_suitability','transport','packing','insurance','private_groups')),
 question text not null check (length(question) between 1 and 500),
 answer text not null check (length(answer) between 1 and 8000),
 source_url text not null check (source_url ~ '^https://' and length(source_url) <= 2000),
 source_note text not null check (length(source_note) between 1 and 2000),
 revision integer not null default 1 check (revision > 0),
 status text not null default 'draft' check (status in ('draft','approved')),
 approved_by text,
 approved_at timestamptz,
 updated_at timestamptz not null default now(),
 unique(project_id, topic),
 check ((status='draft' and approved_by is null and approved_at is null) or (status='approved' and length(btrim(approved_by)) > 0 and approved_at is not null))
);
alter table public.inquiry_answers enable row level security;
revoke all on public.inquiry_answers from public, anon, authenticated;
grant select on public.inquiry_answers to service_role;

create table public.inquiry_draft_sources (
 draft_id uuid primary key references public.inquiry_drafts(id) on delete cascade,
 project_id uuid not null references public.tour_projects(id),
 gmail_account_email text not null,
 sources jsonb not null,
 unanswered_topics text[] not null,
 created_at timestamptz not null default now()
);
alter table public.inquiry_draft_sources enable row level security;
revoke all on public.inquiry_draft_sources from public, anon, authenticated;
grant select, insert on public.inquiry_draft_sources to service_role;

create function public.save_inquiry_answer(p_project_id uuid,p_topic text,p_question text,p_answer text,p_source_url text,p_source_note text,p_expected_revision integer)
returns setof public.inquiry_answers language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.tour_projects where id=p_project_id and slug='8-lakes-tours') then return; end if;
 if p_expected_revision=0 then
  return query insert into public.inquiry_answers(project_id,topic,question,answer,source_url,source_note)
  values(p_project_id,p_topic,btrim(p_question),btrim(p_answer),btrim(p_source_url),btrim(p_source_note)) on conflict(project_id,topic) do nothing returning *;
 else
  return query update public.inquiry_answers a set question=btrim(p_question),answer=btrim(p_answer),source_url=btrim(p_source_url),source_note=btrim(p_source_note),revision=a.revision+1,status='draft',approved_by=null,approved_at=null,updated_at=clock_timestamp()
  where a.project_id=p_project_id and a.topic=p_topic and a.revision=p_expected_revision returning a.*;
 end if;
end;
$$;
create function public.approve_inquiry_answer(p_project_id uuid,p_topic text,p_expected_revision integer,p_reviewer text)
returns setof public.inquiry_answers language sql security definer set search_path='' as $$
 update public.inquiry_answers a set status='approved',approved_by=btrim(p_reviewer),approved_at=clock_timestamp(),updated_at=clock_timestamp()
 where a.project_id=p_project_id and a.topic=p_topic and a.revision=p_expected_revision and a.status='draft'
 and length(btrim(p_reviewer))>0 and exists(select 1 from public.tour_projects p where p.id=p_project_id and p.slug='8-lakes-tours') returning a.*;
$$;
revoke all on function public.save_inquiry_answer(uuid,text,text,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.approve_inquiry_answer(uuid,text,integer,text) from public, anon, authenticated;
grant execute on function public.save_inquiry_answer(uuid,text,text,text,text,text,integer) to service_role;
grant execute on function public.approve_inquiry_answer(uuid,text,integer,text) to service_role;
-- Atomic generation wrapper: a retry cannot leave a draft without provenance.
create function public.create_grounded_inquiry_draft(
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
 where x.project_id=p_project_id and x.inquiry_id=p_inquiry_id and x.gmail_account_email=lower(btrim(p_gmail_account_email)) and x.idempotency_key=p_idempotency_key;
 if found then return; end if;
 for d in select * from public.create_inquiry_draft(p_project_id,p_gmail_account_email,p_inquiry_id,p_expected_status,p_subject,p_body_text,p_to_email,p_created_by,p_in_reply_to,p_reference_message_ids,p_idempotency_key) loop
  insert into public.inquiry_draft_sources(draft_id,project_id,gmail_account_email,sources,unanswered_topics)
  values(d.id,p_project_id,lower(btrim(p_gmail_account_email)),p_sources,p_unanswered_topics);
  return query select d.id,d.inquiry_id,d.version,d.state,d.subject,d.body_text,d.to_emails;
 end loop;
end;
$$;
revoke all on function public.create_grounded_inquiry_draft(uuid,text,uuid,public.inquiry_status,text,text,text,text,text,text[],text,jsonb,text[]) from public, anon, authenticated;
grant execute on function public.create_grounded_inquiry_draft(uuid,text,uuid,public.inquiry_status,text,text,text,text,text,text[],text,jsonb,text[]) to service_role;
revoke insert on public.inquiry_draft_sources from service_role;
commit;
