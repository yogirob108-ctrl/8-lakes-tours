\set ON_ERROR_STOP on
begin;
-- Supabase's service_role bypass is emulated only inside this rolled-back local test.
do $$ declare t text; begin
 foreach t in array array['tour_projects','customers','bookings','inquiries','inquiry_messages','inquiry_drafts','inquiry_import_runs','inquiry_sync_state'] loop
  execute format('create policy runtime_local_service on public.%I for all to service_role using(true) with check(true)',t);
 end loop;
end $$;
insert into public.tour_projects (id, slug, name)
values ('00000000-0000-4000-8000-000000000002', 'rpc-other', 'RPC Other');
insert into public.inquiry_sync_state(provider, project_id, gmail_account_email, lease_token, lease_expires_at)
values ('gmail', '00000000-0000-4000-8000-000000000002', 'expired@example.com',
        '00000000-0000-4000-8000-000000000003', clock_timestamp() - interval '1 second');
grant select, insert on public.tour_projects, public.customers, public.bookings to service_role;
set role service_role;

do $$
declare
  v_project uuid;
  v_other_project uuid := '00000000-0000-4000-8000-000000000002';
  v_customer uuid;
  v_booking uuid;
  v_inquiry uuid;
  v_inquiry2 uuid;
  v_draft uuid;
  v_draft2 uuid;
  v_run uuid;
  v_claim record;
  v_row record;
  v_lease uuid := gen_random_uuid();
  v_expired_lease uuid := '00000000-0000-4000-8000-000000000003';
begin
  select id into v_project from public.tour_projects order by created_at limit 1;
  insert into public.customers (email, first_name, last_name) values ('rpc@example.com', 'RPC', 'Test') returning id into v_customer;

  select * into v_row from public.claim_inquiry_sync('gmail', v_project, ' OPS@EXAMPLE.COM ', v_lease);
  if v_row.gmail_account_email <> 'ops@example.com' then raise exception 'mailbox was not normalized'; end if;

  begin
    perform * from public.reconcile_inbound_inquiry_message(
      v_project, 'ops@example.com', gen_random_uuid(), 'wrong-token-thread', 'wrong-token-message', 'RPC Test', 'rpc@example.com',
      array['ops@example.com'], array[]::text[], 'Wrong token', 'Must not persist', '{}', clock_timestamp(),
      'import', 'dates', 'wrong-token-inquiry-key', 'wrong-token-message-key');
    raise exception 'wrong-token inbound reconciliation was accepted';
  exception when sqlstate '55000' then null;
  end;

  begin
    insert into public.inquiry_import_runs(project_id, gmail_account_email, lease_token, idempotency_key, status, dry_run)
    values(v_project, 'ops@example.com', gen_random_uuid(), 'wrong-token-run', 'running', false);
    raise exception 'wrong-token import run was accepted';
  exception when sqlstate '55000' then null;
  end;
  insert into public.inquiry_import_runs(project_id, gmail_account_email, lease_token, idempotency_key, status, dry_run)
  values(v_project, 'ops@example.com', v_lease, 'owned-run', 'running', false) returning id into v_run;
  begin
    update public.inquiry_import_runs set lease_token=gen_random_uuid() where id=v_run;
    raise exception 'wrong-token import run update was accepted';
  exception when sqlstate '55000' then null;
  end;
  update public.inquiry_import_runs set status='completed', completed_at=clock_timestamp(), lease_token=v_lease where id=v_run;

  select * into v_row from public.reconcile_inbound_inquiry_message(
    v_project, ' OPS@EXAMPLE.COM ', v_lease, 'thread-1', 'message-1', 'RPC Test', 'rpc@example.com',
    array['ops@example.com'], array[]::text[], 'Hello', 'Body', '{"message_id":"<incoming@example.com>"}',
    clock_timestamp(), 'import', 'dates', 'inquiry-key-1', 'message-key-1');
  v_inquiry := v_row.inquiry_id;
  if v_row.duplicate or not v_row.message_imported or not v_row.inquiry_created or v_row.terminal_label <> 'imported' then
    raise exception 'initial inbound reconciliation result invalid';
  end if;

  select * into v_row from public.reconcile_inbound_inquiry_message(
    v_project, 'ops@example.com', v_lease, 'thread-1', 'message-1', 'Changed', 'rpc@example.com',
    array['ops@example.com'], array[]::text[], 'Changed', 'Changed', '{}', clock_timestamp(),
    'review', 'price', 'different-inquiry-key', 'different-message-key');
  if not v_row.duplicate or v_row.message_imported or v_row.inquiry_created or v_row.terminal_label <> 'imported' then
    raise exception 'duplicate reconciliation result invalid';
  end if;

  select id into v_draft from public.create_inquiry_draft(v_project, 'OPS@example.com', v_inquiry, 'new', 'Re: Hello', 'Draft one', 'rpc@example.com', 'ops', '<incoming@example.com>', array['<incoming@example.com>'], 'draft-key-1');
  if v_draft is null then raise exception 'draft was not created'; end if;
  if exists (select 1 from public.create_inquiry_draft(v_other_project, 'ops@example.com', v_inquiry, 'drafted', 'x', 'x', 'x@example.com', 'x', '<x@example.com>', array['<x@example.com>'], 'x')) then raise exception 'wrong project draft create was accepted'; end if;
  if not exists (select 1 from public.save_inquiry_draft(v_project, 'ops@example.com', v_inquiry, v_draft, 1, 'Re: Hello', 'Draft two', 'rpc@example.com', 1)) then raise exception 'draft save failed'; end if;
  if not exists (select 1 from public.submit_inquiry_draft_for_review(v_project, 'ops@example.com', v_inquiry, v_draft, 1, 2)) then raise exception 'submit failed'; end if;
  if not exists (select 1 from public.approve_inquiry_draft(v_project, 'ops@example.com', v_inquiry, v_draft, 1, 'reviewer', 2)) then raise exception 'approve failed'; end if;
  begin
    update public.inquiry_drafts set state='rejected' where id=v_draft;
    raise exception 'approved draft was recycled to rejected';
  exception when check_violation then null;
  end;

  select * into v_claim from public.claim_inquiry_draft_send(v_project, ' OPS@EXAMPLE.COM ', v_draft);
  if v_claim.state <> 'sending' or v_claim.send_attempt_id is null or v_claim.rfc_message_id !~ '^<inquiry-[0-9a-f-]+@ops\.8lakestours\.com>$' or cardinality(v_claim.references) <> 1 then raise exception 'claim evidence invalid'; end if;
  if exists (select 1 from public.claim_inquiry_draft_send(v_project, 'ops@example.com', v_draft)) then raise exception 'second claim accepted'; end if;
  if not exists (select 1 from public.record_inquiry_draft_delivery_unknown(v_project, 'ops@example.com', v_draft, v_claim.claim_token, v_claim.send_attempt_id, v_claim.rfc_message_id, null, null)) then raise exception 'unknown delivery not recorded'; end if;
  if exists (select 1 from public.claim_inquiry_draft_send(v_project, 'ops@example.com', v_draft)) then raise exception 'unknown draft became claimable'; end if;
  select * into v_row from public.get_inquiry_draft_send_reconciliation(v_project, 'ops@example.com', v_draft);
  if v_row.send_attempt_id is distinct from v_claim.send_attempt_id or v_row.rfc_message_id is distinct from v_claim.rfc_message_id then raise exception 'reconciliation read evidence invalid'; end if;
  if not exists (select 1 from public.record_inquiry_draft_reconciliation_check(v_project, 'ops@example.com', v_draft, v_claim.claim_token, v_claim.send_attempt_id, v_claim.rfc_message_id, 0)) then raise exception 'reconciliation check failed'; end if;
  if not exists (select 1 from public.reconcile_inquiry_draft_send_acceptance(v_project, 'ops@example.com', v_draft, v_claim.claim_token, v_claim.send_attempt_id, v_claim.rfc_message_id, 'gmail', 'provider-message-1', 'thread-1', 'Re: Hello', 'Draft two')) then raise exception 'acceptance reconciliation failed'; end if;
  if not exists (select 1 from public.reconcile_inquiry_draft_send_acceptance(v_project, 'ops@example.com', v_draft, v_claim.claim_token, v_claim.send_attempt_id, v_claim.rfc_message_id, 'gmail', 'provider-message-1', 'thread-1', 'Re: Hello', 'Draft two')) then raise exception 'acceptance replay failed'; end if;
  if (select status from public.inquiries where id = v_inquiry) <> 'contacted' then raise exception 'finalization status invalid'; end if;

  select * into v_row from public.reconcile_inbound_inquiry_message(
    v_project, 'ops@example.com', v_lease, 'thread-1', 'message-1b', 'RPC Test', 'rpc@example.com',
    array['ops@example.com'], array[]::text[], 'Re: Hello', 'Reply', '{}', clock_timestamp() + interval '1 second',
    'import', 'followup', 'inquiry-key-1', 'message-key-1b');
  if (select status from public.inquiries where id=v_inquiry) <> 'replied' then raise exception 'post-outbound inbound did not advance to replied'; end if;

  if exists (select 1 from public.update_inquiry_pipeline(v_project, 'wrong@example.com', v_inquiry, 'replied', 'qualified', null, null)) then raise exception 'wrong mailbox update accepted'; end if;
  if not exists (select 1 from public.update_inquiry_pipeline(v_project, 'ops@example.com', v_inquiry, 'replied', 'qualified', null, null)) then raise exception 'pipeline CAS failed'; end if;
  if exists (select 1 from public.update_inquiry_pipeline(v_project, 'ops@example.com', v_inquiry, 'contacted', 'lost', 'stale', null)) then raise exception 'stale pipeline CAS accepted'; end if;

  insert into public.bookings(public_reference, project_id, customer_id, tour_date,status,online_due_usd,online_paid_usd)
  values ('RPC-CONVERT-1', v_project, v_customer, 'September 14–22, 2026','confirmed',999,999) returning id into v_booking;
  if exists (select 1 from public.convert_inquiry(v_other_project, 'ops@example.com', v_inquiry, v_booking, 'qualified')) then raise exception 'wrong project conversion accepted'; end if;
  if not exists (select 1 from public.convert_inquiry(v_project, 'ops@example.com', v_inquiry, v_booking, 'qualified')) then raise exception 'conversion failed'; end if;

  begin
    update public.inquiries set status='contacted' where id=v_inquiry;
    raise exception 'direct status regression accepted';
  exception when check_violation then null;
  end;

  select inquiry_id into v_inquiry2 from public.reconcile_inbound_inquiry_message(
    v_project, 'ops@example.com', v_lease, 'thread-2', 'message-2', 'RPC Test', 'rpc@example.com',
    array['ops@example.com'], array[]::text[], 'Second', 'Body', '{"message_id":"<second@example.com>"}', clock_timestamp(),
    'import', 'dates', 'inquiry-key-2', 'message-key-2');
  select id into v_draft2 from public.create_inquiry_draft(v_project, 'ops@example.com', v_inquiry2, 'new', 'Re: Second', 'Direct send', 'rpc@example.com', 'ops', '<second@example.com>', array['<second@example.com>'], 'draft-key-2');
  perform public.submit_inquiry_draft_for_review(v_project, 'ops@example.com', v_inquiry2, v_draft2, 1, 1);
  perform public.approve_inquiry_draft(v_project, 'ops@example.com', v_inquiry2, v_draft2, 1, 'reviewer', 1);
  select * into v_claim from public.claim_inquiry_draft_send(v_project, 'ops@example.com', v_draft2);
  if not exists (select 1 from public.record_inquiry_draft_send_failure(v_project, 'ops@example.com', v_draft2, v_claim.claim_token, 'pre-provider-test', 'Re: Second', 'Direct send')) then raise exception 'pre-provider failure was not recorded'; end if;
  if exists (select 1 from public.authorize_inquiry_draft_retry(v_project, 'ops@example.com', v_inquiry, v_draft2, 1, 'reviewer', 'wrong inquiry')) then raise exception 'retry accepted wrong inquiry'; end if;
  if exists (select 1 from public.authorize_inquiry_draft_retry(v_project, 'ops@example.com', v_inquiry2, v_draft2, 2, 'reviewer', 'stale version')) then raise exception 'retry accepted stale version'; end if;
  if not exists (select 1 from public.authorize_inquiry_draft_retry(v_project, 'ops@example.com', v_inquiry2, v_draft2, 1, 'reviewer', 'verified pre-provider failure')) then raise exception 'retry authorization failed'; end if;
  select * into v_claim from public.claim_inquiry_draft_send(v_project, 'ops@example.com', v_draft2);
  if exists (select 1 from public.finalize_inquiry_draft_send(v_project, 'wrong@example.com', v_draft2, v_claim.claim_token, 'gmail', 'provider-message-2', 'thread-2', 'Re: Second', 'Direct send')) then raise exception 'wrong account finalization accepted'; end if;
  if not exists (select 1 from public.finalize_inquiry_draft_send(v_project, 'ops@example.com', v_draft2, v_claim.claim_token, 'gmail', 'provider-message-2', 'thread-2', 'Re: Second', 'Direct send')) then raise exception 'direct finalization failed'; end if;
  if not exists (select 1 from public.finalize_inquiry_draft_send(v_project, 'ops@example.com', v_draft2, v_claim.claim_token, 'gmail', 'provider-message-2', 'thread-2', 'Re: Second', 'Direct send')) then raise exception 'direct finalization replay failed'; end if;

  if exists (select 1 from public.renew_inquiry_sync('gmail', v_other_project, 'expired@example.com', v_expired_lease, 60)) then raise exception 'expired lease renewed'; end if;
  if not exists (select 1 from public.renew_inquiry_sync('gmail', v_project, 'ops@example.com', v_lease, 60)) then raise exception 'active lease did not renew'; end if;
  if exists (select 1 from public.release_inquiry_sync_failure('gmail', v_project, 'ops@example.com', gen_random_uuid())) then raise exception 'wrong-token release accepted'; end if;
  if not exists (select 1 from public.finish_inquiry_sync('gmail', v_project, 'ops@example.com', v_lease, '100')) then raise exception 'sync finish failed'; end if;
  v_lease := gen_random_uuid();
  perform public.claim_inquiry_sync('gmail', v_project, 'ops@example.com', v_lease);
  perform public.finish_inquiry_sync('gmail', v_project, 'ops@example.com', v_lease, '99');
  if (select gmail_history_id from public.inquiry_sync_state where provider='gmail' and project_id=v_project and gmail_account_email='ops@example.com') <> '100' then raise exception 'cursor regressed'; end if;
end;
$$;

reset role;
select 'runtime inquiry RPC behavior: ok' as evidence;

rollback;
