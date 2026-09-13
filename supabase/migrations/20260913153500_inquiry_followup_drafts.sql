begin;
-- Draft state is independent of pipeline progression. Follow-up drafts do not regress status.
create or replace function public.create_inquiry_draft(
  p_project_id uuid, p_gmail_account_email text, p_inquiry_id uuid, p_expected_status public.inquiry_status,
  p_subject text, p_body_text text, p_to_email text, p_created_by text, p_in_reply_to text,
  p_reference_message_ids text[], p_idempotency_key text
)
returns table (id uuid, inquiry_id uuid, version integer, state text, subject text, body_text text, to_emails text[])
language plpgsql security definer set search_path = '' as $$
declare v_inquiry public.inquiries%rowtype; v_draft public.inquiry_drafts%rowtype; v_mailbox text := lower(btrim(p_gmail_account_email));
begin
  select d.* into v_draft from public.inquiry_drafts d where d.project_id=p_project_id and d.gmail_account_email=v_mailbox
    and d.inquiry_id=p_inquiry_id and d.idempotency_key=p_idempotency_key;
  if found then
    if v_draft.subject=p_subject and v_draft.body_text=p_body_text and v_draft.to_emails=array[lower(btrim(p_to_email))]
      and v_draft.in_reply_to=p_in_reply_to and v_draft.reference_message_ids=coalesce(p_reference_message_ids,'{}'::text[]) then
      return query select v_draft.id,v_draft.inquiry_id,v_draft.version,v_draft.state::text,v_draft.subject,v_draft.body_text,v_draft.to_emails;
    end if;
    return;
  end if;
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
  insert into public.inquiry_drafts(project_id,inquiry_id,version,state,subject,body_text,to_emails,created_by,gmail_account_email,
    gmail_thread_id,in_reply_to,reference_message_ids,idempotency_key)
  values(p_project_id,p_inquiry_id,(select coalesce(max(d.version),0)+1 from public.inquiry_drafts d where d.inquiry_id=p_inquiry_id),
    'draft',btrim(p_subject),p_body_text,array[lower(btrim(p_to_email))],btrim(p_created_by),v_mailbox,v_inquiry.gmail_thread_id,
    btrim(p_in_reply_to),p_reference_message_ids,p_idempotency_key) returning * into v_draft;
  update public.inquiries i set status='drafted',updated_at=clock_timestamp() where i.id=v_inquiry.id and i.status in ('new','needs_review','drafted');
  return query select v_draft.id,v_draft.inquiry_id,v_draft.version,v_draft.state::text,v_draft.subject,v_draft.body_text,v_draft.to_emails;
end;
$$;

commit;
