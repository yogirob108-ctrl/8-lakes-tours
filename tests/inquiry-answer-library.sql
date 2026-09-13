-- Run only against an isolated local test database loaded from the repository migrations.
begin;
-- Supabase installs baseline service-role table grants outside these app migrations.
grant select on public.tour_projects to service_role;
-- This local cluster's service_role lacks Supabase's BYPASSRLS. Test-only read policies.
create policy local_service_read on public.tour_projects for select to service_role using (true);
create policy local_service_read on public.inquiries for select to service_role using (true);
create policy local_service_read on public.inquiry_draft_sources for select to service_role using (true);
set local role service_role;
do $$
declare p uuid; a public.inquiry_answers%rowtype; n integer; lease uuid:=gen_random_uuid(); i uuid; d uuid; d2 uuid;
begin
 select id into strict p from public.tour_projects where slug='8-lakes-tours';
 select * into strict a from public.save_inquiry_answer(p,'price','Test question','Test answer','https://example.invalid/source','Test provenance',0);
 if a.status<>'draft' or a.revision<>1 then raise exception 'wrong initial answer state'; end if;
 select * into strict a from public.approve_inquiry_answer(p,'price',1,'test reviewer');
 if a.status<>'approved' or a.approved_at is null then raise exception 'missing approval evidence'; end if;
 select count(*) into n from public.save_inquiry_answer(p,'price','stale','stale','https://example.invalid','stale',0);
 if n<>0 then raise exception 'stale insert accepted'; end if;
 select * into strict a from public.save_inquiry_answer(p,'price','Edited question','Edited answer','https://example.invalid/source','New source',1);
 if a.status<>'draft' or a.revision<>2 or a.approved_at is not null then raise exception 'edit retained approval'; end if;
 select count(*) into n from public.approve_inquiry_answer(p,'price',1,'stale reviewer');
 if n<>0 then raise exception 'stale approval accepted'; end if;
 perform * from public.claim_inquiry_sync('gmail',p,'only8lakestours@gmail.com',lease);
 perform * from public.reconcile_inbound_inquiry_message(p,'only8lakestours@gmail.com',lease,'local-thread','local-message','Local Test','inquiry-test@example.invalid',array['only8lakestours@gmail.com'],'{}','Test price question','What is the price?', '{"message_id":"<local@example.invalid>","references":["<local@example.invalid>"]}', now(),'import','price','local-thread-key','local-message-key');
 select id into strict i from public.inquiries where project_id=p and gmail_thread_id='local-thread';
 select id into strict d from public.create_grounded_inquiry_draft(p,'only8lakestours@gmail.com',i,'new','Re: Test','No approved price; operator will review','inquiry-test@example.invalid','test','<local@example.invalid>',array['<local@example.invalid>'],'local-draft-key','[]',array['price']);
 select id into strict d2 from public.create_grounded_inquiry_draft(p,'only8lakestours@gmail.com',i,'drafted','Changed','Different answer after library edit','inquiry-test@example.invalid','test','<local@example.invalid>',array['<local@example.invalid>'],'local-draft-key','[]',array['price']);
 if d<>d2 then raise exception 'duplicate draft created'; end if;
 select count(*) into n from public.inquiry_draft_sources where draft_id=d and project_id=p and unanswered_topics=array['price'];
 if n<>1 then raise exception 'missing atomic provenance'; end if;
 if has_table_privilege('anon','public.inquiry_answers','select') or has_table_privilege('authenticated','public.inquiry_answers','update') or has_table_privilege('service_role','public.inquiry_draft_sources','update') then raise exception 'unsafe privileges'; end if;
 raise notice 'PASS: answer CAS, approval invalidation, draft idempotency, atomic provenance, role permissions';
end $$;
rollback;
