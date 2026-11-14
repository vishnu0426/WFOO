"""Software bill of materials for the engine, in CycloneDX 1.5 JSON, from requirements.lock.

    python tools/sbom.py [out.json]        # default: ../../docs/sbom/engine.cdx.json

Every package in the lock appears once, with its exact version, a package URL, the SHA-256 of each published file, its license as PyPI states it, and the packages it depends on, so
a customer's security team (or a vulnerability database) can answer "does this release contain package X at version Y?" without running anything. Needs network access to pypi.org
for the license and dependency data; the versions and hashes come from the lock itself.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "tools"))
from lock import env_for, parse_lock  # noqa: E402


def read_lock(path):
    """{name: (version, [sha256, ...])} from a lock file."""
    text = Path(path).read_text(encoding="utf-8")
    out = {}
    for m in re.finditer(r"^([A-Za-z0-9_.\-]+)==(\S+) \\\n((?:\s+--hash=sha256:[0-9a-f]+(?: \\)?\n?)+)", text, re.M):
        out[m.group(1)] = (m.group(2), re.findall(r"--hash=sha256:([0-9a-f]{64})", m.group(3)))
    return out


def pypi(name, version):
    with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=60) as r:
        return json.load(r)["info"]


def license_of(info):
    expr = info.get("license_expression")
    if expr:
        return {"expression": expr}
    classifiers = [c.split("::")[-1].strip() for c in info.get("classifiers") or [] if c.startswith("License ::") and "OSI Approved" in c]
    if classifiers:
        return {"license": {"name": classifiers[0]}}
    text = (info.get("license") or "").strip()
    return {"license": {"name": text[:120] if text and len(text) < 120 else "see the package"}}


def build(lock_path, platform="linux", python="3.12"):
    pins = read_lock(lock_path)
    env = env_for(platform, python)
    components, deps = [], []
    for name in sorted(pins):
        version, hashes = pins[name]
        info = pypi(name, version)
        ref = f"pkg:pypi/{canonicalize_name(name)}@{version}"
        c = {"type": "library", "bom-ref": ref, "name": name, "version": version, "purl": ref, "hashes": [{"alg": "SHA-256", "content": h} for h in hashes],
             "licenses": [license_of(info)], "externalReferences": [{"type": "distribution", "url": f"https://pypi.org/project/{name}/{version}/"}]}
        if info.get("summary"):
            c["description"] = info["summary"][:300]
        components.append(c)
        needs = []
        for line in info.get("requires_dist") or []:
            r = Requirement(line)
            if (r.marker is None or r.marker.evaluate(env)) and canonicalize_name(r.name) in pins:
                needs.append(f"pkg:pypi/{canonicalize_name(r.name)}@{pins[canonicalize_name(r.name)][0]}")
        deps.append({"ref": ref, "dependsOn": sorted(set(needs))})
    app = "pkg:generic/wfm-planning-engine@1"
    return {"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
            "metadata": {"timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tools": {"components": [{"type": "application", "name": "tools/sbom.py"}]},
                         "component": {"type": "application", "bom-ref": app, "name": "wfm-planning-engine", "version": "1"}},
            "components": components, "dependencies": [{"ref": app, "dependsOn": [c["bom-ref"] for c in components]}] + deps}


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent.parent / "docs" / "sbom" / "engine.cdx.json"
    bom = build(HERE / "requirements.lock")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(bom, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(bom['components'])} components)")


if __name__ == "__main__":
    main()
