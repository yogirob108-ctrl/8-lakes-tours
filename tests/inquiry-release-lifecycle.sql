begin;
do $$
declare p uuid; i uuid; c uuid; b uuid; n integer; s text; lease uuid:=gen_random_uuid();
begin
 if has_function_privilege('anon','public.checkpoint_inquiry_sync(uuid,text,uuid,jsonb)','execute') or has_function_privilege('authenticated','public.import_inquiry_thread_history(uuid,text,uuid,text,jsonb)','execute') or not has_function_privilege('service_role','public.reconcile_inquiry_booking(uuid,text,uuid,uuid,uuid,public.inquiry_status)','execute') then raise exception 'RPC ACL failure'; end if;
 select id into strict p from public.tour_projects where slug='8-lakes-tours';
 perform * from public.claim_inquiry_sync('gmail',p,'8lakestours@gmail.com',lease);
 perform * from public.checkpoint_inquiry_sync(p,'8lakestours@gmail.com',lease,'{"pending":["poison"],"pageToken":"next"}');
 select count(*) into n from public.finish_inquiry_sync('gmail',p,'8lakestours@gmail.com',lease,'10');
 if n<>0 then raise exception 'cursor advanced over pending work'; end if;
 if not exists(select 1 from public.inquiry_sync_state where project_id=p and gmail_account_email='8lakestours@gmail.com' and continuation->>'pageToken'='next') then raise exception 'checkpoint missing'; end if;
 select count(*) into n from public.renew_inquiry_sync('gmail',p,'8lakestours@gmail.com',gen_random_uuid(),300);
 if n<>0 then raise exception 'wrong lease renewed'; end if;
 perform * from public.renew_inquiry_sync('gmail',p,'8lakestours@gmail.com',lease,300);
 perform * from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',lease,'release-thread','release-in','Later Guest','later-release@example.invalid',array['8lakestours@gmail.com'],'{}','Question','price', '{"message_id":"<release@example.invalid>"}',now(),'import','price','release-thread','release-in');
 select id into strict i from public.inquiries where project_id=p and gmail_thread_id='release-thread';
 perform public.import_inquiry_thread_history(p,'8lakestours@gmail.com',lease,'release-thread','[{"id":"release-out","from":"8lakestours@gmail.com","to":["later-release@example.invalid"],"subject":"Re","body":"Prior reply","occurredAt":"2026-09-13T00:00:00Z","headers":{}}]');
 perform public.import_inquiry_thread_history(p,'8lakestours@gmail.com',lease,'release-thread','[{"id":"release-out","from":"8lakestours@gmail.com","to":["later-release@example.invalid"],"subject":"Re","body":"Prior reply","occurredAt":"2026-09-13T00:00:00Z","headers":{}}]');
 if (select count(*) from public.inquiry_messages where inquiry_id=i and direction='outbound')<>1 then raise exception 'history replay duplicated'; end if;
 foreach s in array array['contacted','replied','qualified'] loop
  update public.inquiries set status=s::public.inquiry_status where id=i;
  select count(*) into n from public.create_inquiry_draft(p,'8lakestours@gmail.com',i,s::public.inquiry_status,'Re','review only','later-release@example.invalid','test','<release@example.invalid>',array['<release@example.invalid>'],'follow-'||s);
  if n<>1 or (select status::text from public.inquiries where id=i)<>s then raise exception 'followup regressed %',s; end if;
  select count(*) into n from public.create_inquiry_draft(p,'8lakestours@gmail.com',i,'new','Re','stale','later-release@example.invalid','test','<release@example.invalid>',array['<release@example.invalid>'],'stale-'||s);
  if n<>0 then raise exception 'stale accepted'; end if;
 end loop;
 insert into public.customers(first_name,last_name,email) values('Later','Guest','later-release@example.invalid') returning id into c;
 insert into public.bookings(public_reference,project_id,customer_id,tour_date,status,online_due_usd,online_paid_usd) values('LOCAL-LATE-RELEASE',p,c,'test','awaiting_payment',100,0) returning id into b;
 select count(*) into n from public.reconcile_inquiry_booking(p,'8lakestours@gmail.com',lease,i,b,'qualified');
 if n<>0 then raise exception 'pending later booking converted'; end if;
 update public.bookings set status='confirmed',online_paid_usd=100 where id=b;
 select count(*) into n from public.reconcile_inquiry_booking(p,'8lakestours@gmail.com',lease,i,b,'qualified');
 if n<>1 or (select customer_id from public.inquiries where id=i)<>c then raise exception 'later identity not reconciled'; end if;
 select count(*) into n from public.create_inquiry_draft(p,'8lakestours@gmail.com',i,'converted','Re','terminal','later-release@example.invalid','test','<release@example.invalid>',array['<release@example.invalid>'],'terminal-converted');
 if n<>0 then raise exception 'converted draft accepted'; end if;
 -- Terminal states each require a separate inquiry because terminal transitions are guarded.
 foreach s in array array['lost','ignored'] loop
  perform * from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',lease,'terminal-'||s,'terminal-'||s,'Test','terminal@example.invalid',array['8lakestours@gmail.com'],'{}','Q','Q','{}',now(),'import','price','terminal-'||s,'terminal-'||s);
  select id into strict i from public.inquiries where project_id=p and gmail_thread_id='terminal-'||s;
  update public.inquiries set status=s::public.inquiry_status,lost_reason=case when s='lost' then 'test' end where id=i;
  select count(*) into n from public.create_inquiry_draft(p,'8lakestours@gmail.com',i,s::public.inquiry_status,'Re','terminal','terminal@example.invalid','test','<release@example.invalid>',array['<release@example.invalid>'],'terminal-'||s);
  if n<>0 then raise exception 'terminal draft accepted %',s; end if;
 end loop;
 perform * from public.checkpoint_inquiry_sync(p,'8lakestours@gmail.com',lease,'{"discoveryDone":true,"pending":[]}');
 perform * from public.finish_inquiry_sync('gmail',p,'8lakestours@gmail.com',lease,'10');
 perform * from public.claim_inquiry_sync('gmail',p,'8lakestours@gmail.com',lease);
 perform * from public.checkpoint_inquiry_sync(p,'8lakestours@gmail.com',lease,'{"discoveryDone":true,"pending":[]}');
 perform * from public.finish_inquiry_sync('gmail',p,'8lakestours@gmail.com',lease,'10');
 if exists(select 1 from public.inquiry_sync_state where project_id=p and gmail_account_email='8lakestours@gmail.com' and continuation is not null) then raise exception 'unchanged cursor left stale continuation'; end if;
 raise notice 'PASS: checkpoint, renewal, read-only outbound history replay, followup lifecycle and later settled identity';
end $$;
rollback;
