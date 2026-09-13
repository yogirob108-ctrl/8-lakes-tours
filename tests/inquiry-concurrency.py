"""Local-only concurrency probes. DATABASE must be a disposable localhost database."""
import concurrent.futures
import json
import os
import subprocess

DB = os.environ['INQUIRY_TEST_DATABASE']
assert DB.startswith('inquiry_blockers_'), 'Use a disposable blocker-test database'

def sql(text):
    return subprocess.check_output(['psql','-X','-h','localhost','-p','55432','-d',DB,'-v','ON_ERROR_STOP=1','-At','-c',text], text=True).strip()

sql("""do $$ declare p uuid; l uuid:=gen_random_uuid(); begin
select id into strict p from public.tour_projects where slug='8-lakes-tours';
perform * from public.claim_inquiry_sync('gmail',p,'8lakestours@gmail.com',l);
perform * from public.reconcile_inbound_inquiry_message(p,'8lakestours@gmail.com',l,'concurrency','concurrency-message','Local','concurrency@example.invalid',array['8lakestours@gmail.com'],'{}','Concurrent','Question','{"message_id":"<concurrency@test.invalid>"}','2026-09-13T12:00:00Z','import','price','concurrency','concurrency-message');
end $$;""")
p,i=sql("select project_id||','||id from public.inquiries where gmail_thread_id='concurrency'").split(',')
def generate(key):
    return sql(f"select id from public.create_grounded_inquiry_draft('{p}','8lakestours@gmail.com','{i}',(select status from public.inquiries where id='{i}'),'Re: concurrent','Original','concurrency@example.invalid','test','<concurrency@test.invalid>',array['<concurrency@test.invalid>'],'{key}','[]','{{}}')")
with concurrent.futures.ThreadPoolExecutor(2) as pool:
    ids=list(pool.map(generate,['concurrent-one','concurrent-two']))
assert ids[0] and ids[0]==ids[1], f'Concurrent generation created different source drafts: {ids}'
d=ids[0]
v=sql(f"select version from public.inquiry_drafts where id='{d}'")
def save(body):
    return sql(f"select count(*) from public.save_inquiry_draft('{p}','8lakestours@gmail.com','{i}','{d}',{v},'Re: concurrent','{body}','concurrency@example.invalid',1)")
with concurrent.futures.ThreadPoolExecutor(2) as pool:
    results=list(pool.map(save,['Operator A','Operator B']))
assert sorted(results)==['0','1'], f'Concurrent content CAS winners: {results}'
assert sql(f"select content_revision from public.inquiry_drafts where id='{d}'")=='2'
assert sql(f"select count(*) from public.submit_inquiry_draft_for_review('{p}','8lakestours@gmail.com','{i}','{d}',{v},1)")=='0'
assert sql(f"select count(*) from public.submit_inquiry_draft_for_review('{p}','8lakestours@gmail.com','{i}','{d}',{v},2)")=='1'
def approve(_):
    return sql(f"select count(*) from public.approve_inquiry_draft('{p}','8lakestours@gmail.com','{i}','{d}',{v},'reviewer',2)")
with concurrent.futures.ThreadPoolExecutor(2) as pool:
    approvals=list(pool.map(approve,range(2)))
assert sorted(approvals)==['0','1'], approvals
sql(f"select public.release_inquiry_sync_failure(provider,project_id,gmail_account_email,lease_token) from public.inquiry_sync_state where project_id='{p}' and gmail_account_email='8lakestours@gmail.com' and lease_token is not null")
print(json.dumps({'generation':'one immutable source draft','save_winners':results,'approval_winners':approvals,'revision':2}))
