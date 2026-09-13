"""Additive deletion migration rollback + catalog equality, private local clone."""
from pathlib import Path
import subprocess
import uuid
name='delete_rollback_'+uuid.uuid4().hex[:12]
root=Path(__file__).resolve().parents[1]
def run(args,**kw):
 r=subprocess.run(args,text=True,capture_output=True,**kw)
 assert r.returncode==0,r.stderr
 return r.stdout
run(['createdb','-h','localhost','-p','55432','-T','8l_test',name])
try:
 def sql(s):return run(['psql',f'postgresql://localhost:55432/{name}','-XqAt','-v','ON_ERROR_STOP=1'],input=s)
 sql('drop function public.delete_ops_booking_record(uuid,uuid,text)')
 snapshot="select pg_get_functiondef(oid) from pg_proc where proname in ('payment_issuance_and_refund_fence_v3','authorize_payment_dispatch_v3','confirm_paid_booking_v2') order by proname;select coalesce(jsonb_agg(p order by id),'[]') from payments p;select coalesce(jsonb_agg(b order by id),'[]') from bookings b;"
 before=sql(snapshot)
 migration=(root/'supabase/migrations/20260913020000_atomic_ops_booking_delete.sql').read_text()
 sql('begin;'+migration+'rollback;')
 assert sql(snapshot)==before
 assert sql("select to_regprocedure('public.delete_ops_booking_record(uuid,uuid,text)') is null").strip()=='t'
 sql('begin;'+migration+'commit;')
 assert sql(snapshot)==before
 body=sql("select prosrc from pg_proc where oid='public.delete_ops_booking_record(uuid,uuid,text)'::regprocedure").strip()
 assert body==migration.split('as $$',1)[1].split('$$;',1)[0].strip()
 print('PASS: migration rollback, commit, exact catalog body; predecessor functions and ledger unchanged')
finally:
 run(['dropdb','-h','localhost','-p','55432',name])
