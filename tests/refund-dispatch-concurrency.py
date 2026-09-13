import subprocess,json,time,uuid
DSN='postgresql://localhost:55432/8l_test'
def sql(q):
 r=subprocess.run(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',"set request.jwt.claim.role='service_role'; "+q],capture_output=True,text=True)
 assert r.returncode==0,r.stderr
 return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ''
marker='independent-refund-'+str(uuid.uuid4())
c=sql(f"insert into customers(first_name,last_name,email) values('Independent','Race','{marker}@example.invalid') returning id")
b=None
try:
 p=sql("select id from tour_projects where slug='8-lakes-tours'")
 b=sql(f"insert into bookings(customer_id,project_id,public_reference,tour_date,status,guest_count,online_due_usd,online_paid_usd) values('{c}','{p}','{marker}','Scheduled','awaiting_payment',3,2922,0) returning id")
 expected=json.dumps(dict(customer_id=c,tour_date='Scheduled',guest_count=3,online_due_usd=2922))
 sql(f"insert into booking_checkout_ownership(booking_id,expected,spec,session_id) values('{b}','{expected}','{{\"line_items\":[{{\"price_data\":{{\"unit_amount\":292200}}}}]}}','{marker}')")
 pay=sql(f"insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values('{b}','stripe','{marker}',2922,'paid') returning id")
 q=f"set request.jwt.claim.role='service_role'; begin; select confirm_paid_booking_v2('{b}','{marker}','{expected}','{marker}',now());select pg_sleep(2);commit; -- {marker}"
 owner=subprocess.Popen(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',q],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 for _ in range(100):
  if sql(f"select count(*) from pg_stat_activity where wait_event='PgSleep' and query like '%{marker}%' and pid<>pg_backend_pid()")!='0':break
  time.sleep(.02)
 else:raise Exception('confirmation lock not observed')
 sql(f"update payments set status='refunded',raw_event='{{\"cumulative_refunded_usd\":2922}}' where id='{pay}'; select reconcile_paid_booking_v2('{b}');")
 stdout,stderr=owner.communicate();assert owner.returncode==0,stderr
 print('confirmation owner:',stdout.strip())
 result=json.loads(sql(f"select jsonb_build_object('status',status,'paid',online_paid_usd,'due',online_due_usd,'active_confirmation_lease',payment_confirmation_token is not null and payment_confirmation_claimed_at>now()-interval '5 minutes') from bookings where id='{b}'"))
 print('refund committed before send:',json.dumps(result))
 assert result=={'status':'confirmed','paid':0,'due':2922,'active_confirmation_lease':False}
finally:
 if b:sql(f"delete from bookings where id='{b}'")
 sql(f"delete from customers where id='{c}'")
 print('cleanup remaining:',sql(f"select count(*) from customers where email='{marker}@example.invalid'"))
