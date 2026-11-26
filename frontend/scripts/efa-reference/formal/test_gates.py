import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from run import valid_summary
from verify import verify


class ProofGateTests(unittest.TestCase):
    def setUp(self):
        self.receipt = json.loads((HERE / 'report.json').read_text())

    def test_wrong_proof_count_or_duplicate_ids_rejected(self):
        summary = self.receipt['cell']['summary']
        self.assertFalse(valid_summary(summary[:1], 2))
        changed = copy.deepcopy(summary)
        changed[1]['id'] = changed[0]['id']
        self.assertFalse(valid_summary(changed, 2))

    def test_assumed_or_failed_properties_rejected(self):
        for status in ['assumed', 'failed', 'unknown']:
            summary = copy.deepcopy(self.receipt['cell']['summary'])
            summary[0]['status'] = status
            self.assertFalse(valid_summary(summary, 2))

    def test_missing_hash_scope_rejected(self):
        self.receipt['boundHashes'] = {}
        with self.assertRaisesRegex(ValueError, 'Missing source'):
            verify(self.receipt)

    def test_stale_source_rejected(self):
        key = next(iter(self.receipt['boundHashes']))
        self.receipt['boundHashes'][key] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'stale'):
            verify(self.receipt)

    def test_changed_negative_source_rejected(self):
        key = next(iter(self.receipt['negativeArtifactHashes']))
        self.receipt['negativeArtifactHashes'][key] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Negative-control'):
            verify(self.receipt)

    def test_changed_solver_rejected(self):
        self.receipt['tools']['z3Sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Z3 executable changed'):
            verify(self.receipt)

    def test_generic_error_not_accepted_as_counterexample(self):
        self.receipt['negativeCell']['returncode'] = 0
        with self.assertRaisesRegex(ValueError, 'actual native counterexample'):
            verify(self.receipt)

    def test_altered_native_summary_rejected(self):
        self.receipt['gaussian']['summary'][0]['status'] = 'assumed'
        with self.assertRaisesRegex(ValueError, 'incorrect theorem'):
            verify(self.receipt)


if __name__ == '__main__':
    unittest.main()
