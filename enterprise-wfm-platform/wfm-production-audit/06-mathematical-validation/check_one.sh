#!/bin/sh
# check_one.sh <bundle> <tag>   (run from wfm-production-audit/)
E=17-test-evidence/stage-050
python 06-mathematical-validation/split_bundle.py "$1" $E/sched_$2 >/dev/null && python 06-mathematical-validation/check_schedule_stage.py $E/sched_$2_schedule.json $E/sched_$2_forecast.json 05-synthetic-data-generator/out/TR0042S50 $E/sched_$2_check.json >/dev/null
python - "$E/sched_$2_check.json" "$E/sched_$2_schedule.json" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); s=json.load(open(sys.argv[2]))
st=s['stats']; sv=st.get('solver',{})
print(json.dumps({"plan":c['name'],"wallSec":s.get('wallSec'),"shifts":c['shifts'],"lastDay":c['lastDay'],"people":c['people'],"noShift":c['peopleWithoutShifts'],
 "hardViolations(mine)":c['totalHardViolations'],"byRule":c['hardRuleViolations'],"app.violations":st.get('violations'),"app.verdict":sv.get('verdict',{}).get('status'),
 "app.coverage":st.get('coverage',{}).get('percent'),"mine.appDefinition":c['coverageAppDefinition4w'],"mine.netOnPhone%":c['coverage4w']['coverage%'],
 "contractWeeks":c['contractWeeks'],"solver":sv.get('status'),"backend":sv.get('backend'),"gap":sv.get('gap'),"projectedDays":len(st.get('projectedDays') or []),"hours":st.get('hours')}))
PY
