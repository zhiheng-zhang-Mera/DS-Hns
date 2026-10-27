import base64, contextlib, copy, hashlib, importlib.util, io, json, pathlib, tempfile, unittest
spec=importlib.util.spec_from_file_location('verify',pathlib.Path(__file__).with_name('verify.py'))
verify=importlib.util.module_from_spec(spec); spec.loader.exec_module(verify)

class TamperTests(unittest.TestCase):
    def fixture(self,out):
        (out/'raw').mkdir(); (out/'yaml').mkdir()
        sha='a'*40; source=b'jobs: {}\n'; (out/'yaml/a.yaml').write_bytes(source)
        run={'id':1,'created_at':'2026-10-01T00:00:00Z','head_sha':sha,'run_attempt':1,'conclusion':'success','status':'completed','event':'push'}
        selected={'repository':'x/y','workflow':'ci.yml','split':'development','selectionRank':1,'run':run}
        job={'id':9,'run_id':1,'run_attempt':1,'name':'test','conclusion':'success'}
        src={'repository':'x/y','path':'.github/workflows/ci.yml','sha':sha,'file':'yaml/a.yaml','sha256':hashlib.sha256(source).hexdigest(),'children':[]}
        record={**selected,'detail':run,'jobs':[job],'jobsTotalCount':1,'jobsPaginationComplete':True,'jobsPageCount':1,'headSourceSnapshot':src,'candidateExecutionSources':[],'rootExecutionIdentity':{'status':'UNKNOWN'},'logicalRevisionGroup':'x/y:'+sha}
        responses={f'repos/x/y/actions/workflows/ci.yml/runs?status=success&created=%3C2026-10-27T00:00:00Z&per_page=100&page=1':{'workflow_runs':[run]},'repos/x/y/actions/runs/1':run,'repos/x/y/actions/runs/1/attempts/1/jobs?per_page=100&page=1':{'total_count':1,'jobs':[job]},f'repos/x/y/contents/.github/workflows/ci.yml?ref={sha}':{'content':base64.b64encode(source).decode()}}
        manifest=[]
        for n,(endpoint,data) in enumerate(responses.items()):
            raw=json.dumps(data).encode(); file=f'raw/{n}.json'; (out/file).write_bytes(raw)
            manifest.append({'endpoint':endpoint,'file':file,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'exitCode':0})
        for name,obj in [('manifest.json',manifest),('records.json',[record]),('selection.json',{'cutoffExclusive':'2026-10-27T00:00:00Z','records':[selected]}),('preflight-exclusions.json',{'runIds':[]})]:
            (out/name).write_text(json.dumps(obj),encoding='utf8')
    def audit(self,mutation=None,disk_mutation=None):
        with tempfile.TemporaryDirectory() as d:
            out=pathlib.Path(d); self.fixture(out)
            if mutation:
                records=json.loads((out/'records.json').read_text()); mutation(records[0]); (out/'records.json').write_text(json.dumps(records))
            if disk_mutation: disk_mutation(out)
            prior=verify.OUT; verify.OUT=out
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    try: verify.main()
                    except SystemExit: pass
                return json.loads((out/'verification.json').read_text())['passed']
            finally: verify.OUT=prior
    def test_clean(self): self.assertTrue(self.audit())
    def test_derived_job_tamper(self): self.assertFalse(self.audit(lambda r:r['jobs'][0].update(name='invented')))
    def test_derived_detail_tamper(self): self.assertFalse(self.audit(lambda r:r['detail'].update(event='invented')))
    def test_derived_run_tamper(self): self.assertFalse(self.audit(lambda r:r['run'].update(event='invented')))
    def test_source_raw_binding_tamper(self): self.assertFalse(self.audit(lambda r:r['headSourceSnapshot'].update(path='.github/workflows/other.yml')))
    def test_pagination_tamper(self): self.assertFalse(self.audit(lambda r:r.update(jobsPageCount=2)))
    def test_completeness_tamper(self): self.assertFalse(self.audit(lambda r:r.update(jobsPaginationComplete=False)))
    def test_source_content_and_digest_tamper(self):
        def mutate(out):
            b=b'jobs: {invented: {}}\n'; (out/'yaml/a.yaml').write_bytes(b)
            records=json.loads((out/'records.json').read_text()); records[0]['headSourceSnapshot']['sha256']=hashlib.sha256(b).hexdigest()
            (out/'records.json').write_text(json.dumps(records))
        self.assertFalse(self.audit(disk_mutation=mutate))
if __name__=='__main__': unittest.main()
