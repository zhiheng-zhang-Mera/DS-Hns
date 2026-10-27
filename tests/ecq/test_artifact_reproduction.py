import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    file = ROOT / 'scripts/ecq' / (name+'.py')
    if not file.exists(): return None
    spec = importlib.util.spec_from_file_location(name,file)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result)
    return result


class ArtifactReproductionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.source=self.root/'source';self.source.mkdir()
        (self.source/'scripts/ecq').mkdir(parents=True)
        (self.source/'scripts/ecq/component.txt').write_bytes(b'fixed source\n')
        (self.source/'LICENSE').write_bytes(b'MIT fixture\n')
        (self.source/'docs/paper-material/revision-v37').mkdir(parents=True)
        (self.source/'docs/paper-material/revision-v37/requirements.lock').write_text('')
        (self.source/'artifacts/paper-revision/ecq-v37/benchmark-fixtures').mkdir(parents=True)
        (self.source/'artifacts/paper-revision/ecq-v37/benchmark-fixtures/large.bin').write_bytes(b'regenerable')
        self.destination=self.root/'export'

    def tearDown(self):self.temp.cleanup()

    def exporter(self):
        result=module('export_artifact');self.assertIsNotNone(result,'artifact exporter must exist');return result

    def reproducer(self):
        result=module('reproduce');self.assertIsNotNone(result,'artifact verifier must exist');return result

    def test_exact_snapshot_inventory_and_benchmark_exclusion(self):
        manifest=self.exporter().export(self.source,self.destination,'immutable-commit')
        self.assertEqual(manifest['sourceCommit'],'immutable-commit')
        self.assertIn('scripts/ecq/component.txt',manifest['files'])
        self.assertNotIn('artifacts/paper-revision/ecq-v37/benchmark-fixtures/large.bin',manifest['files'])
        report=self.reproducer().verify_inventory(self.destination)
        self.assertTrue(report['verified'])

    def test_changed_file_is_rejected(self):
        self.exporter().export(self.source,self.destination,'immutable-commit')
        (self.destination/'scripts/ecq/component.txt').write_bytes(b'changed')
        with self.assertRaises(ValueError):self.reproducer().verify_inventory(self.destination)

    def test_missing_file_is_rejected(self):
        self.exporter().export(self.source,self.destination,'immutable-commit')
        (self.destination/'LICENSE').unlink()
        with self.assertRaises(ValueError):self.reproducer().verify_inventory(self.destination)

    def test_path_escape_and_symlink_are_not_exported(self):
        self.exporter().export(self.source,self.destination,'immutable-commit')
        file=self.destination/'MANIFEST.json';manifest=json.loads(file.read_text())
        manifest['files']['../escape']='abc';file.write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):self.reproducer().verify_inventory(self.destination)


if __name__=='__main__':unittest.main()
