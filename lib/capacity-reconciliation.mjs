const PAGE_SIZE = 50;

function exactBinding(row, session, id) {
 return session?.id === id
  && session.client_reference_id === row.public_reference
  && session.metadata?.booking_id === row.booking_id
  && session.metadata?.customer_id === row.customer_id
  && session.currency === 'usd';
}

function fullyRefunded(session) {
 const charge = session?.payment_intent?.latest_charge;
 return session?.status === 'complete'
  && session.payment_status === 'paid'
  && Number.isFinite(charge?.amount)
  && charge.amount > 0
  && charge.amount_refunded >= charge.amount;
}

export async function runCapacityReconciliation({db,retrieveSession,dryRun=false,now=()=>new Date(),pageSize=PAGE_SIZE}) {
 if (!db?.rpc || !retrieveSession) throw new Error('Capacity reconciliation evidence unavailable');
 const limit = Math.max(1,Math.min(PAGE_SIZE,Number.isInteger(pageSize) ? pageSize : PAGE_SIZE));
 const snapshot = now().toISOString();
 let afterAllocatedAt = null, afterBookingId = null;
 const totals={scanned:0,released_expired:0,released_cancelled_refunded:0,retained:0,provider_errors:0};
 while (true) {
  const {data:rows,error}=await db.rpc('list_departure_capacity_reconciliation_candidates',{
   p_after_allocated_at:afterAllocatedAt,p_after_booking_id:afterBookingId,p_before_allocated_at:snapshot,p_limit:limit,
  });
  if(error || !Array.isArray(rows)) throw new Error('Capacity reconciliation queue unavailable');
  if(rows.length===0) break;
  for(const row of rows) {
   totals.scanned++;
   const ids=Array.isArray(row.payment_session_ids) ? row.payment_session_ids.filter(id=>typeof id==='string' && id) : [];
   try {
    if(row.state==='payment') {
     if(ids.length!==1 || ids[0]!==row.checkout_session_id) { totals.retained++; continue; }
     const provider=await retrieveSession(row.checkout_session_id);
     if(!exactBinding(row,provider,row.checkout_session_id) || provider.status!=='expired' || provider.payment_status!=='unpaid') { totals.retained++; continue; }
     totals.released_expired++;
     if(!dryRun) {
      const {error:releaseError}=await db.rpc('release_departure_capacity_if_safe',{p_booking_id:row.booking_id,p_session_id:row.checkout_session_id,p_provider_terminal:'expired'});
      if(releaseError) throw new Error('Capacity release unavailable');
     }
    } else if(row.state==='confirmed' && row.booking_status==='cancelled') {
     if(ids.length===0) { totals.retained++; continue; }
     const sessions=await Promise.all(ids.map(id=>retrieveSession(id)));
     if(!sessions.every((provider,index)=>exactBinding(row,provider,ids[index]) && fullyRefunded(provider))) { totals.retained++; continue; }
     totals.released_cancelled_refunded++;
     if(!dryRun) {
      const {error:releaseError}=await db.rpc('release_confirmed_departure_capacity_on_cancel',{p_booking_id:row.booking_id,p_provider_terminal:'cancelled_refunded'});
      if(releaseError) throw new Error('Capacity release unavailable');
     }
    } else totals.retained++;
   } catch { totals.provider_errors++; totals.retained++; }
  }
  const last=rows.at(-1);
  if(!last?.allocated_at || !last?.booking_id) throw new Error('Capacity reconciliation pagination unavailable');
  afterAllocatedAt=last.allocated_at;
  afterBookingId=last.booking_id;
 }
 return totals;
}
