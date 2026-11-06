#!/bin/bash
set -e
export PGHOST=localhost PGPORT=55432 PGUSER=postgres
psql -XqAt -d postgres -c 'drop database if exists "8l_test" with (force)'
psql -XqAt -d postgres -c 'create database "8l_test"'
for f in supabase/migrations/*.sql; do
  psql -XqAt -v ON_ERROR_STOP=1 -d 8l_test -f "$f" >/dev/null 2>/tmp/mig_err.txt || { echo "MIGRATION FAIL: $f"; cat /tmp/mig_err.txt; exit 1; }
done
echo "gate default: $(psql -XqAt -d 8l_test -c 'select public.abandoned_cadence_gate_current()')"
