# ECQ v37 observed research record

Qualification method and input freeze: `58d9f19808e3b009f8b19dc86ff6aa1f750e01f1`. The separate bounded cost freeze is `65ae0b25f75c9d3dc1e7de97b3a8c69b83917141`.

| Batch | Cases and grouping units | Method outputs |
|---|---|---:|
| challenge-v2 | 900 cases from 60 controlled bases | 3,600 |
| external-v2 | 240 cases from 40 CI source runs; 40 originals and 200 transformations | 960 |
| ablation-v2 | Same 900 cases and 60 bases; eight family removals | 7,200 |
| historical-v2 | Three heterogeneous archival mappings, outside the primary denominators | 12 |

`prior-v1.zip` contains the complete original code, inputs, outputs and analyses. All 11,760 corresponding V1/V2 semantic outputs agree. These repeated executions are not pooled as independent trials.

The controlled corpus additionally contains 300 development cases from 20 bases. The external corpus additionally contains 120 development cases from 20 source runs. Independent labels are stored separately from method-visible bundles.

Each final qualification batch retains its attempt ledger, exact input grid, analysis and `raw-evidence.zip`. ZIP members preserve original `raw/*` paths; ZIP-only verification checks stream-to-ledger agreement. Source workflows, raw API responses and mapping witnesses identify each original subject. See `RESULTS.json` and the batch analyses for raw numerators and denominators.

From the repository root, verify a batch with:

```powershell
python scripts/ecq/verify-campaign.py --campaign artifacts/paper-revision/ecq-v37/challenge-v2 --freeze docs/paper-material/revision-v37/FREEZE.json
```

`legacy/` retains both original component archives and report-level W0/W2 materials. Their 750 component arm observations are separate from the ECQ case counts. No desktop control or paid model API experiment was run. The observer reads owned local packages. Each published raw ZIP was compared byte for byte before the redundant physical stream directories were moved to a local backup.
