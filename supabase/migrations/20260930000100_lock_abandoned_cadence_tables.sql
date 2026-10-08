BEGIN;
ALTER TABLE public.abandoned_cadence_activation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.abandoned_cadence_booking_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.abandoned_cadence_rollout ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.abandoned_cadence_stage2_cohort ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.abandoned_cadence_activation_log, public.abandoned_cadence_booking_activation, public.abandoned_cadence_rollout, public.abandoned_cadence_stage2_cohort FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.abandoned_cadence_activation_log, public.abandoned_cadence_booking_activation, public.abandoned_cadence_rollout, public.abandoned_cadence_stage2_cohort TO service_role;
COMMIT;
