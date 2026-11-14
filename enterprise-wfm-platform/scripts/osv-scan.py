"""Checks every component of a CycloneDX SBOM against the OSV vulnerability database (api.osv.dev), by package URL.

    python scripts/osv-scan.py docs/sbom/timefold.cdx.json     # exits 1 if any component has a known advisory

Needs network access to api.osv.dev only. Run it whenever a pom or lock file changes; it is the scan used for the Java service, which has no pip-audit or npm-audit of its own.
"""
import json
import sys
import urllib.request

path = sys.argv[1] if len(sys.argv) > 1 else "docs/sbom/timefold.cdx.json"
comps = [c for c in json.load(open(path, encoding="utf-8")).get("components", []) if c.get("purl")]
req = urllib.request.Request("https://api.osv.dev/v1/querybatch", data=json.dumps({"queries": [{"package": {"purl": c["purl"]}} for c in comps]}).encode(), headers={"Content-Type": "application/json"})
results = json.load(urllib.request.urlopen(req, timeout=60))["results"]
bad = [(c["purl"], [v["id"] for v in r.get("vulns", [])]) for c, r in zip(comps, results) if r.get("vulns")]
for purl, ids in bad:
    print("VULNERABLE", purl, ", ".join(ids))
print(f"{len(comps)} components checked, {len(bad)} with known advisories")
sys.exit(1 if bad else 0)
