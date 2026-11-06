#!/usr/bin/env python3
"""Real PostgreSQL race: public and legacy claims cannot both authorize a send."""
import json, os, subprocess, uuid
DSN=os.environ.get('OPS_TEST_DATABASE_URL','postgresql://localhost:55432/8l_test')
def run(sql):
 return subprocess.check_output(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',"set request.jwt.claim.role='service_role'; "+sql],text=True).strip()
project=str(uuid.uuid4()); customer=str(uuid.uuid4()); booking=str(uuid.uuid4())
run(f"insert into tour_projects(id,slug,name) values('{project}','post-trip-race-{project[:8]}','race'); insert into customers(id,first_name,last_name,email) values('{customer}','Race','Guest','race@example.invalid'); insert into bookings(id,customer_id,project_id,public_reference,tour_date,status,guest_count,online_due_usd) values('{booking}','{customer}','{project}','RACE-{booking[:8]}','1–3 September 2026','completed',1,999)")
legacy=f"select public.claim_post_trip_email_dispatch('legacy','{booking}','{customer}','post_trip_followup','race@example.invalid','feedback','body','ops','{uuid.uuid4()}')"
public=f"select public.claim_lifecycle_email_dispatch('{booking}','{customer}','post_trip_referral','race@example.invalid','referral','body','public','{uuid.uuid4()}')"
procs=[subprocess.Popen(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',"set request.jwt.claim.role='service_role'; "+q],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for q in (legacy,public)]
results=[]
for p in procs:
 out,err=p.communicate(timeout=20)
 if p.returncode: raise SystemExit(err)
 results.append(json.loads(out.strip()))
assert sum(bool(x.get('should_send')) for x in results)==1, results
assert any(x.get('reason')=='post_trip_sender_not_owner' for x in results),results
assert run(f"select count(*) from email_events where booking_id='{booking}' and template_key in ('post_trip_followup','post_trip_referral') and status='queued'")=='1'
print('post-trip cross-sender concurrency: PASS')
