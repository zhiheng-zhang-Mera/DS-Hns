"""Independent executable reference, current source revision v3.

This module is written from the research specification and interface, without
importing either observed implementation. It evaluates received facts, not the
name of an injected transformation. Metadata is joined only after evaluation.
An empty state policy is unresolved, rather than vacuously established.
The frozen predecessor remains reference_labels.py. Legacy output identity
tags are retained for registered-label byte stability; CURRENT_REFERENCE.md
and REFERENCE_SOURCE_VERSION identify this amended implementation.
Python standard library only; MIT, DS-Hns contributors, 2026.
"""
import argparse
import hashlib
import json
from pathlib import Path

ESTABLISHED = 'ESTABLISHED'
VIOLATED = 'VIOLATED'
UNRESOLVED = 'UNRESOLVED'
REFERENCE_SOURCE_VERSION = 'independent-reference-v3'


def _known(value):
    return value is not None


def _combine(statuses):
    states = set(statuses)
    if VIOLATED in states:
        return VIOLATED
    if UNRESOLVED in states:
        return UNRESOLVED
    return ESTABLISHED


def _equal(received, expected):
    if received is None or expected is None:
        return UNRESOLVED
    return ESTABLISHED if received == expected else VIOLATED


def _member(received, permitted):
    if received is None or permitted is None:
        return UNRESOLVED
    return ESTABLISHED if received in permitted else VIOLATED


def _supports(claim, requested, graph):
    if claim is None or requested is None or not isinstance(graph, dict):
        return UNRESOLVED
    if graph.get('nodes') is None or graph.get('edges') is None:
        return UNRESOLVED
    if claim not in graph['nodes'] or requested not in graph['nodes']:
        return VIOLATED
    pending, visited = [claim], set()
    while pending:
        node = pending.pop()
        if node == requested:
            return ESTABLISHED
        if node in visited:
            continue
        visited.add(node)
        pending.extend(target for origin, target in graph['edges'] if origin == node)
    return VIOLATED


def _artifact_facts(reference, root):
    """Read actual bytes independently; inaccessible and confirmed absent differ."""
    availability = reference.get('availability')
    if availability in ('UNAVAILABLE', 'MISSING'):
        return availability, None
    relative = reference.get('path')
    if relative is None:
        return 'UNAVAILABLE', None
    try:
        root = Path(root).resolve()
        path = (root / relative).resolve()
        # A reference outside the evidence package cannot be established by this oracle.
        path.relative_to(root)
        data = path.read_bytes()
        return 'FOUND', hashlib.sha256(data).hexdigest()
    except FileNotFoundError:
        return 'MISSING', None
    except (OSError, ValueError, TypeError):
        return 'UNAVAILABLE', None


def evaluate(bundle, contract, artifact_root):
    """Return relation instances and all three decision axes for actual inputs."""
    records = bundle.get('evidence', [])
    required = [g for g in contract.get('requiredGates', []) if g.get('required') is not False]
    gates = {g['id']: g for g in required}
    relations = []

    def add(invariant, suffix, status, witnesses):
        relations.append({'obligationId': invariant + ':' + suffix,
                          'invariant': invariant, 'status': status,
                          'witnessRefs': sorted(witnesses),
                          'reasonCode': invariant + '_' + status})

    for item in records:
        ident = item['id']
        pointer = '/evidence/' + ident
        policy = contract.get('statePolicy')
        subject = item.get('subject')
        if not isinstance(policy, dict) or not policy or not isinstance(subject, dict):
            state_status = UNRESOLVED
        else:
            state_status = _combine(_equal(subject.get(key), value) for key, value in policy.items())
        add('I_S', 'e:' + ident, state_status, ['/contract/statePolicy', pointer + '/subject'])
        add('I_R', 'e:' + ident,
            _member(item.get('runId'), (contract.get('runPolicy') or {}).get('allowedRunIds')),
            ['/contract/runPolicy', pointer + '/runId'])
        add('I_V', 'e:' + ident,
            _supports(item.get('claimId'), contract.get('requestedClaim'), contract.get('claimGraph')),
            ['/contract/claimGraph', pointer + '/claimId'])
        gate_id = item.get('gateId')
        if gate_id is None:
            binding = UNRESOLVED
        elif gate_id not in gates:
            binding = VIOLATED
        else:
            gate = gates[gate_id]
            binding = _combine([_equal(item.get('claimId'), gate.get('claimId')),
                                _equal(item.get('scope'), gate.get('scope'))])
        add('I_C', 'e:' + ident, binding,
            ['/contract/requiredGates' + ('/' + str(gate_id) if gate_id is not None else ''), pointer + '/binding'])
        types = contract.get('admissibleTypes') or {}
        type_status = _combine([_member(item.get('evidenceType'), types.get('types')),
                                _member(item.get('provenance'), types.get('provenance'))])
        add('I_T', 'e:' + ident, type_status, ['/contract/admissibleTypes', pointer + '/type'])
        references = item.get('artifactRefs') or [{'id': 'required'}]
        for reference in references:
            ref_id = reference['id']
            read_status, actual_digest = _artifact_facts(reference, artifact_root)
            object_status = _equal(reference.get('objectId'), reference.get('expectedObjectId'))
            if read_status == 'MISSING':
                reference_status = VIOLATED
            elif read_status == 'UNAVAILABLE':
                # A known wrong object is a demonstrated violation even if bytes cannot be fetched.
                reference_status = VIOLATED if object_status == VIOLATED else UNRESOLVED
            else:
                reference_status = object_status
            digest_status = _equal(actual_digest, reference.get('sha256'))
            ref_pointer = pointer + '/artifacts/' + ref_id
            suffix = 'a:' + ident + ':' + ref_id
            add('I_E', suffix, reference_status, [ref_pointer])
            add('I_I', suffix, digest_status, [ref_pointer])

    outcomes_by_gate = {g['id']: [e.get('outcome') for e in records if e.get('gateId') == g['id']]
                        for g in required}
    for gate in required:
        add('I_G', 'g:' + gate['id'], ESTABLISHED if outcomes_by_gate[gate['id']] else VIOLATED,
            ['/contract/requiredGates/' + gate['id']])
    outcomes = list(outcomes_by_gate.values())
    if any('FAIL' in values for values in outcomes):
        gate_satisfaction = 'UNSATISFIED'
    elif outcomes and all(values and all(value == 'PASS' for value in values) for values in outcomes):
        gate_satisfaction = 'SATISFIED'
    else:
        gate_satisfaction = 'UNRESOLVED'
    statuses = {relation['status'] for relation in relations}
    closure = 'VIOLATED' if VIOLATED in statuses else 'UNRESOLVED' if UNRESOLVED in statuses else 'CLOSED'
    return {'closureStatus': closure, 'gateSatisfaction': gate_satisfaction,
            'authorizePass': closure == 'CLOSED' and gate_satisfaction == 'SATISFIED',
            'relations': sorted(relations, key=lambda r: r['obligationId']),
            'methodIdentity': 'independent-reference-v1'}


def label_case(construction_facts, change_ledger, contract):
    """Construct gold labels from facts; change ledger is retained but never predicts labels."""
    result = evaluate(construction_facts['bundle'], contract, construction_facts['artifactRoot'])
    return {'expectedClosure': result['closureStatus'],
            'expectedGateSatisfaction': result['gateSatisfaction'],
            'expectedAuthorizePass': result['authorizePass'],
            'relations': result['relations'], 'oracleIdentity': result['methodIdentity']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cases', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    base = args.cases.resolve().parent
    args.out.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for line in args.cases.read_text(encoding='utf-8-sig').splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        bundle = json.loads((base / entry['bundlePath']).read_text(encoding='utf-8-sig'))
        contract = json.loads((base / entry['contractPath']).read_text(encoding='utf-8-sig'))
        result = label_case({'bundle': bundle, 'artifactRoot': base / entry['artifactRoot']}, None, contract)
        result.update({key: entry[key] for key in ('caseId', 'baseId', 'sourceGroup', 'split') if key in entry})
        rows.append(result)
    args.out.write_text(''.join(json.dumps(row, sort_keys=True) + '\n' for row in rows), encoding='utf-8')
    print(json.dumps({'labels': len(rows), 'oracle': 'independent-reference-v1'}))


if __name__ == '__main__':
    main()
