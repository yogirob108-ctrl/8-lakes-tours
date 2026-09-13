"""Disposable local fixtures, competing PostgreSQL connections and observed locks."""
import json
import subprocess
import time
import uuid
from typing import Literal, overload
DSN='postgresql://localhost:55432/8l_test'
PREFIX="set request.jwt.claim.role='service_role'; "
@overload
def sql(q: str, ok: Literal[True] = True) -> str: ...
@overload
def sql(q: str, ok: Literal[False]) -> subprocess.CompletedProcess[str]: ...
def sql(q,ok=True):
 r=subprocess.run(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',PREFIX+q],text=True,capture_output=True)
 if ok: assert r.returncode==0,r.stderr
 return r.stdout.strip().splitlines()[-1] if ok and r.stdout.strip() else r

def writer(q,marker):
 p=subprocess.Popen(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',PREFIX+q+' -- '+marker],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 for _ in range(100):
  if sql(f"select count(*) from pg_stat_activity where wait_event='PgSleep' and query like '%{marker}%' ")!='0': return p
  if p.poll() is not None: raise AssertionError(p.communicate())
  time.sleep(.02)
 raise AssertionError('writer lock not observed')

for scenario in ['delete-first','confirmation-first','double-delete','refund-first','delete-rollback']:
 marker='delete-race-'+str(uuid.uuid4());b=None;w=None
 c=sql(f"insert into customers(first_name,last_name,email) values('Delete','Race','{marker}@example.invalid') returning id")
 try:
  p=sql("select id from tour_projects where slug='8-lakes-tours'")
  b=sql(f"insert into bookings(customer_id,project_id,public_reference,tour_date,status,guest_count,online_due_usd) values('{c}','{p}','{marker}','Scheduled','awaiting_payment',3,2922) returning id")
  expected=json.dumps({'customer_id':c,'tour_date':'Scheduled','guest_count':3,'online_due_usd':2922})
  sql(f"insert into booking_checkout_ownership(booking_id,expected,spec,session_id) values('{b}','{expected}','{{\"line_items\":[{{\"price_data\":{{\"unit_amount\":292200}}}}]}}','{marker}')")
  pay=sql(f"insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values('{b}','stripe','{marker}',2922,'paid') returning id")
  confirm=f"select confirm_paid_booking_v2('{b}','{marker}','{expected}','{marker}',now())"
  delete=f"select delete_ops_booking_record('{p}','{b}','{marker}')"
  if scenario in ['delete-first','double-delete','delete-rollback']:
   w=writer(f"begin;{delete};select pg_sleep(1);{'rollback' if scenario=='delete-rollback' else 'commit'};",marker)
   if scenario=='double-delete':
    r=sql(delete,False);assert r.returncode!=0 and 'deletion conflict' in r.stderr,r
   else:
    result=json.loads(sql(confirm));assert result['allowed'] is (scenario=='delete-rollback'),result
   assert sql(f"select count(*) from bookings where id='{b}'")==('1' if scenario=='delete-rollback' else '0')
  elif scenario=='confirmation-first':
   w=writer(f"begin;{confirm};select pg_sleep(1);commit;",marker)
   assert json.loads(sql(delete))=={'blocked':'confirmation_in_progress'}
   assert sql(f"select count(*) from payments where id='{pay}'")=='1'
  else:
   w=writer(f"begin;update payments set status='refunded',raw_event='{{\"cumulative_refunded_usd\":2922}}' where id='{pay}';select pg_sleep(1);commit;",marker)
   assert json.loads(sql(delete))=={'deleted_booking_id':b}
   assert sql(f"select count(*) from bookings where id='{b}'")=='0'
  _,error=w.communicate();assert w.returncode==0,error
  print('PASS:',scenario,'serialized on canonical booking lock')
 finally:
  if w and w.poll() is None:w.communicate()
  if b:sql(f"delete from bookings where id='{b}'")
  sql(f"delete from customers where id='{c}'")
  assert sql(f"select count(*) from bookings where public_reference='{marker}'")=='0'
