import os,sys,time,math
sys.path.insert(0,os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..'))
from datetime import date,timedelta
from collections import defaultdict
import staffing, wfm_pb2
SHR=float(sys.argv[1]) if len(sys.argv)>1 else 0.30
resp=wfm_pb2.SeriesResponse(); resp.ParseFromString(open('fc.bin','rb').read())
fc=resp.series[0]
req=wfm_pb2.StaffingRequest(interval_min=15,shrinkage=SHR)
req.params.add(channel='voice',service_level=0.8,answer_sec=20,occupancy_cap=0.85,method='erlang_c')
for s in fc.slots: req.inputs.add(channel='voice',day=s.day,slot=s.slot,volume=s.volume,aht_sec=s.aht_sec)
out=staffing.staff_intervals(req)
need=defaultdict(int); base=defaultdict(int); sl=defaultdict(list)
for o in out: need[(o.day,o.slot)]=int(o.required); base[(o.day,o.slot)]=int(o.base); sl[o.day].append(o.service_level)
days=sorted({d for d,_ in need})
print('shrinkage',SHR)
for d in days:
    hrs=sum(need[(d,s)] for s in range(96))/4; peak=max(need[(d,s)] for s in range(96)); low=min(need[(d,s)] for s in range(96))
    print(d,date.fromisoformat(d).strftime('%a'),'required person-hours %6.0f  peak %3d at %s  quietest %3d  avg %5.1f'%(hrs,peak,max(range(96),key=lambda s:need[(d,s)])//4,low,hrs/24))
tot=sum(need.values())/4
print('week required person-hours %.0f ; 355 x 40h = %d ; capacity/required = %.2f'%(tot,355*40,355*40/tot))
import json; json.dump({f'{d}|{s}':need[(d,s)] for (d,s) in need},open('need.json','w'))
