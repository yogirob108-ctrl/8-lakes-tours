-- Ops deletion owns a transaction-scoped booking row lock, never the revocable
-- payment/email confirmation token. Deploy before the new Ops action; drain old
-- Ops deletion workers (the old multi-request action cannot be made atomic).
create function public.delete_ops_booking_record(p_project_id uuid,p_booking_id uuid,p_reference text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.bookings; deleted_id uuid; written integer;
begin
 perform public.checkout_service_role();
 select * into b from public.bookings
 where id=p_booking_id and project_id=p_project_id and public_reference=p_reference
 for update;
 if not found then raise exception 'Booking deletion conflict: scoped booking not found'; end if;
 -- Null lease timestamps are unknown, not evidence that an owner has expired.
 -- A revoked/expired token does not resolve an in-flight or ambiguous dispatch.
 if (b.payment_confirmation_token is not null and
     (b.payment_confirmation_claimed_at is null or b.payment_confirmation_claimed_at>=clock_timestamp()-interval '5 minutes'))
 or exists(select 1 from public.payment_confirmation_dispatch where booking_id=b.id and status='dispatching') then
  return jsonb_build_object('blocked','confirmation_in_progress');
 end if;
 -- This FK is SET NULL, unlike the other booking children. Keep the existing Ops
 -- deletion semantics, but inside the same transaction as the parent CAS.
 delete from public.email_events where booking_id=b.id;
 delete from public.bookings where id=b.id and project_id=p_project_id and public_reference=p_reference returning id into deleted_id;
 get diagnostics written=row_count;
 if written<>1 or deleted_id is distinct from b.id then
  raise exception 'Booking deletion conflict: expected one affected booking';
 end if;
 -- Cascades remove payments, travellers, tasks, timeline, checkout ownership,
 -- recovery, notification and dispatch rows. Any trigger/FK error rolls back all.
 return jsonb_build_object('deleted_booking_id',deleted_id);
end $$;
revoke all on function public.delete_ops_booking_record(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.delete_ops_booking_record(uuid,uuid,text) to service_role;
