# wfm-production-audit

| # | File | State |
|---|---|---|
| 01 | `01-application-architecture.md` | Phase-1 discovery report |
| 02 | `02-module-inventory.xlsx` | Modules, planned test cases, Phase-1 defects (3 sheets) |
| 04 | `04-synthetic-data-specification.md` | Done |
| 05 | `05-synthetic-data-generator/generate.py` | Done, tested 50 → 200k |
| 06 | `06-mathematical-validation/` | Independent maths + golden tests; 34 tests / 531 checks PASS |
| 09 | `09-load-testing-scripts/stages.json` | Stage plan 50 → 200k × horizons 1/4/13/26/52 weeks |
| 17 | `17-test-evidence/` | Server health/metrics snapshot, maths results |
| 18 | `18-test-data-manifest.json` | Nothing written to the server yet |

Other numbered deliverables (03, 07, 08, 10–16, 19, 20) are produced by later phases.

```bash
python -m pytest -q wfm-production-audit/06-mathematical-validation
python wfm-production-audit/05-synthetic-data-generator/generate.py --employees 5000 --seed 42
```
