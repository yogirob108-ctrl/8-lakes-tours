-- Delayed recovery for incomplete, pre-submit drafts. These rows are not bookings.
alter table public.public_checkout_drafts
 add column if not exists recovery_token_hash text check (recovery_token_hash is null or recovery_token_hash ~ '^[0-9a-f]{64}$'),
 add column if not exists recovery_claim_token uuid,
 add column if not exists recovery_claimed_at timestamptz,
 add column if not exists recovery_sent_at timestamptz,
 add column if not exists recovery_provider_message_id text,
 add column if not exists recovery_raw_response jsonb;

create or replace function public.list_abandoned_public_checkout_drafts()
returns table(draft_id uuid,email text,first_name text)
language sql security definer set search_path='' as $$
 select d.id,d.payload->>'email',d.payload->>'first_name'
 from public.public_checkout_drafts d
 where d.updated_at <= clock_timestamp()-interval '1 hour'
   and d.expires_at > clock_timestamp()
   and d.recovery_sent_at is null
   and (d.recovery_claimed_at is null or d.recovery_claimed_at < clock_timestamp()-interval '15 minutes')
   and coalesce(d.payload->>'email','') ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
   and length(coalesce(d.payload->>'first_name','')) between 1 and 100
 order by d.updated_at asc
 limit 50
$$;

create or replace function public.claim_abandoned_public_checkout_draft(p_draft_id uuid,p_recovery_token_hash text,p_claim_token uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare claimed uuid;
begin
 perform public.checkout_service_role();
 if p_draft_id is null or p_claim_token is null or p_recovery_token_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_payload)<>'object' then raise exception 'invalid draft recovery claim'; end if;
 update public.public_checkout_drafts d
 set recovery_token_hash=p_recovery_token_hash,recovery_claim_token=p_claim_token,recovery_claimed_at=clock_timestamp()
 where d.id=p_draft_id and d.updated_at <= clock_timestamp()-interval '1 hour' and d.expires_at>clock_timestamp()
  and d.recovery_sent_at is null and (d.recovery_claimed_at is null or d.recovery_claimed_at<clock_timestamp()-interval '15 minutes')
 returning d.id into claimed;
 return jsonb_build_object('should_send',claimed is not null);
end $$;

create or replace function public.finalize_abandoned_public_checkout_draft(p_draft_id uuid,p_claim_token uuid,p_sent boolean,p_provider_message_id text,p_raw_response jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.checkout_service_role();
 update public.public_checkout_drafts
 set recovery_sent_at=case when p_sent then clock_timestamp() else null end,
     recovery_provider_message_id=case when p_sent then p_provider_message_id else null end,
     recovery_raw_response=coalesce(p_raw_response,'{}'::jsonb),
     recovery_claim_token=null,recovery_claimed_at=null
 where id=p_draft_id and recovery_claim_token=p_claim_token;
 if not found then raise exception 'draft recovery claim lost'; end if;
end $$;

create or replace function public.read_public_checkout_draft_by_recovery_token(p_recovery_token_hash text)
returns table(draft_id uuid,payload jsonb) language sql security definer set search_path='' as $$
 select d.id,d.payload from public.public_checkout_drafts d
 where d.recovery_token_hash=p_recovery_token_hash and d.recovery_sent_at is not null and d.expires_at>clock_timestamp()
$$;

revoke all on function public.list_abandoned_public_checkout_drafts() from public,anon,authenticated;
revoke all on function public.claim_abandoned_public_checkout_draft(uuid,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.finalize_abandoned_public_checkout_draft(uuid,uuid,boolean,text,jsonb) from public,anon,authenticated;
revoke all on function public.read_public_checkout_draft_by_recovery_token(text) from public,anon,authenticated;
grant execute on function public.list_abandoned_public_checkout_drafts() to service_role;
grant execute on function public.claim_abandoned_public_checkout_draft(uuid,text,uuid,jsonb) to service_role;
grant execute on function public.finalize_abandoned_public_checkout_draft(uuid,uuid,boolean,text,jsonb) to service_role;
grant execute on function public.read_public_checkout_draft_by_recovery_token(text) to service_role;
