import os,sys,time,json
sys.path.insert(0,os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..'))
from collections import defaultdict
from datetime import date,timedelta
import scheduling, wfm_pb2
SPD=96; N=355; DAYS=7; LIMIT=int(sys.argv[1]) if len(sys.argv)>1 else 120; FIRST_DOW=int(sys.argv[2]) if len(sys.argv)>2 else 6
need=json.load(open('need.json')); dates=[(date(2026,11,1)+timedelta(days=i)).isoformat() for i in range(DAYS)]
WS=int(sys.argv[3]) if len(sys.argv)>3 else 0
req=wfm_pb2.ScheduleRequest(days=DAYS,first_dow=FIRST_DOW,week_start=WS,time_limit_sec=LIMIT,w_under=900,w_over=30,w_hours=50,w_pref=0,w_fair=30,workers=8)
for d in dates:
    for s in range(SPD): req.required.append(need[f'{d}|{s}'])
for e in range(N):
    req.employees.add(id=e+1,max_week_slots=160,min_week_slots=160,max_consecutive=6,rest_slots=44,max_days_week=5)
starts=list(range(0,96,4))          # a shift may start at any hour, including nights
for e in range(N):
    for d in range(DAYS):
        for t,st in enumerate(starts):
            req.options.add(employee=e+1,day=d,template=t%3,start_slot=st,length_slots=34,paid_slots=32,preference=0)
print('options',len(req.options),flush=True)
t=time.time(); res=scheduling.solve_period(req); wall=time.time()-t
print('status',res.status,'wall %.0fs'%wall,'gap',res.gap,'assignments',len(res.assignments))
# independent check
per=defaultdict(dict)
for a in res.assignments:
    assert a.day not in per[a.employee]; per[a.employee][a.day]=a
bad=0
for e,sh in per.items():
    ds=sorted(sh)
    for a,b in zip(ds,ds[1:]):
        if b==a+1 and SPD+sh[b].start_slot-(sh[a].start_slot+sh[a].length_slots)<44: bad+=1
    run=1
    for a,b in zip(ds,ds[1:]):
        run=run+1 if b==a+1 else 1
        if run>6: bad+=1
print('rule violations (rest / days in a row):',bad)
# hours per person: Monday-based calendar weeks and the whole 7-day window
win=[sum(32 for _ in per.get(e+1,{}))/4 for e in range(N)]
import collections
print('7-day window paid hours per person:',dict(sorted(collections.Counter(win).items())))
wk=defaultdict(lambda:defaultdict(int))
for e,sh in per.items():
    for d in sh: wk[e][(((FIRST_DOW-WS)%7)+d)//7]+=8
c=collections.Counter()
for e in range(1,N+1):
    c[tuple(sorted(wk[e].items()))]+=1
print('hours per calendar week (week index: hours) -> people:',dict(c.most_common(6)))
# coverage
cov=[0]*(DAYS*SPD)
for a in res.assignments:
    for g in range(a.day*SPD+a.start_slot,min(a.day*SPD+a.start_slot+a.length_slots,DAYS*SPD)): cov[g]+=1
req_=list(req.required); under=sum(max(0,r-c) for r,c in zip(req_,cov)); over=sum(max(0,c-r) for r,c in zip(req_,cov))
print('required person-hours %.0f covered %.1f%% ; shortfall %.0f h ; surplus %.0f h'%(sum(req_)/4,100*(1-under/sum(req_)),under/4,over/4))
for i,d in enumerate(dates):
    r=req_[i*SPD:(i+1)*SPD]; c2=cov[i*SPD:(i+1)*SPD]
    print(d,date.fromisoformat(d).strftime('%a'),'covered %.1f%%  worst slot short by %d  on shift at peak %d (need %d)'%(100*(1-sum(max(0,a-b) for a,b in zip(r,c2))/sum(r)),max(a-b for a,b in zip(r,c2)),max(c2),max(r)))
