-- Durable lifecycle-email claims shared by automated and manual dispatch.
-- This migration only extends existing private operational tables; it creates no public RPC.
begin;

alter table public.bookings
  add column if not exists lifecycle_email_token text,
  add column if not exists lifecycle_email_claimed_at timestamptz,
  add column if not exists lifecycle_email_provider_attempted_at timestamptz;

alter table public.email_events
  add column if not exists is_canonical boolean not null default false,
  add column if not exists claim_token text,
  add column if not exists claimed_at timestamptz,
  add column if not exists provider_attempted_at timestamptz,
  add column if not exists provider_completed_at timestamptz;

comment on column public.bookings.lifecycle_email_token is
  'Short-lived exclusive lifecycle dispatch lease shared by scheduler, manual send, cancellation and delete.';
comment on column public.bookings.lifecycle_email_provider_attempted_at is
  'Set immediately before provider dispatch. A queued row with this value is ambiguous and requires reconciliation, not automatic resend.';
comment on column public.email_events.is_canonical is
  'Canonical outbox record for a lifecycle template. Historical audit rows remain non-canonical.';
comment on column public.email_events.provider_attempted_at is
  'Set immediately before a provider call. If completion is unknown, automated retry is fail-closed.';

create index if not exists bookings_lifecycle_email_claim_idx
  on public.bookings (lifecycle_email_claimed_at)
  where lifecycle_email_token is not null;

create unique index if not exists email_events_one_active_lifecycle_outbox
  on public.email_events (booking_id, template_key)
  where is_canonical and status in ('queued', 'sent', 'delivered');

-- Existing table grants and RLS remain authoritative. Explicitly preserve the intended private contract.
alter table public.bookings enable row level security;
alter table public.email_events enable row level security;
revoke all on table public.bookings from anon, authenticated;
revoke all on table public.email_events from anon, authenticated;

commit;
