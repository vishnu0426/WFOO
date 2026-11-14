# Upgrading a library the engine depends on

Every dependency is pinned to an exact version in `requirements.txt`. The solver libraries matter most: a new OR-Tools can change which schedule the same input produces,
how much memory a model needs, or remove a parameter the engine sets.

1. Change the pin (one library at a time) in `requirements.txt`, then run `python tools/lock.py` (writes `requirements.lock` with hashes: see `docs/DEPENDENCIES.md`) and install from the lock into a clean virtual environment.
2. `python -m pytest` in this folder. `test_library_contract.py` fails first if a method or parameter the engine uses has gone, or if the tiny reference problems no longer give
   their known answers.
3. Build a real schedule before and after (for example `qa/scale/scale-test.mjs` for one group) and compare coverage, shifts, `solver.gap` and the time it took.
4. Run `pip-audit -r requirements.lock --disable-pip --require-hashes`, rebuild the bill of materials with `python tools/sbom.py`, and commit the pin, both lock files and the SBOM together with what you compared.

If `grpcio-tools` or `protobuf` change, regenerate the bindings (`python -m grpc_tools.protoc -I ../proto --python_out=. --grpc_python_out=. ../proto/wfm.proto`) and commit them.
