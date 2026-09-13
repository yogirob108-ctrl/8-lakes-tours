\set ON_ERROR_STOP on
begin;
set request.jwt.claim.role='service_role';
do $$
declare c uuid;b uuid;p uuid;a jsonb;r jsonb;first_token text;
begin
 select id into strict p from tour_projects where slug='8-lakes-tours';
 insert into customers(first_name,last_name,email) values('Email','Test','email-retry@example.invalid') returning id into c;
 insert into bookings(customer_id,project_id,public_reference,tour_date) values(c,p,'EMAIL-RETRY','TBC') returning id into b;
 a:=claim_public_booking_email_v2(b,c,'booking_received','{"to":"email-retry@example.invalid","subject":"original","text":"body","html":"body"}');
 if not (a->>'should_send')::boolean then raise exception 'first claim failed'; end if;
 first_token:=a->>'claim_token';
 r:=claim_public_booking_email_v2(b,c,'booking_received','{"subject":"changed"}');
 if (r->>'should_send')::boolean then raise exception 'concurrent email claimed twice'; end if;
 perform finalize_public_booking_email_v2((a->>'email_event_id')::uuid,first_token::uuid,false,null,'{}');
 r:=claim_public_booking_email_v2(b,c,'booking_received','{"subject":"changed"}');
 if not (r->>'should_send')::boolean or r#>>'{payload,subject}'<>'original' then raise exception 'retry payload not frozen'; end if;
 -- A worker finishing after lease takeover must not finalize the new owner.
 perform finalize_public_booking_email_v2((a->>'email_event_id')::uuid,first_token::uuid,true,'stale','{}');
 if (select status from public_booking_notifications where booking_id=b)<>'queued' then raise exception 'stale finalize changed claim'; end if;
 perform finalize_public_booking_email_v2((r->>'email_event_id')::uuid,(r->>'claim_token')::uuid,true,'accepted','{}');
 a:=claim_public_booking_email_v2(b,c,'booking_received','{}');
 if (a->>'should_send')::boolean then raise exception 'sent email retried'; end if;
 a:=claim_public_booking_email_v2(b,c,'internal_booking_notification','{"subject":"internal","to":"ops@example.invalid","text":"body"}');
 update public_booking_notifications set first_attempt_at=now()-interval '24 hours',lease_until=now()-interval '1 hour' where booking_id=b and template_key='internal_booking_notification';
 a:=claim_public_booking_email_v2(b,c,'internal_booking_notification','{}');
 if (a->>'should_send')::boolean then raise exception 'provider key expiry can duplicate email'; end if;
 if (select status from public_booking_notifications where booking_id=b and template_key='internal_booking_notification')<>'review' then raise exception 'ambiguous email not surfaced'; end if;
end $$;
rollback;
