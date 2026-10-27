import importlib.util
import pathlib
import unittest
import yaml

PATH=pathlib.Path(__file__).parents[2]/'scripts/ecq/collect_ci.py'
spec=importlib.util.spec_from_file_location('collector',PATH)
collector=importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

class CollectionTests(unittest.TestCase):
    def test_workflow_event_key_is_not_yaml11_boolean(self):
        doc=yaml.load('on:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n',Loader=yaml.BaseLoader)
        self.assertIn('on',doc)
        collector.canonical(doc)
    def test_cutoff_order_and_split(self):
        runs=[{'id':1,'created_at':'2026-10-01T00:00:00Z'},
              {'id':3,'created_at':'2026-10-03T00:00:00Z'},
              {'id':2,'created_at':'2026-10-02T00:00:00Z'}]
        self.assertEqual([r['id'] for r in collector.ordered_runs(runs,'2026-10-02T23:00:00Z')],[2,1])
    def test_variants_preserve_pinned_contract(self):
        bundle={'caseId':'x','evidence':[{'id':'e','subject':{'commit':'good'},'runId':'1','claimId':'job:a','scope':'job:a','artifactRefs':[{'availability':None}]}]}
        variants=collector.variants(bundle)
        self.assertEqual(len(variants),6)
        self.assertEqual(variants['wrong-state']['evidence'][0]['subject']['commit'],'0'*40)
        self.assertEqual(bundle['evidence'][0]['subject']['commit'],'good')
        self.assertEqual(variants['missing-gate']['evidence'],[])
        self.assertEqual(variants['unavailable-artifact']['evidence'][0]['artifactRefs'][0]['availability'],'UNAVAILABLE')

if __name__=='__main__':unittest.main()
