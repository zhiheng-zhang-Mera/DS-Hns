"""Verify an exported ECQ inventory and independently recompute published tables."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


def _sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def _json(path):return json.loads(path.read_text(encoding='utf-8-sig'))


def _jsonl(path):return [json.loads(x) for x in path.read_text(encoding='utf-8-sig').splitlines() if x.strip()]


def verify_inventory(root):
    root=Path(root).resolve();manifest=_json(root/'MANIFEST.json')
    for relative,record in manifest['files'].items():
        path=(root/relative).resolve()
        try:path.relative_to(root)
        except ValueError:raise ValueError('inventory path leaves package: '+relative)
        if not path.is_file():raise ValueError('missing inventoried file: '+relative)
        expected=record['sha256'] if isinstance(record,dict) else record
        if _sha(path)!=expected:raise ValueError('inventoried bytes differ: '+relative)
    return {'verified':True,'filesChecked':len(manifest['files']),'sourceCommit':manifest['sourceCommit'],
            'manifestSha256':_sha(root/'MANIFEST.json')}


def _load_module(root,name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),root/'scripts/ecq'/f'{name}.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def _find_labels(root):
    labels={}
    artifact_root=root/'artifacts/paper-revision/ecq-v37'
    for file in sorted(artifact_root.rglob('*.jsonl')):
        if 'reproduced' in file.parts:continue
        with file.open(encoding='utf-8-sig') as stream:
            first=next((line for line in stream if line.strip()),None)
        if first is None or 'expectedClosure' not in json.loads(first):continue
        for label in _jsonl(file):
            case=label['caseId']
            if case in labels and labels[case]!=label:raise ValueError('conflicting archived labels: '+case)
            labels[case]=label
    return labels


def reproduce(root,rerun=False):
    root=Path(root).resolve();report={'inventory':verify_inventory(root),'campaigns':[]}
    analyzer=_load_module(root,'analyze');verifier=_load_module(root,'verify-campaign')
    labels=_find_labels(root)
    freezes=list((root/'docs/paper-material/revision-v37').glob('FREEZE.json'))
    if not freezes:raise ValueError('artifact lacks frozen research identity')
    freeze=freezes[0];artifact=root/'artifacts/paper-revision/ecq-v37'
    output_root=root/'reproduced';output_root.mkdir(exist_ok=True)
    for campaign_file in sorted(artifact.rglob('campaign.json')):
        campaign_dir=campaign_file.parent;campaign=_json(campaign_file)
        manifest_path=campaign_dir/campaign['manifestPath']
        if not manifest_path.is_file():raise ValueError('campaign path is not portable: '+str(manifest_path))
        integrity=verifier.verify(campaign_dir,freeze)
        entries=_jsonl(manifest_path);attempts=_jsonl(campaign_dir/'attempts.jsonl')
        case_ids=[entry['caseId'] for entry in entries]
        if any(case not in labels for case in case_ids):raise ValueError('missing archived labels for campaign '+campaign['campaignId'])
        summary=analyzer.analyze(entries,attempts,[labels[case] for case in case_ids])
        destination=output_root/campaign['campaignId'];destination.mkdir(parents=True,exist_ok=True)
        (destination/'summary.json').write_text(json.dumps(summary,indent=2,sort_keys=True)+'\n',encoding='utf-8')
        expected_file=next((p for p in [campaign_dir/'analysis/summary.json',campaign_dir/'summary.json'] if p.is_file()),None)
        comparison='no archived summary located'
        if expected_file:
            expected=_json(expected_file)
            fields=('cases','methodOutputs','baseClusters','methods','byFamily','bySource','obligationOverlapCases','pairedBootstrap')
            for field in fields:
                if summary[field]!=expected[field]:raise ValueError('published summary differs: '+campaign['campaignId']+' '+field)
            comparison='all recomputed numerical summaries match'
        result={'campaignId':campaign['campaignId'],'integrity':integrity,'analysisComparison':comparison,
                'cases':len(entries),'methodOutputs':len(attempts)}
        if rerun:
            methods=campaign['methods'];ablation=all(method.startswith('ECQ-no-') for method in methods)
            dataset='external' if 'external' in campaign['campaignId'].lower() else 'challenge'
            command=['node','scripts/ecq/run-campaign.cjs','--freeze',str(freeze.relative_to(root)),
                     '--dataset',dataset,'--methods',','.join(methods),
                     '--out',str((destination/'rerun').relative_to(root))]
            if ablation:command.extend(['--mode','ablation'])
            completed=subprocess.run(command,cwd=root,capture_output=True,text=True)
            (destination/'rerun.stdout').write_text(completed.stdout,encoding='utf-8')
            (destination/'rerun.stderr').write_text(completed.stderr,encoding='utf-8')
            result['rerunExitCode']=completed.returncode
            if completed.returncode:raise ValueError('frozen method rerun failed: '+campaign['campaignId'])
        report['campaigns'].append(result)
    if not report['campaigns']:raise ValueError('no completed research campaigns in artifact')
    report['verified']=True
    (output_root/'REPRODUCTION.json').write_text(json.dumps(report,indent=2,sort_keys=True)+'\n',encoding='utf-8')
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path('.'))
    parser.add_argument('--rerun',action='store_true')
    args=parser.parse_args();report=reproduce(args.root,args.rerun)
    print(json.dumps(report))


if __name__=='__main__':main()
