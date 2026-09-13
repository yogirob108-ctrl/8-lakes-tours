"""Replay and rollback verification using only a newly created local database."""
from pathlib import Path
import json
import os
import subprocess
import sys

DB = sys.argv[1]
assert DB.startswith('inquiry_blockers_') and DB.replace('_','').isalnum()
ROOT = Path(__file__).resolve().parents[1]
PSQL = ['psql','-X','-h','localhost','-p','55432','-d',DB,'-v','ON_ERROR_STOP=1']

def run(text):
    return subprocess.check_output(PSQL + ['-At'],input=text,text=True)

subprocess.run(['createdb','-h','localhost','-p','55432',DB],check=True)
migrations = sorted((ROOT/'supabase/migrations').glob('*.sql'))
assert migrations[-1].name == '20260913221000_inquiry_review_contract.sql'
for migration in migrations[:-1]:
    run(migration.read_text())
correction = migrations[-1].read_text()
assert correction.strip().startswith('begin;') and correction.strip().endswith('commit;')
# Prove additive DDL and replacement RPCs roll back together; then apply the exact file.
run(correction.strip()[:-len('commit;')] + 'rollback;')
assert run("select count(*) from information_schema.columns where table_schema='public' and table_name='inquiry_drafts' and column_name='content_revision'").strip() == '0'
run(correction)
counts = "select jsonb_object_agg(t,n) from (select 'inquiries' t,count(*) n from public.inquiries union all select 'messages',count(*) from public.inquiry_messages union all select 'drafts',count(*) from public.inquiry_drafts union all select 'customers',count(*) from public.customers union all select 'bookings',count(*) from public.bookings union all select 'dispositions',count(*) from public.inquiry_draft_dispositions union all select 'sources',count(*) from public.inquiry_draft_sources) x"
before=run(counts).strip()
suites=sorted((ROOT/'tests').glob('inquiry-*.sql'))
for suite in suites:
    subprocess.run(PSQL + ['-f',str(suite)],check=True)
    assert run(counts).strip()==before, f'Fixture leakage: {suite.name}'
subprocess.run([sys.executable,str(ROOT/'tests/inquiry-concurrency.py')],env={**os.environ,'INQUIRY_TEST_DATABASE':DB},check=True)
print(json.dumps({'database':DB,'migrations':len(migrations),'ddl_rollback':'verified','sql_suites':len(suites),'fixture_rollback':'verified after every suite','concurrency':'passed'}))
