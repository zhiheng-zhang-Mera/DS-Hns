"""Check exact registered case/method membership and frozen identities (stdlib only)."""
import argparse
import hashlib
import json
from pathlib import Path


def _json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def _jsonl(path):
    return [json.loads(line) for line in Path(path).read_text(encoding='utf-8-sig').splitlines() if line.strip()]


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify(campaign_dir, freeze_file):
    directory, freeze_path = Path(campaign_dir).resolve(), Path(freeze_file).resolve()
    campaign = _json(directory / 'campaign.json')
    freeze = _json(freeze_path)
    if campaign.get('freezeSha256') != _sha(freeze_path):
        raise ValueError('freeze digest mismatch')
    manifest_path = directory / campaign['manifestPath']
    if campaign.get('manifestSha256') != _sha(manifest_path):
        raise ValueError('manifest digest mismatch')
    entries = _jsonl(manifest_path)
    case_ids = [entry['caseId'] for entry in entries]
    if len(case_ids) != len(set(case_ids)):
        raise ValueError('duplicate registered case')
    methods = campaign['methods']
    if len(methods) != len(set(methods)) or not methods:
        raise ValueError('duplicate/empty registered method set')
    expected = {(case, method, 1) for case in case_ids for method in methods}
    attempts = _jsonl(directory / 'attempts.jsonl')
    actual = [(row['caseId'], row['methodId'], row['attemptId']) for row in attempts]
    if len(actual) != len(set(actual)):
        raise ValueError('duplicate method attempt')
    if set(actual) != expected:
        raise ValueError('registered grid mismatch: missing=%d extra=%d' %
                         (len(expected-set(actual)), len(set(actual)-expected)))
    failures = 0
    for row in attempts:
        if row['campaignId'] != campaign['campaignId']:
            raise ValueError('campaign identity mismatch')
        if row['methodRevision'] != campaign['methodRevision']:
            raise ValueError('method revision mismatch')
        status = row['executionStatus']
        if status not in ('COMPLETED', 'RUNTIME_ERROR', 'TIMEOUT', 'UNSUPPORTED'):
            raise ValueError('unknown execution status')
        if status == 'COMPLETED':
            if row.get('result') is None or row.get('exitCode') != 0:
                raise ValueError('completed attempt lacks successful result')
            if not isinstance(row['result'].get('authorizePass'), bool):
                raise ValueError('completed authorization is not boolean')
        else:
            failures += 1
            if row.get('result') is not None:
                raise ValueError('execution failure disguised as a qualification result')
        for field in ('stdoutPath', 'stderrPath'):
            if row.get(field) and not (directory / row[field]).is_file():
                raise ValueError('missing raw execution stream: ' + row[field])
        capabilities = row.get('capabilities', {})
        for field in ('authorization', 'closure', 'gateSatisfaction', 'relationDiagnostics', 'witnesses'):
            if not isinstance(capabilities.get(field), bool):
                raise ValueError('missing method capability: ' + field)
        if status == 'COMPLETED' and row['result'].get('capabilities') is not None:
            if row['result']['capabilities'] != capabilities:
                raise ValueError('capability declaration mismatch')
    file_hashes = freeze.get('files', {})
    code_root = Path(freeze['codeRoot']) if freeze.get('codeRoot') else None
    if code_root is not None and not code_root.is_absolute():
        code_root = freeze_path.parent / code_root
    if code_root is None and file_hashes:
        code_root = next((parent for parent in [freeze_path.parent, *freeze_path.parents]
                          if all((parent / name).is_file() for name in file_hashes)), None)
        if code_root is None:
            raise ValueError('cannot locate frozen file root')
    checked = 0
    for name, expected_sha in file_hashes.items():
        if isinstance(expected_sha, dict):
            expected_sha = expected_sha.get('sha256')
        if _sha(code_root / name) != expected_sha:
            raise ValueError('frozen file digest mismatch: ' + name)
        checked += 1
    return {'verified': True, 'campaignId': campaign['campaignId'], 'cases': len(entries),
            'methods': methods, 'expectedOutputs': len(expected), 'actualOutputs': len(attempts),
            'executionFailures': failures, 'frozenFilesChecked': checked,
            'manifestSha256': _sha(manifest_path), 'freezeSha256': _sha(freeze_path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--campaign', type=Path, required=True)
    parser.add_argument('--freeze', type=Path, required=True)
    args = parser.parse_args()
    report = verify(args.campaign, args.freeze)
    (args.campaign / 'INTEGRITY.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__': main()
