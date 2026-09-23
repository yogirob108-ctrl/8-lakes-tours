import importlib.util
import pathlib
import unittest
from unittest.mock import Mock

path=pathlib.Path(__file__).parents[1]/'scripts/reminder-scheduler-tick.py'
spec=importlib.util.spec_from_file_location('tick',path)
tick=importlib.util.module_from_spec(spec)
spec.loader.exec_module(tick)

class TickTests(unittest.TestCase):
    def test_validate_response(self):
        tick.validate_result({'post_submit_enabled':True,'pre_submit_draft_enabled':False,'sent':0,'failed':0})
        for data in ({}, {'post_submit_enabled':False,'sent':0,'failed':0}, {'post_submit_enabled':True,'sent':0,'failed':1}, {'post_submit_enabled':True,'dry_run':True,'sent':0,'failed':0}):
            with self.assertRaises(RuntimeError): tick.validate_result(data)
    def test_non_secret_error(self):
        with self.assertRaisesRegex(RuntimeError,'reported failed sends'):
            tick.validate_result({'post_submit_enabled':True,'sent':0,'failed':1,'error':'sensitive detail'})

if __name__=='__main__': unittest.main()
