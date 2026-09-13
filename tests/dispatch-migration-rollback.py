"""Prove additive DDL rollback on a disposable local clone, never production."""
from pathlib import Path
import subprocess
import uuid
name='checkout_rollback_'+uuid.uuid4().hex[:12]
root=Path(__file__).resolve().parents[1]
def run(args,**kw):
 r=subprocess.run(args,text=True,capture_output=True,**kw)
 assert r.returncode==0,r.stderr
 return r.stdout
run(['createdb','-h','localhost','-p','55432','-T','8l_test',name])
try:
 def sql(s):return run(['psql',f'postgresql://localhost:55432/{name}','-XqAt','-v','ON_ERROR_STOP=1'],input=s)
 # Remove only v3 on the private clone, then prove transactional rollback.
 sql("drop trigger payment_issuance_refund_v3 on payments; drop function payment_issuance_and_refund_fence_v3(),authorize_payment_dispatch_v3(uuid,text,text,text); drop table payment_confirmation_dispatch;")
 snapshot="select pg_get_functiondef(oid) from pg_proc where proname in ('fence_booking_checkout','confirm_paid_booking_v2','reconcile_paid_booking_v2') order by proname; select coalesce(jsonb_agg(p order by id),'[]') from payments p;"
 before=sql(snapshot)
 migration=(root/'supabase/migrations/20260913010000_payment_dispatch_and_issuance.sql').read_text()
 sql('begin;\n'+migration+'\nrollback;')
 assert sql(snapshot)==before,'DDL rollback changed predecessor contract or ledger'
 assert sql("select to_regclass('public.payment_confirmation_dispatch') is null").strip()=='t'
 sql('begin;\n'+migration+'\ncommit;')
 assert sql("select count(*) from pg_proc where proname='authorize_payment_dispatch_v3'").strip()=='1'
 assert sql(snapshot)==before,'migration rewrote historical function definitions or ledger unexpectedly'
 print('PASS: additive dispatch migration rollback and commit on disposable clone; predecessor functions unchanged')

finally:
 run(['dropdb','-h','localhost','-p','55432',name])
