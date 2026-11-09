import { useEffect, useRef, useState } from 'react';
import type { Dataset, Filter, Row, Join } from '../lib/catalog';
import { pretty, display, count, related, isIncomingJoin, joinTarget, connectionFilters, connectionLabel } from '../lib/catalog';
import { receiptLookup, receiptOnlyFields, type ReceiptProgress } from '../lib/receipt-reader';
import { at, elements, sourceOccurrences, forwardLinks, fccDocumentOutcome, type Connection, type Navigation } from '../lib/navigation';
type Props = {table: Dataset; catalog: Dataset[]; row: Row; joins: Join[]; navigation: Navigation[]; onOpen: (id:string,filters:Filter[],connection?:Connection,detail?:boolean)=>void};
export function FccDocumentReference({link,row,fieldAvailable}:{link:ReturnType<typeof forwardLinks>[number];row:Row;fieldAvailable:boolean}) {
  const outcome=fccDocumentOutcome(link.values[0],row,fieldAvailable);
  const filename=at(link.sourceElement,['filename']),description=at(link.sourceElement,['description']);
  return <>
    {typeof filename==='string'&&<small style={{whiteSpace:'pre-wrap'}}>Offered filename: {filename}</small>}
    {typeof description==='string'&&<small style={{whiteSpace:'pre-wrap'}}>Description: {description}</small>}
    <a href={link.values[0]} target="_blank" rel="noreferrer">Open offered document {link.sourceOrdinal!==undefined?link.sourceOrdinal+1:''}</a>
    <small>{outcome.message}{outcome.pageCount!==undefined&&` ${outcome.pageCount} ${outcome.pageCount===1?'page':'pages'}.`}</small>
    <small>File and text access: not verified.</small>
    {outcome.state==='recorded'&&<details><summary>Recorded details</summary>
      {outcome.sourceSha256&&<small style={{overflowWrap:'anywhere'}}>Recorded source byte SHA-256: {outcome.sourceSha256}</small>}
      {outcome.error&&<small>Reported error: {outcome.error}</small>}
      <small>This filing records an extraction outcome. These fields do not establish access to retained file bytes or extracted text.</small>
    </details>}
  </>;
}
export function SourceConnections({table,catalog,row,joins,navigation,onOpen}: Props) {
  const outgoing=navigation.filter(s=>s.source===table.id), incoming=navigation.flatMap(s=>s.targets.map((t,i)=>({s,t,i}))).filter(({t})=>t.table===table.id);
  const incomingJoins=related(table.id,joins).filter(join=>isIncomingJoin(join,table.id));
  const selection=JSON.stringify([table.id,table.artifactDigest,table.publication?.nativeReceipts?.generationId,table.publication?.nativeReceipts?.sha256]);
  const [busy,setBusy]=useState(false), [error,setError]=useState(''), [evidence,setEvidence]=useState<{records:Row[];partial:boolean;cursor:number;dataset:string;filters:Filter[]}|null>(null);
  const worker=useRef<Worker|null>(null);
  useEffect(()=>{setEvidence(null);setError('');setBusy(false);return()=>worker.current?.terminate();},[row,selection]);
  // Receipt-only container fields plus fields a source reference reads from receipts.
  const wanted=[...new Set([...outgoing.flatMap(s=>s.receiptFields), ...receiptOnlyFields(table)])];
  const details=wanted.length>0&&!!table.publication?.nativeReceipts;
  if(!outgoing.length&&!incoming.length&&!incomingJoins.length&&!details)return null;
  const current=row;
  function readEvidence(dataset:string,filters:Filter[],cursor=0) {
    worker.current?.terminate();setBusy(true);setError('');setEvidence(null);
    const w=new Worker(new URL('../lib/parquet.worker.ts',import.meta.url),{type:'module'});worker.current=w;
    w.onmessage=e=>{if(e.data.type==='source-evidence'){setEvidence(e.data);setBusy(false);w.terminate();}if(e.data.type==='error'){setError(e.data.message);setBusy(false);w.terminate();}};
    w.onerror=()=>{setError('The source evidence reader stopped. Retry this lookup.');setBusy(false);};
    w.postMessage({type:'source-evidence',table,dataset,filters,cursor});
  }
  return <details className="record-connections" open>
    <summary>Source references</summary>
    <div className="record-join-list">
      {outgoing.map(s=>{
        const links=forwardLinks(s,current), state=elements(s,current).state, occurrences=sourceOccurrences(s,current);
        return <div className="source-reference" key={s.id}>
          <p>{s.meaning}</p>
          {state==='ambiguous targets'&&<small>Ambiguous reference: each link is a separate candidate.</small>}
          {links.filter(link=>link.target.table!=='@value').map((link,i)=>link.target.table==='@url'?<div key={i}>
            {s.id==='fcc_filing_documents'&&s.source==='fcc_filings'?<FccDocumentReference link={link} row={row} fieldAvailable={table.columns.some(c=>c.name==='extraction_results')}/>:<><a href={link.values[0]} target="_blank" rel="noreferrer">Open offered document</a><small>Capture and text extraction are not established by this link.</small></>}
          </div>:<button key={i} disabled={!link.target.available||link.target.directions?.forward.available===false} onClick={()=>onOpen(link.target.table,link.filters,undefined,link.target.completeKey===true)}>
            <span>{link.target.table==='@receipt:congress_acquisition'?'Detail read attempts':catalog.find(t=>t.id===link.target.table)?.label??pretty(link.target.table.replace('@receipt:',''))}<small>{link.target.columns.map((c,i)=>`${c}: ${link.values[i]}`).join(' · ')}</small></span>
            {!link.target.available&&<small>Target is not published</small>}
            {link.target.available&&<small>{link.target.completeKey?'Open record · checks for one exact match':'Show related records'}</small>}
          </button>)}
          {occurrences.length>0&&<details><summary>Source occurrences · {occurrences.length}</summary><ol>{occurrences.map((value,i)=><li key={i}><pre className="source-passage">{display(value)}</pre></li>)}</ol></details>}
          {!links.length&&<small>{!s.available?'Source fields are not published yet.':state==='stated'?'No complete, supported target key in this reference.':state==='empty'?'The source lists no references.':state==='unread'?'Not read yet.':state==='not stated'?'The read source states no reference.':state==='unknown read state'?'No reference is stored; the source read state is unknown.':state==='unresolved targets'?'No recorded target identity. See the interpretation and target statuses below.':state==='unsupported shape'?'The stored reference format is unsupported.':state}</small>}
        </div>;
      })}
      {typeof current.record_entry_text==='string'&&current.record_entry_text&&<details><summary>Congressional Record source passage</summary><p>{String(current.record_granule_id??'')}</p><pre className="source-passage">{current.record_entry_text}</pre></details>}
      {details&&<RetainedSourceDetails key={selection} table={table} row={row} fields={wanted}/>}
      {busy&&<p role="status">Reading selected generation evidence…</p>}
      {error&&<p role="alert">{error}</p>}
      {evidence&&<div className="source-reference"><strong>Retained source evidence</strong>{evidence.records.map((r,i)=><dl key={i}>{Object.entries(r).map(([k,v])=><div key={k}><dt>{pretty(k)}</dt><dd>{v==null?'Not stated':display(v)}</dd></div>)}</dl>)}{!evidence.records.length&&<p>{evidence.partial?'No match in the checked receipt rows. The search is incomplete.':'No matching source evidence in this selected generation.'}</p>}{evidence.partial&&<button disabled={busy} onClick={()=>readEvidence(evidence.dataset,evidence.filters,evidence.cursor)}>Continue checking source evidence</button>}</div>}
      {(incoming.length>0||incomingJoins.length>0)&&<details open><summary>Records that reference this record</summary>
        {incomingJoins.map((join,i)=>{
          const target=joinTarget(join,table.id), dataset=catalog.find(d=>d.id===target.id), filters=connectionFilters(join,table.id,row);
          return <button key={`join:${i}`} disabled={!filters||!dataset||join.directions?.reverse.available===false} onClick={()=>{if(filters)onOpen(target.id,filters);}} title={join.reason||`Join on ${target.local.join(', ')}`}>
            <span>{connectionLabel(join,dataset?.label??pretty(target.id))}<small>{!filters?'This row has no complete target key.':!dataset?'Source is not published.':join.directions?.reverse.available===false?'This connection is unavailable for the selected publication.':`Show related records · ${target.local.map(column=>`${column}: ${display(row[column])}`).join(' · ')}`}</small></span>
          </button>;
        })}
        {incoming.map(({s,t,i})=>{
          const values=t.columns.map(c=>row[c]), complete=values.every(v=>v!=null&&['string','number','bigint'].includes(typeof v));
          return <button key={`${s.id}:${i}`} disabled={!complete||!t.available||t.directions?.reverse.available===false} onClick={()=>onOpen(s.source,[],{id:s.id,target:i,values:values.map(String)})}><span>{catalog.find(d=>d.id===s.source)?.label??pretty(s.source)}<small>{!complete?'This row has no complete target key.':!t.available?'Source keys are not published.':'Show related records listing this exact key.'}</small></span></button>;
        })}
      </details>}
    </div>
  </details>;
}

const STEP_LABEL: Record<ReceiptProgress['step'], string> = {scan:'Checking receipts for this record'};
const preview = (fields: string[]) => fields.slice(0,6).map(pretty).join(', ')+(fields.length>6?`, and ${fields.length-6} more`:'');
const missing = (asked: string[], found: Row) => {const absent=asked.filter(name=>!(name in found));return absent.length>0&&<small>Not stated in this receipt: {absent.map(pretty).join(', ')}.</small>;};
const megabytes = (bytes: number) => `up to ${new Intl.NumberFormat('en-US',{maximumFractionDigits:bytes<1e7?1:0}).format(bytes/1e6)} MB`;
const link = (value: unknown) => typeof value==='string'&&/^https?:\/\/[^\s]+$/.test(value);
/** One record's receipt lookup: each read starts its own worker, so Stop and leaving the record end it. */
export function RetainedSourceDetails({table,row,fields}:{table:Dataset;row:Row;fields:string[]}) {
  type State = {state:'idle'|'stopped'} | {state:'reading';progress?:ReceiptProgress} | {state:'read';fields:Row} | {state:'error';message:string};
  const [lookup,setLookup]=useState<State>({state:'idle'}), worker=useRef<Worker|null>(null);
  const pin=table.publication?.nativeReceipts, plan=receiptLookup(pin);
  useEffect(()=>{setLookup({state:'idle'});return()=>{worker.current?.terminate();worker.current=null;};},[row]);
  function read() {
    worker.current?.terminate();setLookup({state:'reading'});
    const w=new Worker(new URL('../lib/parquet.worker.ts',import.meta.url),{type:'module'});worker.current=w;
    const end=(next:State)=>{w.terminate();if(worker.current===w)worker.current=null;setLookup(next);};
    w.onmessage=e=>{
      if(e.data.type==='progress')setLookup({state:'reading',progress:{step:e.data.step,checked:e.data.checked,total:e.data.total}});
      if(e.data.type==='receipt')end({state:'read',fields:e.data.fields});
      if(e.data.type==='error')end({state:'error',message:e.data.message});
    };
    w.onerror=()=>end({state:'error',message:'The receipt reader stopped. Retry this lookup.'});
    w.postMessage({type:'receipt',table,row,fields});
  }
  function stop() {worker.current?.terminate();worker.current=null;setLookup({state:'stopped'});}
  const reading=lookup.state==='reading'?lookup.progress:undefined;
  return <div className="source-reference receipt-lookup">
    <button disabled={plan.path==='refused'||lookup.state==='reading'} onClick={read}><span>Read retained source details<small>{preview(fields)}</small></span></button>
    {plan.path==='refused'?<small>{plan.reason}</small>
      :<small>Finds this record’s receipt by its exact identity and publication generation, reading only the parts of the receipt file that can hold it: usually 1–2 MB, never more than {megabytes(pin!.bytes).replace('up to ','')}.</small>}
    {lookup.state==='reading'&&<div className="receipt-progress" role="status">
      <span className="loader"/>
      <span>{reading?STEP_LABEL[reading.step]:'Starting the receipt reader'}{reading?` · up to row ${count(reading.checked)} of ${count(reading.total)}`:'…'}</span>
      <button onClick={stop}>Stop</button>
      {reading&&<progress max={reading.total} value={reading.checked} aria-label="Receipt file position"/>}
    </div>}
    {lookup.state==='stopped'&&<small role="status">Reading stopped. Nothing was kept; read again to retry.</small>}
    {lookup.state==='error'&&<p role="alert">{lookup.message}</p>}
    {lookup.state==='read'&&(Object.keys(lookup.fields).length?<details open><summary>Retained source details</summary><dl>{Object.entries(lookup.fields).map(([key,value])=><div key={key}><dt>{pretty(key)}</dt><dd>{link(value)?<a href={value as string} target="_blank" rel="noreferrer">{value as string}</a>:display(value)}</dd></div>)}</dl>{missing(fields,lookup.fields)}<small>These details are evidence for this record. Navigation uses its published main fields.</small></details>
      :<small role="status">The matching receipt holds none of these details.</small>)}
  </div>;
}
