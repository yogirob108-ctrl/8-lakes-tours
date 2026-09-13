begin;
do $$
declare p uuid; i uuid; l uuid:=gen_random_uuid(); d record; r record; n int; saved_revision int;
begin
 select id into strict p from public.tour_projects where slug='8-lakes-tours';
 perform * from public.claim_inquiry_sync('gmail',p,'8lakestours@gmail.com',l);
 perform * from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',l,'revision','one','Alice','revision@example.invalid',array['8lakestours@gmail.com'],'{}','One','Question','{"message_id":"<one@revision.invalid>"}','2026-09-13T12:00:00Z','import','price','revision','one');
 select id into strict i from public.inquiries where gmail_thread_id='revision' and project_id=p;
 select * into strict d from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'new','Re: one','Original','revision@example.invalid','test','<one@revision.invalid>',array['<one@revision.invalid>'],'one-draft','[]','{}');
 select * into strict r from public.save_inquiry_draft(p,'8lakestours@gmail.com',i,d.id,d.version,'Re: saved','Reviewed text','revision@example.invalid',1);
 select content_revision into saved_revision from public.inquiry_drafts where id=d.id;
 assert saved_revision=2, 'save must increment content revision';
 assert r.version=d.version, 'content editing changed generation sequence';
 select count(*) into n from public.save_inquiry_draft(p,'8lakestours@gmail.com',i,d.id,d.version,'Re: stale','Unseen text','revision@example.invalid',1);
 assert n=0, 'stale save accepted';
 select count(*) into n from public.submit_inquiry_draft_for_review(p,'8lakestours@gmail.com',i,d.id,d.version,1);
 assert n=0, 'stale submission accepted';
 select count(*) into n from public.submit_inquiry_draft_for_review(p,'8lakestours@gmail.com',i,d.id,d.version,2);
 assert n=1, 'current submission failed';
 select count(*) into n from public.approve_inquiry_draft(p,'8lakestours@gmail.com',i,d.id,d.version,'reviewer',1);
 assert n=0, 'unseen text approved';
 select count(*) into n from public.approve_inquiry_draft(p,'8lakestours@gmail.com',i,d.id,d.version,'reviewer',2);
 assert n=1, 'reviewed content approval failed';
 perform * from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',l,'revision','two','Alice','revision@example.invalid',array['8lakestours@gmail.com'],'{}','Two','Next question','{"message_id":"<two@revision.invalid>"}','2026-09-13T13:00:00Z','import','price','revision','two');
 select * into strict r from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'drafted','Re: two','Next draft','revision@example.invalid','test','<two@revision.invalid>',array['<two@revision.invalid>'],'two-draft','[]','{}');
 assert r.version=d.version+1, 'generation sequence did not advance';
 assert exists(select 1 from public.inquiry_drafts where id=d.id and body_text='Reviewed text' and approved_at is not null and reviewer='reviewer' and superseded_at is not null and state='cancelled'), 'supersession lost reviewed evidence';
 assert exists(select 1 from public.inquiry_draft_sources where draft_id=d.id), 'supersession lost provenance';
 select count(*) into n from public.inquiry_drafts where inquiry_id=i and state in ('draft','pending_review','approved');
 assert n=1, 'supersession left multiple actionable drafts';
 -- Duplicate old generation returns original evidence, never reactivates it.
 perform * from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'drafted','Changed','Regenerated','revision@example.invalid','test','<one@revision.invalid>',array['<one@revision.invalid>'],'one-draft','[]','{}');
 assert exists(select 1 from public.inquiry_drafts where id=d.id and body_text='Reviewed text' and superseded_at is not null), 'retry rewrote reviewed evidence';
end $$;
rollback;
