#!/usr/bin/env python3
"""Deterministic 8 Lakes reminder tick; run only after reviewed activation.
No model, no credentials in argv, no customer data in scheduler output.
"""
import fcntl
import json
import os
from pathlib import Path
import shlex
import sys
import urllib.request

ENDPOINT = 'https://www.8lakestours.com/api/cron/abandoned-checkouts'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Reminder redirect refused')


def validate_result(data):
    if not isinstance(data, dict) or data.get('post_submit_enabled') is not True or data.get('dry_run'):
        raise RuntimeError('Reminder endpoint is not active')
    if not isinstance(data.get('sent'), int) or not isinstance(data.get('failed'), int):
        raise RuntimeError('Reminder endpoint returned an unexpected response')
    if data['failed']:
        raise RuntimeError('Reminder endpoint reported failed sends')


def main():
    home=Path(os.environ.get('HERMES_HOME',str(Path.home()/'.hermes')))
    lock_path=home/'cron/state/8l-reminder-tick.lock'
    lock_path.parent.mkdir(parents=True,exist_ok=True)
    with lock_path.open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: return
        env={}
        for line in (home/'secrets/8l-website-cron.env').read_text().splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                key,value=line.split('=',1); values=shlex.split(value); env[key.strip()]=values[0] if values else ''
        secret=env.get('CRON_SECRET','')
        if not secret or any(char in secret for char in '\r\n'): raise RuntimeError('Reminder credential unavailable')
        request=urllib.request.Request(ENDPOINT,headers={'Authorization':'Bearer '+secret,'Accept':'application/json','User-Agent':'8Lakes-ReminderScheduler/1.0'})
        with urllib.request.build_opener(NoRedirect()).open(request,timeout=55) as response:
            if response.geturl()!=ENDPOINT: raise RuntimeError('Unexpected reminder redirect')
            validate_result(json.load(response))


if __name__=='__main__':
    try: main()
    except Exception:
        print('8 Lakes checkout reminder tick failed; check endpoint and sender health. No credentials or customer details logged.',file=sys.stderr)
        sys.exit(1)
