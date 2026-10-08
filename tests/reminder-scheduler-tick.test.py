#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'reminder-scheduler-tick.py'

spec = importlib.util.spec_from_file_location('reminder_scheduler_tick', SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError('Cannot load canonical reminder scheduler')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReminderSchedulerTickTests(unittest.TestCase):
    def test_active_zero_failure_response_is_accepted(self):
        module.validate_result({'post_submit_enabled': True, 'dry_run': False, 'sent': 0, 'failed': 0})

    def test_inactive_dry_run_or_failed_response_is_rejected(self):
        for payload in (
            {'post_submit_enabled': False, 'dry_run': False, 'sent': 0, 'failed': 0},
            {'post_submit_enabled': True, 'dry_run': True, 'sent': 0, 'failed': 0},
            {'post_submit_enabled': True, 'dry_run': False, 'sent': 0, 'failed': 1},
        ):
            with self.assertRaises(RuntimeError):
                module.validate_result(payload)

    def test_python_tick_is_the_only_scheduler_wrapper(self):
        self.assertFalse((ROOT / 'scripts' / 'run-abandoned-checkout-reminder.sh').exists())
        self.assertIn("'Authorization':'Bearer '+secret", SCRIPT.read_text())


if __name__ == '__main__':
    unittest.main()
