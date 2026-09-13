\set ON_ERROR_STOP on
begin;
set request.jwt.claim.role='service_role';
do $$
declare c uuid; b uuid; p uuid; snapshot jsonb; spec jsonb; a jsonb; other jsonb; valid boolean;
begin
 select id into strict p from tour_projects where slug='8-lakes-tours';
 insert into customers(first_name,last_name,email) values('Shared','Checkout','shared-checkout@example.invalid') returning id into c;
 insert into bookings(customer_id,project_id,public_reference,tour_date,guest_count,status,online_due_usd,online_paid_usd)
 values(c,p,'CHECKOUT-TEST','scheduled',1,'awaiting_payment',999,0) returning id into b;
 select jsonb_build_object('id',id,'customer_id',customer_id,'public_reference',public_reference,'tour_date',tour_date,'guest_count',guest_count,'status',status,'online_due_usd',online_due_usd,'online_paid_usd',online_paid_usd) into snapshot from bookings where id=b;
 spec:=jsonb_build_object('client_reference_id','CHECKOUT-TEST','metadata',jsonb_build_object('booking_id',b,'customer_id',c,'guest_count','1'),'line_items',jsonb_build_array(jsonb_build_object('quantity',1,'price_data',jsonb_build_object('unit_amount',99900,'currency','usd'))));
 a:=prepare_booking_checkout(b,snapshot,spec,'{}',null);
 other:=prepare_booking_checkout(b,snapshot,spec||'{"source":"ops"}'::jsonb,'{}',null);
 if a->>'key'<>other->>'key' or a->'spec'<>other->'spec' then raise exception 'public and Ops do not share frozen generation'; end if;
 -- A foreign pending ledger write between provider acceptance and finalization fences URL release.
 insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values(b,'stripe','cs_other',999,'pending');
 if not (select invalidated from booking_checkout_ownership where booking_id=b) then raise exception 'unbound generation was not durably fenced'; end if;
 valid:=finalize_booking_checkout(b,a->>'key','cs_public','https://checkout.stripe.com/test',extract(epoch from now()+interval '1 hour')::bigint);
 if valid then raise exception 'competing pending session not fenced'; end if;
 delete from payments where booking_id=b;
 delete from booking_checkout_ownership where booking_id=b;
 a:=prepare_booking_checkout(b,snapshot,spec,'{}',null);
 insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values(b,'stripe','cs_paid',999,'paid');
 if finalize_booking_checkout(b,a->>'key','cs_public','https://checkout.stripe.com/test',1) then raise exception 'paid ledger before booking reconciliation not fenced'; end if;
 delete from payments where booking_id=b;
 delete from booking_checkout_ownership where booking_id=b;
 a:=prepare_booking_checkout(b,snapshot,spec,'{}',null);
 update bookings set status='cancelled' where id=b;
 if finalize_booking_checkout(b,a->>'key','cs_public','https://checkout.stripe.com/test',1) then raise exception 'cancellation not fenced'; end if;
 update bookings set status='awaiting_payment' where id=b;
 begin
  perform prepare_booking_checkout(b,snapshot,spec,'{}',null);
  raise exception 'invalidated generation was replaced';
 exception when others then if sqlerrm='invalidated generation was replaced' then raise; end if; end;
 delete from booking_checkout_ownership where booking_id=b;
 a:=prepare_booking_checkout(b,snapshot,spec,'{}',null);
 if not finalize_booking_checkout(b,a->>'key','cs_final','https://checkout.stripe.com/test',1) then raise exception 'valid finalize rejected'; end if;
 if not finalize_booking_checkout(b,a->>'key','cs_final','https://checkout.stripe.com/test',1) then raise exception 'idempotent finalize rejected'; end if;
 if (select count(*) from payments where booking_id=b)<>1 then raise exception 'duplicate pending rows'; end if;
 if (select jsonb_typeof(raw_event->'checkout_expires_at') from payments where booking_id=b) <> 'string' then
   raise exception 'Ops expiry display requires ISO timestamp, not epoch seconds';
 end if;
 other:=prepare_booking_checkout(b,snapshot,spec,'{cs_final}',null);
 if a->>'key'=other->>'key' then raise exception 'verified expiry did not advance generation'; end if;
end $$;
rollback;
