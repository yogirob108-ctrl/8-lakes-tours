-- Local isolated database only. All fixture rows roll back.
begin;
do $$
declare p uuid; c uuid; b uuid; i uuid; n integer; lease uuid:=gen_random_uuid();
begin
 select id into strict p from public.tour_projects where slug='8-lakes-tours';
 insert into public.customers(first_name,last_name,email) values('Local','Conversion','conversion@example.invalid') returning id into c;
 insert into public.bookings(public_reference,project_id,customer_id,tour_date,status,online_due_usd,online_paid_usd) values('LOCAL-INQUIRY',p,c,'test only','awaiting_payment',100,0) returning id into b;
 perform * from public.claim_inquiry_sync('gmail',p,'only8lakestours@gmail.com',lease);
 perform * from public.reconcile_inbound_inquiry_message(p,'only8lakestours@gmail.com',lease,'conversion-thread','conversion-message','Local Test','conversion@example.invalid',array['only8lakestours@gmail.com'],'{}','Test inquiry','Test question', '{"message_id":"<test@example.invalid>"}', now(),'import','price','conversion-thread-key','conversion-message-key');
 select id into strict i from public.inquiries where project_id=p and gmail_thread_id='conversion-thread';
 update public.inquiries set status='qualified' where id=i;
 select count(*) into n from public.convert_inquiry(p,'only8lakestours@gmail.com',i,b,'qualified');
 if n<>0 then raise exception 'pending checkout converted'; end if;
 update public.bookings set status='confirmed',online_paid_usd=99 where id=b;
 select count(*) into n from public.convert_inquiry(p,'only8lakestours@gmail.com',i,b,'qualified');
 if n<>0 then raise exception 'partial payment converted'; end if;
 update public.bookings set online_paid_usd=100 where id=b;
 select count(*) into n from public.convert_inquiry(p,'wrong@example.invalid',i,b,'qualified');
 if n<>0 then raise exception 'wrong mailbox converted'; end if;
 select count(*) into n from public.convert_inquiry(p,'only8lakestours@gmail.com',i,b,'qualified');
 if n<>1 then raise exception 'verified conversion did not succeed'; end if;
 raise notice 'PASS: pending checkout and partial payment blocked; exact scoped settled booking converts';
end $$;
rollback;
