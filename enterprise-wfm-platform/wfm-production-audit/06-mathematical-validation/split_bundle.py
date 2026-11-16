"""Split a browser-tool export bundle {schedule, forecast} into two JSON files: split_bundle.py <bundle.txt> <outPrefix>"""
import json, sys
raw = json.load(open(sys.argv[1]))
if isinstance(raw, list):
    raw = json.JSONDecoder().raw_decode(raw[0]["text"].strip())[0]
if isinstance(raw, str):
    raw = json.loads(raw)
json.dump(raw["schedule"], open(sys.argv[2] + "_schedule.json", "w"))
json.dump(raw["forecast"], open(sys.argv[2] + "_forecast.json", "w"))
print("shifts", len(raw["schedule"]["sh"]), "weeks", raw["schedule"]["weeks"])
