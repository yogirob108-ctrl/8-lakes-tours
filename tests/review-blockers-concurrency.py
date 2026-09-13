"""Local PostgreSQL only: real competing connections, no provider calls."""
import concurrent.futures
import json
import subprocess
import time
import uuid
DSN='postgresql://localhost:55432/8l_test'
PREFIX="set request.jwt.claim.role='service_role'; "
def sql(q,ok=True):
 r=subprocess.run(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',PREFIX+q],text=True,capture_output=True)
 if ok: assert r.returncode==0,r.stderr
 return r.stdout.strip().splitlines()[-1] if ok and r.stdout.strip() else r

def writer(q):
 p=subprocess.Popen(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',PREFIX+q],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 for _ in range(100):
  if sql(f"select count(*) from pg_stat_activity where pid<>{sql('select pg_backend_pid()')} and wait_event='PgSleep' and query like '%{marker}%' ")!='0': return p
  if p.poll() is not None: raise AssertionError(p.communicate())
  time.sleep(.02)
 raise AssertionError('writer lock not observed')

for scenario in ['edit-first','confirmation-first','refund-first']:
 marker='review-race-'+str(uuid.uuid4())
 c=sql(f"insert into customers(first_name,last_name,email) values('Review','Race','{marker}@example.invalid') returning id")
 b=None
 try:
  p=sql("select id from tour_projects where slug='8-lakes-tours'")
  b=sql(f"insert into bookings(customer_id,project_id,public_reference,tour_date,status,guest_count,online_due_usd,online_paid_usd) values('{c}','{p}','{marker}','Scheduled','awaiting_payment',3,2922,0) returning id")
  expected=json.dumps({'customer_id':c,'tour_date':'Scheduled','guest_count':3,'online_due_usd':2922})
  sql(f"insert into booking_checkout_ownership(booking_id,expected,spec,session_id) values('{b}','{expected}','{{\"line_items\":[{{\"price_data\":{{\"unit_amount\":292200}}}}]}}','{marker}')")
  pay=sql(f"insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values('{b}','stripe','{marker}',2922,'paid') returning id")
  confirm=f"select confirm_paid_booking_v2('{b}','{marker}','{expected}','{marker}',now())"
  if scenario=='edit-first':
   w=writer(f"begin;update bookings set online_due_usd=4000 where id='{b}';select pg_sleep(1);commit; -- {marker}")
   assert json.loads(sql(confirm))['allowed'] is False
   assert sql(f"select status from bookings where id='{b}'")=='awaiting_payment'
  elif scenario=='confirmation-first':
   w=writer(f"begin;{confirm};select pg_sleep(1);commit; -- {marker}")
   r=sql(f"begin;update bookings set online_due_usd=4000 where id='{b}';commit;",False)
   assert r.returncode!=0 and 'Payment confirmation in progress' in r.stderr,r
   assert float(sql(f"select online_due_usd from bookings where id='{b}'"))==2922
  else:
   w=writer(f"begin;update payments set status='partially_refunded',raw_event='{{\"cumulative_refunded_usd\":100}}' where id='{pay}';select pg_sleep(1);commit; -- {marker}")
   assert json.loads(sql(confirm))['allowed'] is False
   assert float(sql(f"select online_paid_usd from bookings where id='{b}'"))==2822
  _,error=w.communicate();assert w.returncode==0,error
  print('PASS:',scenario,'serialized on canonical booking lock')
 finally:
  if b:sql(f"delete from bookings where id='{b}'")
  sql(f"delete from customers where id='{c}'")
  assert sql(f"select count(*) from bookings where public_reference='{marker}'")=='0'
