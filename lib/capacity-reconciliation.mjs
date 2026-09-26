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

function expiredUnpaid(session) {
 return session?.status === 'expired' && session.payment_status === 'unpaid';
}

function exactSessionIds(row) {
 const ids = Array.isArray(row.payment_session_ids) ? row.payment_session_ids : [];
 if (!ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return null;
 return [...ids].sort();
}

async function loadExactSessions(row, ids, retrieveSession) {
 const sessions = await Promise.all(ids.map(id => retrieveSession(id)));
 return sessions.every((provider, index) => exactBinding(row, provider, ids[index])) ? sessions : null;
}

async function release(db, name, args) {
 const {data, error} = await db.rpc(name, args);
 if (error) throw new Error('Capacity release unavailable');
 return data === true;
}

export async function runCapacityReconciliation({db,retrieveSession,dryRun=false,now=()=>new Date(),pageSize=PAGE_SIZE}) {
 if (!db?.rpc || !retrieveSession) throw new Error('Capacity reconciliation evidence unavailable');
 const limit = Math.max(1,Math.min(PAGE_SIZE,Number.isInteger(pageSize) ? pageSize : PAGE_SIZE));
 const snapshot = now().toISOString();
 let afterAllocatedAt = null, afterBookingId = null;
 const totals={scanned:0,would_release_expired:0,would_release_cancelled_refunded:0,released_expired:0,released_cancelled_refunded:0,retained:0,provider_errors:0};
 while (true) {
  const {data:rows,error}=await db.rpc('list_departure_capacity_reconciliation_candidates',{
   p_after_allocated_at:afterAllocatedAt,p_after_booking_id:afterBookingId,p_before_allocated_at:snapshot,p_limit:limit,
  });
  if(error || !Array.isArray(rows)) throw new Error('Capacity reconciliation queue unavailable');
  if(rows.length===0) break;
  for(const row of rows) {
   totals.scanned++;
   try {
    const ids=exactSessionIds(row);
    if(row.state==='payment') {
     if(!ids || !ids.includes(row.checkout_session_id)) { totals.retained++; continue; }
     const sessions=await loadExactSessions(row,ids,retrieveSession);
     if(!sessions || !sessions.every(expiredUnpaid)) { totals.retained++; continue; }
     totals.would_release_expired++;
     if(dryRun) continue;
     if(await release(db,'release_departure_capacity_if_all_expired_safe',{p_booking_id:row.booking_id,p_expired_session_ids:ids,p_provider_terminal:'expired'})) totals.released_expired++;
     else totals.retained++;
    } else if(row.state==='confirmed' && row.booking_status==='cancelled') {
     if(!ids) { totals.retained++; continue; }
     const sessions=await loadExactSessions(row,ids,retrieveSession);
     if(!sessions) { totals.retained++; continue; }
     const expiredIds=[], refundedIds=[];
     for(let index=0;index<sessions.length;index++) {
      if(expiredUnpaid(sessions[index])) expiredIds.push(ids[index]);
      else if(fullyRefunded(sessions[index])) refundedIds.push(ids[index]);
      else { expiredIds.length=0; refundedIds.length=0; break; }
     }
     if(expiredIds.length+refundedIds.length!==ids.length) { totals.retained++; continue; }
     totals.would_release_cancelled_refunded++;
     if(dryRun) continue;
     if(await release(db,'release_confirmed_departure_capacity_on_cancel_if_safe',{p_booking_id:row.booking_id,p_expired_session_ids:expiredIds,p_refunded_session_ids:refundedIds,p_provider_terminal:'cancelled_refunded'})) totals.released_cancelled_refunded++;
     else totals.retained++;
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
