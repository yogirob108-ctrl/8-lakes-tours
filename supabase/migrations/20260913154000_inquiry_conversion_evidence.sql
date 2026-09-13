begin;
-- Tighten the existing manually referenced conversion. Identity alone is not payment evidence.
create or replace function public.convert_inquiry(
 p_project_id uuid,p_gmail_account_email text,p_inquiry_id uuid,p_booking_id uuid,p_expected_status public.inquiry_status
)
returns table(inquiry_id uuid,booking_id uuid,status text,converted_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare v_inquiry public.inquiries%rowtype; v_booking public.bookings%rowtype;
begin
 select i.* into v_inquiry from public.inquiries i where i.id=p_inquiry_id and i.project_id=p_project_id
 and i.gmail_account_email=lower(btrim(p_gmail_account_email)) and i.status=p_expected_status for update;
 if not found or v_inquiry.status not in ('contacted','replied','qualified') then return; end if;
 select b.* into v_booking from public.bookings b where b.id=p_booking_id and b.project_id=p_project_id for update;
 if not found or v_inquiry.customer_id is null or v_booking.customer_id<>v_inquiry.customer_id then return; end if;
 if v_booking.status not in ('confirmed','prep_sent','ready_for_departure','completed')
 or v_booking.online_due_usd<=0 or v_booking.online_paid_usd < v_booking.online_due_usd then return; end if;
 return query update public.inquiries i set status='converted',converted_booking_id=v_booking.id,converted_at=clock_timestamp(),
 next_follow_up_at=null,updated_at=clock_timestamp() where i.id=v_inquiry.id and i.status=p_expected_status
 returning i.id,i.converted_booking_id,i.status::text,i.converted_at;
end;
$$;
revoke all on function public.convert_inquiry(uuid,text,uuid,uuid,public.inquiry_status) from public,anon,authenticated;
grant execute on function public.convert_inquiry(uuid,text,uuid,uuid,public.inquiry_status) to service_role;
commit;
