"""check_batch.py <export.txt> <runDir> <outDir> : run check_schedule_stage on every plan in a multi-plan export."""
import json, subprocess, sys, os
from pathlib import Path
raw = json.load(open(sys.argv[1]))
if isinstance(raw, list) and raw and "text" in raw[0]: raw = json.JSONDecoder().raw_decode(raw[0]["text"].strip())[0]
if isinstance(raw, str): raw = json.JSONDecoder().raw_decode(raw.strip())[0]
out = Path(sys.argv[3]); out.mkdir(parents=True, exist_ok=True)
here = Path(__file__).parent
for item in raw:
    s = item["schedule"]; tag = s["name"].replace(" ", "_")
    json.dump(s, open(out / f"{tag}_schedule.json", "w")); json.dump(item["forecast"], open(out / f"{tag}_forecast.json", "w"))
    subprocess.run([sys.executable, str(here / "check_schedule_stage.py"), str(out / f"{tag}_schedule.json"), str(out / f"{tag}_forecast.json"), sys.argv[2], str(out / f"{tag}_check.json")], capture_output=True, check=True)
    c = json.load(open(out / f"{tag}_check.json")); st = s["stats"]; sv = st.get("solver", {})
    print(json.dumps({"plan": s["name"][11:], "ch": s["channel"], "runSec": s.get("runSec"), "queueSec": s.get("queueSec"), "shifts": c["shifts"], "people": c["people"], "activeNoShift": c.get("activeWithoutShifts"),
        "hardMine": c["totalHardViolations"], "byRule": c["hardRuleViolations"], "hardApp": st.get("violations"), "covApp": st.get("coverage", {}).get("percent"),
        "covMine": c["coverageAppDefinition4w"]["coverage%"], "solver": sv.get("status"), "backend": sv.get("backend"), "gap": sv.get("gap")}))
    os.remove(out / f"{tag}_schedule.json")   # keep the check result, not the 1-2 MB copy
