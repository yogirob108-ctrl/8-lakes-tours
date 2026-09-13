-- Rollback-only independent review regressions. Run with ON_ERROR_STOP.
begin;
create function pg_temp.seed_inquiry() returns uuid language plpgsql as $$
declare p uuid; l uuid:=gen_random_uuid(); i uuid;
begin
 select id into strict p from public.tour_projects where slug='8-lakes-tours';
 perform * from public.claim_inquiry_sync('gmail',p,'8lakestours@gmail.com',l);
 perform * from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',l,'blockers','new','Alice','alice@example.invalid',array['8lakestours@gmail.com'],'{}','Newest','Question','{"message_id":"<new@test.invalid>","references":["<new@test.invalid>"]}','2026-09-13T12:00:00Z','import','price','blockers','new');
 select id into strict i from public.inquiries where gmail_thread_id='blockers' and project_id=p;
 return i;
end $$;
select pg_temp.seed_inquiry();
savepoint fixture;
do $$
declare p uuid; i uuid; l uuid; n int; r record;
begin
 select id,project_id into i,p from public.inquiries where gmail_thread_id='blockers';
 select lease_token into l from public.inquiry_sync_state where project_id=p and gmail_account_email='8lakestours@gmail.com';
 select * into strict r from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',l,'blockers','bob','Bob','bob@example.invalid',array['8lakestours@gmail.com'],'{}','Bob confidential','Private','{"message_id":"<bob@test.invalid>"}','2026-09-13T12:01:00Z','import','price','blockers','bob');
 select count(*) into n from public.inquiry_messages where inquiry_id=i and from_email='bob@example.invalid';
 assert n=0, 'canonical reconciliation attached foreign participant';
 assert r.terminal_label='review' and not r.message_imported, 'participant change must route to manual review';
end $$;
rollback to fixture;
do $$
declare p uuid; i uuid; n int;
begin
 select id,project_id into i,p from public.inquiries where gmail_thread_id='blockers';
 select count(*) into n from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'new','Re: forged','Forged','alice@example.invalid','test','<bob@test.invalid>',array['<bob@test.invalid>'],'forged','[]','{}');
 assert n=0, 'draft accepted nonexistent or foreign source';
 select count(*) into n from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'new','Re: new','Wrong recipient','bob@example.invalid','test','<new@test.invalid>',array['<new@test.invalid>'],'wrong-to','[]','{}');
 assert n=0, 'draft accepted recipient different from canonical source';
end $$;
rollback to fixture;
do $$
declare p uuid; i uuid; l uuid; d record; n int;
begin
 select id,project_id into i,p from public.inquiries where gmail_thread_id='blockers';
 select lease_token into l from public.inquiry_sync_state where project_id=p and gmail_account_email='8lakestours@gmail.com';
 select * into strict d from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'new','Re: newest','NEWEST ANSWER','alice@example.invalid','test','<new@test.invalid>',array['<new@test.invalid>'],'new-draft','[]','{}');
 perform * from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',l,'blockers','old','Alice','alice@example.invalid',array['8lakestours@gmail.com'],'{}','Old','Old question','{"message_id":"<old@test.invalid>"}','2026-09-12T12:00:00Z','import','price','blockers','old');
 select count(*) into n from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'drafted','Re: old','OLDER ANSWER GENERATED LAST','alice@example.invalid','test','<old@test.invalid>',array['<old@test.invalid>'],'old-draft','[]','{}');
 assert n=0, 'late older source replaced newest draft';
 select count(*) into n from public.inquiry_drafts where inquiry_id=i and state='draft';
 assert n=1, 'multiple active drafts';
end $$;
rollback to fixture;
-- Independent source binding must reject inherited multi-participant evidence too.
do $$
declare p uuid; i uuid; l uuid; n int;
begin
 select id,project_id into i,p from public.inquiries where gmail_thread_id='blockers';
 select lease_token into l from public.inquiry_sync_state where project_id=p and gmail_account_email='8lakestours@gmail.com';
 insert into public.inquiry_messages(project_id,inquiry_id,direction,gmail_account_email,gmail_thread_id,gmail_message_id,provider,sync_lease_token,idempotency_key,from_email,to_emails,cc_emails,subject,body_text,raw_headers,occurred_at)
 values(p,i,'inbound','8lakestours@gmail.com','blockers','legacy-cc','gmail',l,'legacy-cc','alice@example.invalid',array['8lakestours@gmail.com'],array['bob@example.invalid'],'CC privacy','Question','{"message_id":"<cc@test.invalid>"}','2026-09-13T13:00:00Z');
 select count(*) into n from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'new','Re: cc','Unsafe source','alice@example.invalid','test','<cc@test.invalid>',array['<cc@test.invalid>'],'cc-draft','[]','{}');
 assert n=0, 'draft accepted inherited multi-participant source';
end $$;
rollback to fixture;
-- These retain the inherited signature intentionally: stale legacy clients must fail closed.
do $$
declare p uuid; i uuid; d record; n int;
begin
 select id,project_id into i,p from public.inquiries where gmail_thread_id='blockers';
 select * into strict d from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'new','Re: newest','Original','alice@example.invalid','test','<new@test.invalid>',array['<new@test.invalid>'],'cas-draft','[]','{}');
 perform * from public.save_inquiry_draft(p,'8lakestours@gmail.com',i,d.id,d.version,'Re: A','OPERATOR A TEXT','alice@example.invalid');
 select count(*) into n from public.save_inquiry_draft(p,'8lakestours@gmail.com',i,d.id,d.version,'Re: B','UNSEEN TEXT','alice@example.invalid');
 assert n=0, 'second save with same expected version accepted';
 select count(*) into n from public.submit_inquiry_draft_for_review(p,'8lakestours@gmail.com',i,d.id,d.version);
 assert n=0, 'legacy submission without content revision accepted';
end $$;
rollback;
