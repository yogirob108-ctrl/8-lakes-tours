\set ON_ERROR_STOP on
begin;
set request.jwt.claim.role='service_role';
do $$
declare b uuid;c uuid;p uuid;g uuid;a jsonb;r jsonb;expected jsonb;pay uuid;
begin
 select id into strict p from tour_projects where slug='8-lakes-tours';
 insert into customers(first_name,last_name,email) values('Review','Fixture','review-blockers@example.invalid') returning id into c;
 insert into bookings(customer_id,project_id,public_reference,tour_date,status,submission_key,guest_count,online_due_usd,online_paid_usd) values(c,p,'REVIEW-BLOCKERS','Scheduled fixture','awaiting_payment',gen_random_uuid(),3,2922,0) returning id into b;
 select jsonb_build_object('customer_id',customer_id,'tour_date',tour_date,'guest_count',guest_count,'online_due_usd',online_due_usd) into expected from bookings where id=b;
 insert into booking_checkout_ownership(booking_id,spec,expected,session_id,invalidated) values(b,jsonb_build_object('line_items',jsonb_build_array(jsonb_build_object('price_data',jsonb_build_object('unit_amount',292200)))),expected,'cs_review',false) returning generation into g;
 insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values(b,'stripe','cs_review',2922,'pending') returning id into pay;
 update abandoned_checkout_recovery set eligible_at=now()-interval '1 minute' where booking_id=b;
 update booking_checkout_ownership set invalidated=true where booking_id=b;
 a:=claim_abandoned_checkout(b,array['Scheduled fixture'],'{"to":"review-blockers@example.invalid","subject":"local only","text":"local only"}');
 if (a->>'should_send')::boolean then raise exception 'REPRO: invalidated pending Session authorized reminder'; end if;
 update booking_checkout_ownership set invalidated=false where booking_id=b;
 a:=claim_abandoned_checkout(b,array['Scheduled fixture'],'{"to":"review-blockers@example.invalid","subject":"local only","text":"local only"}');
 if not (a->>'should_send')::boolean then raise exception 'valid generation not claimed'; end if;
 if authorize_abandoned_checkout(b,(a->>'claim_token')::uuid,array['Scheduled fixture']) then raise exception 'v1 authorizes without provider evidence'; end if;
 if authorize_abandoned_checkout_v2(b,(a->>'claim_token')::uuid,array['Scheduled fixture'],g,array[]::text[]) then raise exception 'empty provider evidence authorized'; end if;
 if not authorize_abandoned_checkout_v2(b,(a->>'claim_token')::uuid,array['Scheduled fixture'],g,array['cs_review']) then raise exception 'verified expiry denied'; end if;
 update bookings set online_due_usd=4000 where id=b;
 update payments set status='paid' where id=pay;
 r:=confirm_paid_booking_v2(b,'cs_review',expected,'test-token',now());
 if (r->>'allowed')::boolean or (select status::text from bookings where id=b)<>'awaiting_payment' then raise exception 'REPRO: old 2922 Session confirmed edited 4000 booking'; end if;
 if (select amount_usd from payments where id=pay)<>2922 or (select online_paid_usd from bookings where id=b)<>2922 then raise exception 'actual money lost'; end if;
 -- Even a current snapshot plus a reviewed ownership record cannot waive funding.
 update booking_checkout_ownership o set terms_invalidated=false,expected=o.expected||'{"online_due_usd":4000}' where booking_id=b;
 r:=confirm_paid_booking_v2(b,'cs_review',expected||'{"online_due_usd":4000}','test-token',now());
 if (r->>'allowed')::boolean then raise exception 'insufficient reconciled balance confirmed'; end if;
 update booking_checkout_ownership o set terms_invalidated=true,expected=o.expected||'{"online_due_usd":2922}' where booking_id=b;
 -- Edit and revert must remain fenced, even once fully funded.
 update bookings set online_due_usd=2922 where id=b;
 r:=confirm_paid_booking_v2(b,'cs_review',expected,'test-token',now());
 if (r->>'allowed')::boolean then raise exception 'reverted terms escaped invalidation'; end if;
 -- Independent fresh generation permits confirmation; lease fences direct writers.
 update booking_checkout_ownership set terms_invalidated=false where booking_id=b;
 r:=confirm_paid_booking_v2(b,'cs_review',expected,'test-token',now());
 if not (r->>'allowed')::boolean then raise exception 'adequate unchanged terms denied: %',r; end if;
 begin
  update bookings set online_due_usd=4000 where id=b;
  raise exception 'lease did not fence edit';
 exception when lock_not_available then null;
 end;
 begin
  update bookings set guest_count=4 where id=b;
  raise exception 'lease did not fence manifest edit';
 exception when lock_not_available then null;
 end;
 if (select online_due_usd from bookings where id=b)<>2922 then raise exception 'failed edit did not roll back'; end if;
end $$;
rollback;
