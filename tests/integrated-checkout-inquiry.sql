-- Combined release regression; synthetic rows only, transaction rolled back.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare p uuid; c uuid; b uuid; i uuid; d uuid; lease uuid:=gen_random_uuid(); n integer; before_sources jsonb; before_messages jsonb; result jsonb;
begin
 select id into strict p from public.tour_projects where slug='8-lakes-tours';
 insert into public.customers(first_name,last_name,email) values('Combined','Test','combined@example.invalid') returning id into c;
 perform * from public.claim_inquiry_sync('gmail',p,'8lakestours@gmail.com',lease);
 perform * from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',lease,'combined-thread','combined-message','Combined Test','combined@example.invalid',array['8lakestours@gmail.com'],'{}','Price','Question','{"message_id":"<combined@example.invalid>"}',now(),'import','price','combined-thread-key','combined-message-key');
 select id,customer_id into strict i,c from public.inquiries where project_id=p and gmail_thread_id='combined-thread';
 select id into strict d from public.create_grounded_inquiry_draft(p,'8lakestours@gmail.com',i,'new','Re: Price','Operator review required','combined@example.invalid','test','<combined@example.invalid>',array['<combined@example.invalid>'],'combined-draft-key','[]',array['price']);
 perform public.import_inquiry_thread_history(p,'8lakestours@gmail.com',lease,'combined-thread','[{"id":"combined-history","from":"combined@example.invalid","to":["8lakestours@gmail.com"],"occurredAt":"2026-09-12T12:00:00Z","subject":"Earlier question","body":"Historical question","messageId":"<history@example.invalid>"}]');
 select jsonb_agg(to_jsonb(s) order by s.draft_id) into before_sources from public.inquiry_draft_sources s where draft_id=d;
 select jsonb_agg(to_jsonb(m) order by m.id) into before_messages from public.inquiry_messages m where inquiry_id=i;
 assert before_sources is not null and jsonb_array_length(before_messages)>=2, 'missing draft provenance or imported history';
 insert into public.bookings(public_reference,project_id,customer_id,tour_date,status,online_due_usd,online_paid_usd) values('COMBINED-DELETE',p,c,'test only','awaiting_payment',100,0) returning id into b;
 update public.inquiries set status='qualified' where id=i;
 select count(*) into n from public.convert_inquiry(p,'8lakestours@gmail.com',i,b,'qualified');
 assert n=0,'pending checkout converted';
 result:=public.delete_ops_booking_record(p,b,'COMBINED-DELETE');
 assert result->>'deleted_booking_id'=b::text,'unconverted booking deletion failed';
 assert exists(select 1 from public.customers where id=c),'customer deleted';
 assert exists(select 1 from public.inquiries where id=i and status='qualified'),'inquiry deleted or changed';
 assert (select jsonb_agg(to_jsonb(s) order by s.draft_id) from public.inquiry_draft_sources s where draft_id=d)=before_sources,'provenance changed on unrelated booking deletion';
 insert into public.bookings(public_reference,project_id,customer_id,tour_date,status,online_due_usd,online_paid_usd) values('COMBINED-PAID',p,c,'test only','confirmed',100,99) returning id into b;
 insert into public.payments(booking_id,amount_usd,status,stripe_payment_intent_id) values(b,100,'paid','pi_combined_local');
 insert into public.email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status) values(b,c,'test_fixture','combined@example.invalid','Local record only','No transport called','local-test','sent');
 select count(*) into n from public.convert_inquiry(p,'8lakestours@gmail.com',i,b,'qualified');
 assert n=0,'partial booking balance converted';
 update public.bookings set online_paid_usd=100 where id=b;
 select count(*) into n from public.convert_inquiry(p,'8lakestours@gmail.com',i,b,'qualified');
 assert n=1,'settled booking did not convert';
 begin
  perform public.delete_ops_booking_record(p,b,'COMBINED-PAID');
  raise exception 'converted booking unexpectedly deleted';
 exception when foreign_key_violation then null;
 end;
 assert exists(select 1 from public.bookings where id=b),'restricted deletion lost parent';
 assert exists(select 1 from public.payments where booking_id=b and amount_usd=100),'restricted deletion lost payment';
 assert exists(select 1 from public.email_events where booking_id=b),'restricted deletion did not roll back earlier email deletion';
 assert exists(select 1 from public.inquiries where id=i and status='converted' and converted_booking_id=b),'conversion linkage lost';
 assert (select jsonb_agg(to_jsonb(s) order by s.draft_id) from public.inquiry_draft_sources s where draft_id=d)=before_sources,'converted deletion altered provenance';
 assert (select jsonb_agg(to_jsonb(m) order by m.id) from public.inquiry_messages m where inquiry_id=i)=before_messages,'booking deletion altered message history';
 raise notice 'PASS combined: pending/partial conversion refused; settled conversion linked; unconverted delete preserves inquiry/customer/provenance/history; converted delete FK blocks and rolls back email/payment/parent changes; no transport';
end $$;
rollback;
