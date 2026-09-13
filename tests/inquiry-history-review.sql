begin;
do $$
declare p uuid; i uuid; l uuid:=gen_random_uuid(); m uuid;
begin
 assert to_regclass('public.inquiry_draft_dispositions') is not null, 'late-source manual dispositions have no durable schema';
 select id into strict p from public.tour_projects where slug='8-lakes-tours';
 perform * from public.claim_inquiry_sync('gmail',p,'8lakestours@gmail.com',l);
 perform * from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',l,'history-review','hist-one','Alice','history@example.invalid',array['8lakestours@gmail.com'],'{}','One','Question','{"message_id":"<one@history.invalid>"}','2026-09-13T12:00:00Z','import','price','history-review','hist-one');
 select id into strict i from public.inquiries where gmail_thread_id='history-review' and project_id=p;
 perform public.import_inquiry_thread_history(p,'8lakestours@gmail.com',l,'history-review','[{"id":"foreign-history","from":"bob@example.invalid","to":["8lakestours@gmail.com"],"occurredAt":"2026-09-13T12:01:00Z"}]');
 assert (select participant_review_required from public.inquiries where id=i), 'history participant change not flagged for manual review';
 assert not exists(select 1 from public.inquiry_messages where inquiry_id=i and from_email='bob@example.invalid'), 'history leaked foreign content';
 select id into m from public.inquiry_messages where inquiry_id=i;
 insert into public.inquiry_draft_dispositions(message_id,inquiry_id,project_id,gmail_account_email,reason) values(m,i,p,'8lakestours@gmail.com','participant_changed');
 assert exists(select 1 from public.inquiry_draft_dispositions where message_id=m), 'disposition not retained';
end $$;
rollback;
