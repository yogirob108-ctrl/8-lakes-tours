import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('conversion requires confirmed booking and settled online amount, never pending checkout', () => {
 const sql=readFileSync(new URL('../supabase/migrations/20260913154000_inquiry_conversion_evidence.sql',import.meta.url),'utf8');
 for (const text of ["v_booking.status not in ('confirmed','prep_sent','ready_for_departure','completed')", 'v_booking.online_paid_usd < v_booking.online_due_usd', 'v_booking.customer_id<>v_inquiry.customer_id', 'p_project_id']) assert.ok(sql.includes(text),text);
});
