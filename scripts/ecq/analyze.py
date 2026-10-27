"""Recompute qualification metrics from saved attempts and independent labels.

No observer or reference evaluator is imported. Cases, base clusters and source
strata are joined from the outer manifest only after method execution.
"""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import json
from pathlib import Path
import random


def _ratio(numerator, denominator, **extra):
    return {'numerator': numerator, 'denominator': denominator,
            'rate': numerator/denominator if denominator else None, **extra}


def _diagnostic_set(relations):
    return {(r['obligationId'], r['status']) for r in relations or []
            if r['status'] in ('VIOLATED', 'UNRESOLVED')}


def _prf(tp, predicted, actual):
    precision = tp/predicted if predicted else None
    recall = tp/actual if actual else None
    f1 = 2*tp/(predicted+actual) if predicted+actual else None
    return {'truePositive': tp, 'predicted': predicted, 'actual': actual,
            'precision': precision, 'recall': recall, 'f1': f1}


def _method_metrics(entries, rows, labels):
    by_case = {r['caseId']: r for r in rows}
    correct = false_auth = false_reject = invalid_n = valid_n = invalid_unfinished = 0
    semantic_n = semantic_correct = fail_n = fail_correct = failures = 0
    diag = defaultdict(lambda: [0, 0, 0])
    witness_correct = witness_n = 0
    has_semantic = any(r.get('capabilities', {}).get('closure') and r.get('capabilities', {}).get('gateSatisfaction') for r in rows)
    has_diag = any(r.get('capabilities', {}).get('relationDiagnostics') for r in rows)
    support_counts = Counter()
    for entry in entries:
        case = entry['caseId']
        label = labels[case]
        row = by_case.get(case)
        completed = row is not None and row.get('executionStatus') == 'COMPLETED' and row.get('result') is not None
        result = row['result'] if completed else {}
        if not completed: failures += 1
        capabilities = row.get('capabilities', {}) if row else {}
        for cap, supported in capabilities.items():
            if supported: support_counts[cap] += 1
        expected = label['expectedAuthorizePass']
        if completed and result.get('authorizePass') == expected: correct += 1
        invalid = label['expectedClosure'] in ('VIOLATED', 'UNRESOLVED')
        if invalid:
            invalid_n += 1
            if not completed: invalid_unfinished += 1
            if completed and result.get('authorizePass') is True: false_auth += 1
        if expected:
            valid_n += 1
            if not completed or result.get('authorizePass') is not True: false_reject += 1
        axes_match = completed and all(result.get(field) == label[expected_field] for field, expected_field in
                    [('closureStatus', 'expectedClosure'), ('gateSatisfaction', 'expectedGateSatisfaction'), ('authorizePass', 'expectedAuthorizePass')])
        if has_semantic:
            semantic_n += 1
            if axes_match: semantic_correct += 1
            if label['expectedClosure'] == 'CLOSED' and label['expectedGateSatisfaction'] == 'UNSATISFIED':
                fail_n += 1
                if axes_match: fail_correct += 1
        if has_diag:
            truth = _diagnostic_set(label.get('relations'))
            prediction = _diagnostic_set(result.get('relations')) if completed else set()
            for key, gold, pred in [('all', truth, prediction),
                                   ('VIOLATED', {x for x in truth if x[1]=='VIOLATED'}, {x for x in prediction if x[1]=='VIOLATED'}),
                                   ('UNRESOLVED', {x for x in truth if x[1]=='UNRESOLVED'}, {x for x in prediction if x[1]=='UNRESOLVED'})]:
                diag[key][0] += len(gold & pred); diag[key][1] += len(pred); diag[key][2] += len(gold)
            for invariant in ['I_'+x for x in 'SRGVECIT']:
                gold = {x for x in truth if x[0].startswith(invariant+':')}
                pred = {x for x in prediction if x[0].startswith(invariant+':')}
                diag[invariant][0] += len(gold & pred); diag[invariant][1] += len(pred); diag[invariant][2] += len(gold)
            golden_relations = {(r['obligationId'], r['status']): r for r in label.get('relations', [])}
            for relation in result.get('relations') or []:
                key = relation['obligationId'], relation['status']
                if relation['status'] not in ('VIOLATED', 'UNRESOLVED'): continue
                witness_n += 1
                expected_relation = golden_relations.get(key)
                if expected_relation and sorted(relation.get('witnessRefs', [])) == sorted(expected_relation.get('witnessRefs', [])):
                    witness_correct += 1
    return {'registeredCases': len(entries), 'executionFailures': failures,
            'executionFailureRate': _ratio(failures, len(entries)),
            'authorizationAccuracy': _ratio(correct, len(entries)),
            'falseAuthorization': _ratio(false_auth, invalid_n, unfinished=invalid_unfinished),
            'falseRejection': _ratio(false_reject, valid_n),
            'semanticMatch': _ratio(semantic_correct, semantic_n) if has_semantic else None,
            'legitimateFailMatch': _ratio(fail_correct, fail_n) if has_semantic else None,
            'diagnostics': {key: _prf(*values) for key, values in sorted(diag.items())} if has_diag else None,
            'witnesses': _ratio(witness_correct, witness_n) if has_diag else None,
            'capabilityCoverage': {cap: _ratio(support_counts[cap], len(entries)) for cap in
                                   ['authorization', 'closure', 'gateSatisfaction', 'relationDiagnostics', 'witnesses']}}


def _quantile(values, probability):
    values = sorted(values)
    index = (len(values)-1)*probability
    lower = int(index)
    upper = min(lower+1, len(values)-1)
    return values[lower] + (index-lower)*(values[upper]-values[lower])


def _paired_bootstrap(entries, attempts, labels, repetitions):
    lookup = {(r['caseId'], r['methodId']): r for r in attempts}
    methods = sorted({r['methodId'] for r in attempts})
    if 'ECQ' not in methods: return []
    strata = defaultdict(lambda: defaultdict(list))
    for e in entries:
        strata[e.get('sourceGroup', 'unknown')][e.get('baseId', e['caseId'])].append(e['caseId'])
    comparisons = []
    for other in methods:
        if other == 'ECQ': continue
        # Triple sums: difference in correct authorizations, denominator cases;
        # difference in false authorizations, denominator invalid-evidence cases.
        groups = []
        total = [0, 0, 0, 0]
        for stratum in sorted(strata):
            subgroup = []
            for base in sorted(strata[stratum]):
                group = [0, 0, 0, 0]
                for case in strata[stratum][base]:
                    label = labels[case]
                    invalid = label['expectedClosure'] in ('VIOLATED', 'UNRESOLVED')
                    values = []
                    for method in ('ECQ', other):
                        row = lookup.get((case, method), {})
                        finished = row.get('executionStatus') == 'COMPLETED' and row.get('result') is not None
                        authorization = row.get('result', {}).get('authorizePass') if finished else None
                        values.append((int(finished and authorization == label['expectedAuthorizePass']),
                                       int(invalid and finished and authorization is True)))
                    group[0] += values[0][0]-values[1][0]; group[1] += 1
                    group[2] += values[0][1]-values[1][1]; group[3] += int(invalid)
                subgroup.append(group)
                total = [a+b for a, b in zip(total, group)]
            groups.append(subgroup)
        rng = random.Random(20261027)
        accuracy_draws, false_auth_draws = [], []
        for _ in range(repetitions):
            sample = [0, 0, 0, 0]
            for stratum in groups:
                for _ in stratum:
                    group = stratum[rng.randrange(len(stratum))]
                    sample = [a+b for a,b in zip(sample, group)]
            accuracy_draws.append(sample[0]/sample[1])
            if sample[3]: false_auth_draws.append(sample[2]/sample[3])
        def endpoint(n, d, draws):
            return {'difference': n/d if d else None,
                    'ci95': [_quantile(draws,.025), _quantile(draws,.975)] if draws else None,
                    'degenerate': bool(draws) and min(draws)==max(draws)}
        comparisons.append({'reference': 'ECQ', 'comparator': other, 'clusters': sum(map(len,groups)),
                            'strata': len(groups), 'repetitions': repetitions, 'seed': 20261027,
                            'unit': 'baseId within sourceGroup',
                            'authorizationAccuracyDifference': endpoint(total[0],total[1],accuracy_draws),
                            'falseAuthorizationDifference': endpoint(total[2],total[3],false_auth_draws)})
    return comparisons


def analyze(manifest, attempts, oracle, bootstrap_repetitions=10000):
    case_ids = [e['caseId'] for e in manifest]
    if len(case_ids) != len(set(case_ids)): raise ValueError('duplicate manifest case')
    labels = {r['caseId']: r for r in oracle}
    if len(labels) != len(oracle) or set(case_ids) != set(labels): raise ValueError('oracle grid mismatch')
    seen = [(r['caseId'],r['methodId']) for r in attempts]
    if len(seen) != len(set(seen)): raise ValueError('duplicate analysis method/case')
    if any(r['caseId'] not in labels for r in attempts): raise ValueError('unregistered attempt')
    methods = sorted({r['methodId'] for r in attempts})
    metrics = {method: _method_metrics(manifest, [r for r in attempts if r['methodId']==method], labels) for method in methods}
    by_family, by_source = {}, {}
    for field, target in [('family', by_family), ('sourceGroup', by_source)]:
        for group in sorted({e.get(field,'unknown') for e in manifest}):
            entries = [e for e in manifest if e.get(field,'unknown')==group]
            ids = {e['caseId'] for e in entries}
            target[group] = {method: _method_metrics(entries,[r for r in attempts if r['methodId']==method and r['caseId'] in ids],labels) for method in methods}
    overlap = Counter()
    for label in oracle:
        invariants = sorted({r['invariant'] for r in label.get('relations',[]) if r['status']!='ESTABLISHED'})
        for left in invariants:
            for right in invariants: overlap[left+'|'+right] += 1
    return {'schemaVersion': 1, 'cases': len(manifest), 'methodOutputs': len(attempts),
            'baseClusters': len({(e.get('sourceGroup'),e.get('baseId',e['caseId'])) for e in manifest}),
            'methods': metrics, 'byFamily': by_family, 'bySource': by_source,
            'obligationOverlapCases': dict(sorted(overlap.items())),
            'pairedBootstrap': _paired_bootstrap(manifest,attempts,labels,bootstrap_repetitions),
            'interpretation': 'Seed/base-conditional intervals; template topology is shared. Degenerate intervals do not establish population certainty. Execution failures count as unsuccessful completion, never as correct rejections.'}


def _jsonl(path):
    return [json.loads(line) for line in Path(path).read_text(encoding='utf-8-sig').splitlines() if line.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--campaign', type=Path, required=True)
    parser.add_argument('--oracle', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    campaign = json.loads((args.campaign/'campaign.json').read_text(encoding='utf-8-sig'))
    manifest_path = args.campaign/campaign['manifestPath']
    manifest = _jsonl(manifest_path)
    summary = analyze(manifest,_jsonl(args.campaign/'attempts.jsonl'),_jsonl(args.oracle))
    summary['campaignId'] = campaign['campaignId']
    summary['inputSha256'] = {name:hashlib.sha256(path.read_bytes()).hexdigest() for name,path in
                             [('manifest',manifest_path),('attempts',args.campaign/'attempts.jsonl'),('oracle',args.oracle)]}
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out/'summary.json').write_text(json.dumps(summary,indent=2,sort_keys=True)+'\n',encoding='utf-8')
    for filename, field in [('by-family.csv','byFamily'),('by-source.csv','bySource')]:
        with (args.out/filename).open('w',newline='',encoding='utf-8') as stream:
            writer=csv.writer(stream);writer.writerow(['group','method','cases','authorization_correct','invalid_false_authorized','invalid_cases','valid_false_rejected','valid_cases','execution_failures'])
            for group,items in summary[field].items():
                for method,item in items.items():writer.writerow([group,method,item['registeredCases'],item['authorizationAccuracy']['numerator'],item['falseAuthorization']['numerator'],item['falseAuthorization']['denominator'],item['falseRejection']['numerator'],item['falseRejection']['denominator'],item['executionFailures']])
    (args.out/'paired-bootstrap.json').write_text(json.dumps(summary['pairedBootstrap'],indent=2)+'\n',encoding='utf-8')
    (args.out/'obligation-overlap.json').write_text(json.dumps(summary['obligationOverlapCases'],indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'campaignId':campaign['campaignId'],'cases':summary['cases'],'outputs':summary['methodOutputs'],'methods':{m:{'accuracy':v['authorizationAccuracy'],'falseAuthorization':v['falseAuthorization'],'executionFailures':v['executionFailures']} for m,v in summary['methods'].items()}}))


if __name__ == '__main__': main()
