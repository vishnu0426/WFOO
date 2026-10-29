import os,sys,time,pickle
sys.path.insert(0,os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..'))
from datetime import date,timedelta
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import gen, forecasting, wfm_pb2
if __name__=='__main__':
    rows,slots=gen.history()
    q=wfm_pb2.QueueSeries(queue_id=1,name='Inbound',channel='voice')
    for d,v in rows: q.daily.add(day=d.isoformat(),slot=-1,volume=v,aht_sec=180)
    for d,s,v,a in slots: q.slots.add(day=d.isoformat(),slot=s,volume=v,aht_sec=a)
    dates=[(date(2026,11,1)+timedelta(days=i)).isoformat() for i in range(7)]
    req=wfm_pb2.SeriesRequest(dates=dates,slots_per_day=96,model='auto'); req.queues.append(q)
    t=time.time(); resp=forecasting.run(req); print('forecast secs',round(time.time()-t,1))
    fc=resp.series[0]; print('model chosen',fc.model,'sigma_rel',round(fc.sigma_rel,3),'cleaned',fc.cleaned_days)
    for s in fc.scores: print('  %-8s wape %.3f mase %.2f bias %+.3f %s'%(s.model,s.wape,s.mase,s.bias,'<- selected' if s.selected else ''))
    print('notes',list(fc.notes))
    tot_err=0;tot_act=0
    for p in fc.daily:
        d=date.fromisoformat(p.day); truth=gen.day_total(d); act,asl=gen.actual(d)
        print(p.day,d.strftime('%a'),'forecast %7.0f  expected %7.0f  actual %7.0f  err vs actual %+5.1f%%  band %.0f-%.0f  AHT %.0f'%(p.volume,truth,act,100*(p.volume-act)/act,p.p10,p.p90,p.aht_sec))
        tot_err+=abs(p.volume-act);tot_act+=act
    print('7-day WAPE vs noisy actuals: %.2f%%'%(100*tot_err/tot_act))
    # intraday accuracy
    e=a=0
    by={}
    for s in fc.slots: by[(s.day,s.slot)]=s.volume
    for p in fc.daily:
        d=date.fromisoformat(p.day); _,asl=gen.actual(d)
        for s in range(96): e+=abs(by[(p.day,s)]-asl[s]); a+=asl[s]
    print('15-min interval WAPE: %.1f%%'%(100*e/a))
    open('fc.bin','wb').write(resp.SerializeToString())
