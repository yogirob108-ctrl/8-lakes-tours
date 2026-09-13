begin;
do $$
declare p uuid; i uuid; l uuid:=gen_random_uuid(); r record; d record; n int; scenario text; recipients text[]; cc text[]; owned boolean;
begin
 select id into strict p from public.tour_projects where slug='8-lakes-tours';
 perform * from public.claim_inquiry_sync('gmail',p,'8lakestours@gmail.com',l);
 foreach scenario in array array['alias-only','mailbox-plus-alias','foreign-cc','unverified-alias'] loop
  recipients:=case when scenario='mailbox-plus-alias' then array['8lakestours@gmail.com','info@8lakestours.com'] else array['info@8lakestours.com'] end;
  cc:=case when scenario='foreign-cc' then array['foreign@example.invalid'] else '{}'::text[] end;
  if scenario='unverified-alias' then update public.tour_projects set contact_email='other@example.invalid' where id=p; end if;
  owned:=scenario in ('alias-only','mailbox-plus-alias');
  select * into strict r from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',l,scenario,scenario,'Alice','alias@example.invalid',recipients,cc,'Question','Question','{"message_id":"<alias@example.invalid>"}','2026-09-13T12:00:00Z','import','price',scenario,scenario);
  i:=r.inquiry_id;
  assert r.message_imported=owned, 'alias acceptance mismatch: '||scenario;
  assert r.terminal_label=case when owned then 'imported' else 'review' end, 'alias terminal mismatch: '||scenario;
  assert (select participant_review_required from public.inquiries where id=i)=not owned, 'sticky review mismatch: '||scenario;
  -- History must use exactly the same participant authorization, including CC.
  perform public.import_inquiry_thread_history(p,'8lakestours@gmail.com',l,scenario,jsonb_build_array(jsonb_build_object('id',scenario||'-history','from','alias@example.invalid','to',to_jsonb(recipients),'cc',to_jsonb(cc),'subject','Question','body','History question','occurredAt','2026-09-13T13:00:00Z','headers',jsonb_build_object('message_id','<history@alias.invalid>'))));
  select count(*) into n from public.inquiry_messages where inquiry_id=i;
  assert n=case when owned then 2 else 0 end, 'history alias/foreign guard mismatch: '||scenario;
  select count(*) into n from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'new','Reply','Grounded','alias@example.invalid','test','<history@alias.invalid>',array['<history@alias.invalid>'],scenario||'-draft','[]','{}');
  assert n=case when owned then 1 else 0 end, 'draft alias/foreign guard mismatch: '||scenario;
  if owned then
   select * into strict d from public.inquiry_drafts where inquiry_id=i;
   perform * from public.submit_inquiry_draft_for_review(p,'8lakestours@gmail.com',i,d.id,d.version,1);
   select count(*) into n from public.approve_inquiry_draft(p,'8lakestours@gmail.com',i,d.id,d.version,'reviewer',1);
   assert n=1, 'alias source approval rejected';
  end if;
 end loop;
 -- A matching address on a different project is not verified ownership.
 insert into public.tour_projects(slug,name,contact_email) values('foreign-alias-test','Foreign','info@8lakestours.com') returning id into p;
 assert not public.inquiry_verified_business_alias(p,'info@8lakestours.com'), 'foreign project inherited alias';
 assert not public.inquiry_verified_business_alias(p,'foreign@example.invalid'), 'arbitrary alias trusted';
 assert not has_function_privilege('anon','public.inquiry_verified_business_alias(uuid,text)','execute'), 'alias helper exposed to anon';
 assert not has_function_privilege('authenticated','public.inquiry_verified_business_alias(uuid,text)','execute'), 'alias helper exposed to authenticated';
end $$;
rollback;
