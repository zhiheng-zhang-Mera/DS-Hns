"""Offline replay entry point copied to the research artifact root."""
import argparse,base64,hashlib,json,math,os,pathlib,statistics,subprocess,sys,tarfile,zipfile

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def verify_inventory(root):
    manifest=json.loads((root/'MANIFEST.json').read_text(encoding='utf-8'))
    for name,sha in manifest['files'].items():
        p=(root/name).resolve()
        if not p.is_relative_to(root) or not p.is_file() or digest(p)!=sha:raise ValueError('artifact inventory mismatch: '+name)
    return len(manifest['files'])

def bootstrap(root):
    deps=root/'artifacts/paper-revision/ecq-v38/dependencies'
    target=root/'scripts/ecq-v38/native/node_modules/yaml'
    lock=json.loads((root/'scripts/ecq-v38/native/package-lock.json').read_text(encoding='utf-8'))
    tar=deps/'yaml-2.8.3.tgz';integrity=lock['packages']['node_modules/yaml']['integrity']
    if integrity!='sha512-'+base64.b64encode(hashlib.sha512(tar.read_bytes()).digest()).decode():raise ValueError('Node dependency differs from locked integrity')
    if not (target/'package.json').is_file():
        target.mkdir(parents=True,exist_ok=True)
        with tarfile.open(tar,'r:gz') as package:
            for member in package.getmembers():
                name=pathlib.PurePosixPath(member.name)
                if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0]!='package' or member.issym() or member.islnk():raise ValueError('unsafe dependency member')
                relative=pathlib.Path(*name.parts[1:]);dest=(target/relative).resolve()
                if not dest.is_relative_to(target.resolve()):raise ValueError('dependency outside target')
                if member.isdir():dest.mkdir(parents=True,exist_ok=True)
                elif member.isfile():dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(package.extractfile(member).read())
    wheels=list(deps.glob('ruamel.yaml-0.18.16-*.whl'))+list(deps.glob('ruamel_yaml-0.18.16-*.whl'))
    if len(wheels)!=1:raise ValueError('missing exact Python wheel')
    py=root/'.runtime/python';py.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(wheels[0]) as wheel:
        for info in wheel.infolist():
            name=pathlib.PurePosixPath(info.filename);dest=(py/pathlib.Path(*name.parts)).resolve()
            if name.is_absolute() or '..' in name.parts or not dest.is_relative_to(py.resolve()):raise ValueError('unsafe Python dependency member')
            if not info.is_dir():dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(wheel.read(info))
    env=dict(os.environ);env['PYTHONPATH']=str(py)+os.pathsep+env.get('PYTHONPATH','');env['PYTHONUTF8']='1'
    return env

def verify_cost(root):
    data=root/'artifacts/paper-revision/ecq-v38/cost';summary=json.loads((data/'summary.json').read_text(encoding='utf-8'));checked=0
    for row in summary:
        raw=json.loads((data/('native.json' if row['method']=='native' else 'reference.json')).read_text(encoding='utf-8'))
        rounds=[r for r in raw['rows'] if r['size']==row['size'] and 'round' in r]
        if len(rounds)!=row['completed'] or row['censored']!=(len(rounds)!=30):raise ValueError('cost completion mismatch')
        for key,value in row.items():
            if key.endswith('Median'):
                actual=statistics.median(r[key[:-6]] for r in rounds)
                if not math.isclose(actual,value,rel_tol=1e-12,abs_tol=1e-12):raise ValueError('cost median mismatch')
        checked+=1
    return checked

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',default=str(pathlib.Path(__file__).resolve().parent));p.add_argument('--full-archives',action='store_true');a=p.parse_args();root=pathlib.Path(a.root).resolve()
    checked=verify_inventory(root);env=bootstrap(root)
    commands=[[sys.executable,'scripts/ecq-v38/collection/verify.py'],[sys.executable,'scripts/ecq-v38/platform/verify_platform.py'],['node','--test',*map(str,sorted((root/'tests/ecq-v38/native').glob('*.test.mjs')))], [sys.executable,'-m','unittest','discover','-s','tests/ecq-v38/reference','-v'],[sys.executable,'scripts/ecq-v38/study/run_controls.py']]
    if a.full_archives:commands += [[sys.executable,'scripts/ecq-v38/study/run_archives.py','--split',s,'--out',str(root/'.runtime/archive-replay')] for s in ('development','evaluation')]
    for cmd in commands:
        run=subprocess.run(cmd,cwd=root,env=env,capture_output=True,encoding='utf-8',errors='replace',timeout=900)
        print(json.dumps({'command':cmd,'exitCode':run.returncode,'stdoutTail':run.stdout[-4000:],'stderrTail':run.stderr[-3000:]}))
        if run.returncode:raise SystemExit(run.returncode)
    report={'status':'PASS','inventoryFiles':checked,'costSummaryCellsRecomputed':verify_cost(root),'archivesRecomputed':a.full_archives,'networkRequired':False,'runtimesRequired':'Node24.14.0 and Python3.14.3; runtime binaries are not bundled'}
    (root/'REPRODUCTION_RESULT.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');print(json.dumps(report))
if __name__=='__main__':main()
