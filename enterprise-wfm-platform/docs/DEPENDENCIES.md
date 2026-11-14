# Dependencies: lock, bill of materials, vulnerability scan

## Engine (Python)

| File | What it is |
| --- | --- |
| `backend/engine/requirements.txt` | the packages the engine asks for, each at one exact version (plus the test tools: pytest, cryptography) |
| `backend/engine/requirements.lock` | everything the engine runs on, direct and indirect, at exact versions, with the SHA-256 of every file PyPI publishes for each; resolved for Linux, Python 3.12 |
| `backend/engine/requirements-dev.lock` | the same plus the test tools |
| `docs/sbom/engine.cdx.json` | CycloneDX 1.5 bill of materials for the lock: versions, package URLs, hashes, licenses, what depends on what |

The Docker image installs the lock with `pip install --require-hashes --no-deps -r requirements.lock`: a package that is not listed, or whose file does not match, is refused.

```
python tools/lock.py                        # rebuild both locks from requirements.txt (needs pypi.org)
python tools/lock.py --check                # exit 1 if they no longer match requirements.txt
python tools/lock.py --platform win32 --out <folder>    # the same set for a Windows machine, written elsewhere
python tools/sbom.py                        # rebuild docs/sbom/engine.cdx.json from the lock
pip-audit -r requirements.lock --disable-pip --require-hashes      # known vulnerabilities in the lock
```

Rules: change a pin in `requirements.txt`, run `tools/lock.py`, the tests (`test_dependencies.py`, `test_library_contract.py`, the suite), and `tools/sbom.py`; follow `UPGRADING.md` for solver
libraries. Regenerate `wfm_pb2*.py` with the LOCKED `grpcio-tools` (stubs from a newer one demand a newer protobuf than the lock allows; `test_dependencies.py` checks this).

**Found while building this:** the previous pins could not be installed by pip at all (`ResolutionImpossible`): OR-Tools 9.15 needs protobuf below 6.34, and the pinned grpcio-tools 1.83
needs protobuf 7. The set is now protobuf 6.33.6 with grpcio and grpcio-tools 1.80.1 (the newest pair that accepts it). The first scan also found setuptools 84.0.0 vulnerable
(GHSA-xmj3-9gf7-h52w), pinned to 84.1.0. Current scan: no known vulnerabilities in the engine lock. The engine suite passes on a clean virtual environment built from the lock.

## Gateway and admin app (Node)

`docs/sbom/gateway.cdx.json` and `docs/sbom/admin-ui.cdx.json` (CycloneDX, production dependencies) come from `npm sbom --sbom-format cyclonedx --omit dev` (add `--package-lock-only` for
the gateway; the admin app's lock file is missing an optional platform package, so its SBOM is made from the installed tree).
`npm audit --omit dev` was run. Fixed by updating the lock files within their allowed ranges: body-parser, qs, source-map-js. **Still open** (each needs a major version change that has to
be tested for behaviour, so they were left for a decision, not slipped in): gateway `nodemailer` (high; 6 to 7+), `zod` (high; 3 to 4), `date-holidays` (low; through its own dependencies);
admin app `vite` (high; affects the development server only, not what is shipped), `exceljs`/`uuid` (moderate).

## Timefold service (Java)

`backend/timefold-service/pom.xml` pins every direct dependency (Timefold Solver Core 1.35.0, Jackson 2.18.2, SLF4J Simple 2.0.16). `docs/sbom/timefold.cdx.json` is the CycloneDX SBOM
(`mvn org.cyclonedx:cyclonedx-maven-plugin:makeAggregateBom`). Maven Central is the only source. **Scanned against the OSV database (2026-11-07):** the first scan found 17 advisories in Jackson 2.18.2 (databind 13, core 4); Jackson was moved to 2.21.8, and the rescan of all 19 components
found none. OSV is queried by package URL (`api.osv.dev/v1/querybatch`, one request listing every component in the SBOM): repeat it whenever the pom changes. Timefold 2.x exists; 1.35.0 was used because the constraint API used here is the one this code was written and tested against.
