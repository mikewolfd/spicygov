"""Time maintained restore calls without changing acceptance, policies or values."""
import argparse
import cProfile
import importlib.util
import hashlib
import json
import pstats
import resource
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]

def child(case_index, output, profile):
 sys.path.insert(0,str(ROOT/'scripts'))
 spec=importlib.util.spec_from_file_location('diagnostic_coverage_bridge',ROOT/'scripts/restore_source_navigation_coverage.py')
 bridge=importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
 from spicy_regs import etl_bulk, etl_receipts
 from spicy_regs.transforms import regulations_shape
 case=json.loads((HERE/'samples.json').read_text())['cases'][case_index]
 output.mkdir(parents=True,exist_ok=False)
 request={key:case[key] for key in ('dataset','generationId','subjects','receipts')}
 request['subjects']=[dict(member,path=str(HERE/member['path'])) for member in request['subjects']]
 request['receipts']=dict(request['receipts'],path=str(HERE/request['receipts']['path']))
 request['destination']=str(output/'restored')
 (output/'request.json').write_text(json.dumps(request,indent=2)+'\n')
 events=[]; counts=Counter()
 def measure(module,name,*,generator=False,loaded=False):
  original=getattr(module,name)
  def finish(start,usage,state,error=None):
   stop=resource.getrusage(resource.RUSAGE_SELF)
   event={'phase':module.__name__+'.'+name,'status':state,'seconds':time.monotonic()-start,
    'userCpuSeconds':stop.ru_utime-usage.ru_utime,'systemCpuSeconds':stop.ru_stime-usage.ru_stime,
    'processPeakRss':stop.ru_maxrss,'processPeakRssUnit':'bytes' if sys.platform=='darwin' else 'KiB',
    'timingSemantics':'inclusive; nested stages overlap'}
   if error is not None: event.update(errorType=type(error).__name__,error=str(error))
   events.append(event)
   with (output/'phases.jsonl').open('a') as stream: stream.write(json.dumps(event,sort_keys=True)+'\n')
  def wrapped(*args,**kwargs):
   counts[module.__name__+'.'+name+'.calls']+=1
   start=time.monotonic(); usage=resource.getrusage(resource.RUSAGE_SELF)
   with (output/'phases.jsonl').open('a') as stream: stream.write(json.dumps({'phase':module.__name__+'.'+name,'status':'running'})+'\n')
   try:
    result=original(*args,**kwargs)
    if loaded:
     counts[module.__name__+'.'+name+'.loadedRows']+=args[0].execute('SELECT count(*) FROM receipts').fetchone()[0]
   except BaseException as error:
    finish(start,usage,'failed',error); raise
   finish(start,usage,'passed'); return result
  def yielded(*args,**kwargs):
   counts[module.__name__+'.'+name+'.calls']+=1
   start=time.monotonic(); usage=resource.getrusage(resource.RUSAGE_SELF)
   active_wall=active_user=active_system=0.0
   iterator=iter(original(*args,**kwargs))
   with (output/'phases.jsonl').open('a') as stream: stream.write(json.dumps({'phase':module.__name__+'.'+name,'status':'running'})+'\n')
   try:
    while True:
     before=time.monotonic(); cpu=resource.getrusage(resource.RUSAGE_SELF)
     try: result=next(iterator)
     except StopIteration: break
     finally:
      after=resource.getrusage(resource.RUSAGE_SELF)
      active_wall+=time.monotonic()-before
      active_user+=after.ru_utime-cpu.ru_utime; active_system+=after.ru_stime-cpu.ru_stime
     counts[module.__name__+'.'+name+'.yieldedRows']+=1
     yield result
   except BaseException as error:
    finish(start,usage,'failed',error); raise
   else: finish(start,usage,'passed')
   finally:
    active={'phase':module.__name__+'.'+name+'.active_next','seconds':active_wall,
      'userCpuSeconds':active_user,'systemCpuSeconds':active_system,
      'timingSemantics':'Only next(iterator), excluding suspended caller visitor/reproduction/write work'}
    events.append(active)
    with (output/'phases.jsonl').open('a') as stream: stream.write(json.dumps(active,sort_keys=True)+'\n')
  setattr(module,name,yielded if generator else wrapped)
  return getattr(module,name)
 for module,name in ((etl_bulk,'_check_receipts'),(etl_bulk,'_check_subjects'),(etl_bulk,'validate_bundle'),
                     (etl_receipts,'_validate_receipt_bundle_rows')): measure(module,name)
 # Both modules hold their own reference to the row loader; record both.
 measure(etl_bulk,'_load_receipts',loaded=True); measure(etl_receipts,'_load_receipts',loaded=True)
 measure(etl_receipts,'_joined_subjects',generator=True)
 admission=measure(etl_receipts,'validate_receipt_bundle')
 bridge.regulations_bulk.validate_receipt_bundle=admission
 # Time the complete bridge restoration/visitor and preserve its normal diagnostics.
 measure(bridge,'write_regulatory_facts')
 measure(bridge.regulations_bulk,'_materialize_selected')
 measure(bridge,'selected_inputs')
 measure(bridge,'restored_facts')
 aggregates={}
 def aggregate(module,name):
  original=getattr(module,name); key=getattr(module,'__name__',type(module).__name__)+'.'+name
  record=aggregates.setdefault(key,{'calls':0,'seconds':0.0,'failedCalls':0})
  def wrapped(*args,**kwargs):
   before=time.monotonic(); record['calls']+=1
   try: return original(*args,**kwargs)
   except BaseException: record['failedCalls']+=1; raise
   finally: record['seconds']+=time.monotonic()-before
  setattr(module,name,wrapped); return wrapped
 shaped=aggregate(regulations_shape,'shape_record')
 bridge.regulations_receipts.shape_record=shaped
 aggregate(bridge.regulations_bulk,'decode_exact_json')
 aggregate(etl_receipts,'_index_processing')
 aggregate(etl_receipts.ReceiptContext,'__post_init__')
 start=time.monotonic(); usage=resource.getrusage(resource.RUSAGE_SELF); status='passed'; error=None
 profiler=cProfile.Profile() if profile else None
 try:
  result=profiler.runcall(bridge.restore,request) if profiler else bridge.restore(request)
  if result['rows']!=case['sampleAcceptedRows']: raise ValueError('Complete admitted sample row count differs')
  (output/'restore.json').write_text(json.dumps(result,indent=2)+'\n')
 except BaseException as failure:
  status='failed'; error={'errorType':type(failure).__name__,'error':str(failure)}
 finally:
  stop=resource.getrusage(resource.RUSAGE_SELF)
  if profiler:
   profiler.dump_stats(str(output/'restore.prof'))
   with (output/'profile.txt').open('w') as stream: pstats.Stats(profiler,stream=stream).strip_dirs().sort_stats('cumulative').print_stats(100)
  summary={'dataset':case['dataset'],'sampleAcceptedRows':case['sampleAcceptedRows'],'profiled':profile,
   'status':status,'seconds':time.monotonic()-start,'userCpuSeconds':stop.ru_utime-usage.ru_utime,
   'systemCpuSeconds':stop.ru_stime-usage.ru_stime,'counts':dict(counts),'phases':events,
   'receiptOutcomes':case['outcomes'],'qualificationScope':'Complete admitted sampled subset only',
   'fallbackObservation':'Full validator row fallback is measured by _validate_receipt_bundle_rows calls; SQL-unproven row fallback is measured by etl_bulk._load_receipts.loadedRows, including zero only after completion.',
   'aggregates':aggregates,'aggregateTimingSemantics':'Inclusive function wall times; shape may overlap row visitor, witness context may overlap row admission. Do not add nested times.',
   'sqlUnprovenSubjectRows':'not measured; receipt fallback counts do not establish this count',
   'error':error}
  (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 if status!='passed': raise RuntimeError(error)


def main():
 parser=argparse.ArgumentParser(); parser.add_argument('--out',type=Path,required=True)
 parser.add_argument('--case',type=int); parser.add_argument('--profile',action='store_true'); args=parser.parse_args()
 if args.case is not None: return child(args.case,args.out.resolve(),args.profile)
 output=args.out.resolve(); output.mkdir(parents=True,exist_ok=False)
 cases=json.loads((HERE/'samples.json').read_text())['cases']; started=time.monotonic(); results=[]
 (output/'settings.json').write_text(json.dumps({'script':str(Path(__file__).resolve()),'python':sys.version,'aggregateSeconds':480,'sequential':True,'sourceReader':'032c5a2ef9da7754a74be911254ccffc8dddfe53', 'inputDigests':{str(p.relative_to(ROOT)):'sha256:'+hashlib.sha256(p.read_bytes()).hexdigest() for p in (Path(__file__).resolve(), HERE/'samples.json', HERE/'PREREGISTRATION.md', ROOT/'scripts/restore_source_navigation_coverage.py')}},indent=2)+'\n')
 for index,case in enumerate(cases):
  for profile in ([False,True] if case['sampleAcceptedRows']==2000 else [False]):
   destination=output/(case['dataset']+'-'+str(case['sampleAcceptedRows'])+('-profile' if profile else ''))
   limit=min(60 if profile or case['sampleAcceptedRows']==2000 else 90,480-(time.monotonic()-started))
   if limit<=0:
    results.append({'dataset':case['dataset'],'sampleAcceptedRows':case['sampleAcceptedRows'],'profiled':profile,'status':'not-run','reason':'aggregate bound reached'}); continue
   command=[sys.executable,str(Path(__file__).resolve()),'--out',str(destination),'--case',str(index)]
   if profile: command.append('--profile')
   entry={'dataset':case['dataset'],'sampleAcceptedRows':case['sampleAcceptedRows'],'profiled':profile,'timeoutSeconds':limit}
   before=time.monotonic()
   try:
    result=subprocess.run(command,capture_output=True,text=True,timeout=limit)
    entry.update(status='passed' if result.returncode==0 else 'failed',returncode=result.returncode)
    stdout,stderr=result.stdout,result.stderr
   except subprocess.TimeoutExpired as error:
    entry.update(status='timeout'); stdout=error.stdout or b''; stderr=error.stderr or b''
   destination.mkdir(parents=True,exist_ok=True)
   for name,value in [('stdout.log',stdout),('stderr.log',stderr)]:
    (destination/name).write_bytes(value.encode() if isinstance(value,str) else value)
   entry['seconds']=time.monotonic()-before; results.append(entry)
   (output/'runs.json').write_text(json.dumps(results,indent=2)+'\n')
   print(json.dumps(entry),flush=True)
 (output/'runs.json').write_text(json.dumps(results,indent=2)+'\n')
 if len(results)!=15 or any(result['status']!='passed' for result in results): raise SystemExit(1)

if __name__=='__main__': main()
