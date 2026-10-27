"""Independent source-to-normalized-file audit, not a classifier accuracy test."""
import hashlib,json,pathlib,unittest
ROOT=pathlib.Path(__file__).parents[2]
DATA=ROOT/'artifacts/paper-revision/ecq-v37/external-corpus'
class ExternalIntegrity(unittest.TestCase):
 def test_exact_run_split_grid_and_collector_pinned_objects(self):
  rows=[json.loads(x) for x in (DATA/'manifest.jsonl').read_text().splitlines()]
  self.assertEqual(len(rows),360);self.assertEqual(sum(r['split']=='evaluation' for r in rows),240)
  self.assertEqual(len({r['caseId'] for r in rows}),360)
  bases={}
  for row in rows:bases.setdefault(row['baseId'],[]).append(row)
  self.assertEqual(len(bases),60)
  for group in bases.values():
   self.assertEqual(len(group),6);self.assertEqual(len({r['split'] for r in group}),1)
   original=next(r for r in group if r['family']=='original')
   base=json.loads((DATA/original['bundlePath']).read_text());contract=json.loads((DATA/original['contractPath']).read_text())
   self.assertEqual(len(contract['requiredGates']),1)
   reference=base['evidence'][0]['artifactRefs'][0]
   raw=(DATA/original['artifactRoot']/reference['path']).read_bytes();source=json.loads(raw)
   self.assertEqual(reference['objectId'],f"github-job:{source['id']}")
   self.assertEqual(reference['expectedObjectId'],reference['objectId'])
   self.assertEqual(hashlib.sha256(raw).hexdigest(),reference['sha256'])
   self.assertEqual(base['evidence'][0]['outcome'],{'success':'PASS','failure':'FAIL'}[source['conclusion']])
   for row in group:
    self.assertEqual(json.loads((DATA/row['contractPath']).read_text()),contract)
    bundle=json.loads((DATA/row['bundlePath']).read_text())
    if bundle['evidence']:
     ref=bundle['evidence'][0]['artifactRefs'][0]
     self.assertEqual(ref['sha256'],reference['sha256'])
     self.assertEqual(ref['expectedObjectId'],reference['expectedObjectId'])
 def test_development_and_evaluation_are_source_disjoint(self):
  rows=[json.loads(x) for x in (DATA/'manifest.jsonl').read_text().splitlines()]
  dev={r['sourceRunId'] for r in rows if r['split']=='development'}
  evaluation={r['sourceRunId'] for r in rows if r['split']=='evaluation'}
  self.assertFalse(dev&evaluation);self.assertEqual(len(dev),20);self.assertEqual(len(evaluation),40)
if __name__=='__main__':unittest.main()
