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
 # Reconstruct only this migration's predecessor on the private clone.
 sql('''drop trigger checkout_terms_fence_v2 on bookings;
 drop function fence_checkout_terms_v2(), read_abandoned_checkout_evidence(uuid,text[]), authorize_abandoned_checkout_v2(uuid,uuid,text[],uuid,text[]), reconcile_paid_booking_v2(uuid), confirm_paid_booking_v2(uuid,text,jsonb,text,timestamptz);
 alter table booking_checkout_ownership drop column terms_invalidated;''')
 old=(root/'supabase/migrations/20260910050000_abandoned_checkout_recovery.sql').read_text()
 for fn in ['abandoned_checkout_eligible','authorize_abandoned_checkout']:
  start=old.index('create function public.'+fn+'(')
  end=old.index('$$;',start)+3
  sql(old[start:end].replace('create function','create or replace function',1))
 snapshot="select pg_get_functiondef(oid) from pg_proc where proname in ('abandoned_checkout_eligible','authorize_abandoned_checkout') order by proname; select count(*) from information_schema.columns where table_name='booking_checkout_ownership' and column_name='terms_invalidated';"
 before=sql(snapshot)
 migration=(root/'supabase/migrations/20260913000000_checkout_review_fences.sql').read_text()
 sql('begin;\n'+migration+'\nrollback;')
 assert sql(snapshot)==before,'DDL rollback changed predecessor contract'
 assert sql("select count(*) from pg_proc where proname='confirm_paid_booking_v2'").strip()=='0'
 sql('begin;\n'+migration+'\ncommit;')
 assert sql("select count(*) from pg_proc where proname='confirm_paid_booking_v2'").strip()=='1'
 print('PASS: full additive migration rollback preserves predecessor functions/columns; commit creates v2 contract')
finally:
 run(['dropdb','-h','localhost','-p','55432',name])
