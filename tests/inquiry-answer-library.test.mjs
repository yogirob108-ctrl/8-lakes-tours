import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const path = new URL('../supabase/migrations/20260913153000_inquiry_answer_library.sql', import.meta.url);
test('additive answer library has scoped approval and immutable draft provenance', () => {
 assert.ok(existsSync(path), 'answer library migration must exist');
 const sql = readFileSync(path, 'utf8');
 for (const required of ['create table public.inquiry_answers', 'enable row level security', 'approved_by', 'approved_at', 'source_url', 'source_note', 'revision', 'inquiry_draft_sources', 'save_inquiry_answer', 'approve_inquiry_answer', 'from public, anon, authenticated']) assert.ok(sql.includes(required), required);
});
