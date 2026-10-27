import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]


class CostAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.native=self.root/'benchmark-v2';self.native.mkdir()
        (self.native/'config.json').write_text(json.dumps({'gates':[10],'sizes':[1048576],'methods':['ECQ'],'warmups':5,'rounds':30}))
        self.rows=[{'methodId':'ECQ','gates':10,'artifact_bytes':1048576,'round':i,'normalize_ms':i+1,'rule_ms':2*(i+1),'end_to_end_ms':3*(i+1),'peak_rss_bytes':1000+i,'authorizePass':True,'ruleAuthorizePass':True} for i in range(30)]
        (self.native/'startup.json').write_text(json.dumps([{'methodId':'ECQ','gates':10,'artifact_bytes':1048576,'startup_ms':17}]))
        self.write()

    def tearDown(self):self.temp.cleanup()

    def write(self):
        (self.native/'measurements.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in self.rows))

    def analyzer(self):
        p=ROOT/'scripts/ecq/analyze_costs.py';self.assertTrue(p.exists(),'independent cost analyzer must exist')
        s=importlib.util.spec_from_file_location('cost_analysis',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

    def test_known_median_quartiles_and_separate_startup(self):
        s=self.analyzer().analyze(self.root);g=s['groups'][0]
        self.assertEqual(g['status'],'COMPLETE')
        self.assertEqual(g['metrics']['normalize_ms'],{'n':30,'median':15.5,'q1':8.25,'q3':22.75})
        self.assertEqual(g['warmupsDeclared'],5)
        self.assertIsNone(g['warmupsRecorded'])
        self.assertEqual(s['coldStartup'][0]['startup_ms'],17)

    def test_duplicate_formal_round_is_rejected(self):
        self.rows.append(self.rows[0]);self.write()
        with self.assertRaises(ValueError):self.analyzer().analyze(self.root)

    def test_native_warmups_are_counted_when_archived(self):
        rows=[dict(self.rows[0],round=i,phase='warmup') for i in range(-5,0)]
        (self.native/'warmups.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
        g=self.analyzer().analyze(self.root)['groups'][0]
        self.assertEqual(g['warmupsRecorded'],5)

    def test_duplicate_archived_warmup_is_rejected(self):
        row=dict(self.rows[0],round=-1,phase='warmup')
        (self.native/'warmups.jsonl').write_text(json.dumps(row)+'\n'+json.dumps(row)+'\n')
        with self.assertRaises(ValueError):self.analyzer().analyze(self.root)

    def test_partial_budget_never_produces_full_estimate(self):
        b=self.root/'benchmark-shacl-v2';b.mkdir()
        (b/'config.json').write_text(json.dumps({'methods':['B2'],'warmups':5,'rounds':30}))
        rows=[dict(self.rows[0],methodId='B2',round=i,phase='warmup' if i<0 else 'formal') for i in range(-5,2)]
        (b/'fixture-10-1048576.all-attempts.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
        (b/'fixture-10-1048576.censored.json').write_text(json.dumps({'status':'BUDGET_CENSORED','budgetSeconds':180}))
        (b/'measurements.jsonl').write_text('')
        g=next(g for g in self.analyzer().analyze(self.root)['groups'] if g['methodId']=='B2')
        self.assertEqual((g['status'],g['formalCount'],g['warmupsRecorded']),('BUDGET_CENSORED',2,5))
        self.assertIsNone(g['metrics'])

    def test_missing_round_is_not_silently_a_thirty_round_estimate(self):
        self.rows.pop();self.write();g=self.analyzer().analyze(self.root)['groups'][0]
        self.assertEqual(g['status'],'INCOMPLETE')
        self.assertIsNone(g['metrics'])

    def test_serialization_is_deterministic_and_detects_published_tamper(self):
        m=self.analyzer();out=self.root/'analysis';m.write_analysis(self.root,out)
        before=(out/'cost-summary.json').read_bytes();m.write_analysis(self.root,out,verify_existing=True)
        self.assertEqual(before,(out/'cost-summary.json').read_bytes())
        (out/'cost-summary.json').write_bytes(b'changed')
        with self.assertRaises(ValueError):m.write_analysis(self.root,out,verify_existing=True)


if __name__=='__main__':unittest.main()
