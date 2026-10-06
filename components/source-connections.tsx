import { useEffect, useRef, useState } from 'react';
import type { Dataset, Filter, Row } from '../lib/catalog';
import { pretty, display } from '../lib/catalog';
import { at, elements, forwardLinks, fccDocumentOutcome, type Connection, type Navigation } from '../lib/navigation';
type Props = {table: Dataset; catalog: Dataset[]; row: Row; navigation: Navigation[]; onOpen: (id:string,filters:Filter[],connection?:Connection,detail?:boolean)=>void};
export function FccDocumentReference({link,receipt,fieldAvailable}:{link:ReturnType<typeof forwardLinks>[number];receipt:Row;fieldAvailable:boolean}) {
  const outcome=fccDocumentOutcome(link.values[0],receipt,fieldAvailable);
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
      <small>This selected receipt records an extraction outcome. These fields do not establish access to retained file bytes or extracted text.</small>
    </details>}
  </>;
}
export function SourceConnections({table,catalog,row,navigation,onOpen}: Props) {
  const outgoing=navigation.filter(s=>s.source===table.id), incoming=navigation.flatMap(s=>s.targets.map((t,i)=>({s,t,i}))).filter(({t})=>t.table===table.id);
  const selection=JSON.stringify([table.id,table.artifactDigest,table.publication?.nativeReceipts?.generationId,table.publication?.nativeReceipts?.sha256]);
  const [receipt,setReceipt]=useState<{row:Row;selection:string;fields:Row}|null>(null), [busy,setBusy]=useState(false), [error,setError]=useState(''), [evidence,setEvidence]=useState<{records:Row[];partial:boolean;cursor:number;dataset:string;filters:Filter[]}|null>(null);
  const held=receipt?.row===row&&receipt.selection===selection?receipt.fields:{};
  const worker=useRef<Worker|null>(null);
  useEffect(()=>{setReceipt(null);setEvidence(null);setError('');setBusy(false);return()=>worker.current?.terminate();},[row,selection]);
  if(!outgoing.length&&!incoming.length)return null;
  const wanted=[...new Set([...outgoing.flatMap(s=>s.receiptFields), ...(Object.values(table.receiptContainers??{}).some(fields=>fields.includes('detail_read')) ? ['detail_read'] : [])])];
  const current=row;
  function load() {
    worker.current?.terminate();setBusy(true);setError('');
    const w=new Worker(new URL('../lib/parquet.worker.ts',import.meta.url),{type:'module'});worker.current=w;
    w.onmessage=e=>{if(e.data.type==='receipt'){setReceipt({row,selection,fields:e.data.fields});setBusy(false);w.terminate();}if(e.data.type==='error'){setError(e.data.message);setBusy(false);w.terminate();}};
    w.onerror=()=>{setError('The receipt reader stopped. Retry this lookup.');setBusy(false);};
    w.postMessage({type:'receipt',table,row,fields:wanted});
  }
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
        const links=forwardLinks(s,current), state=elements(s,current).state;
        return <div className="source-reference" key={s.id}>
          <p>{s.meaning}</p>
          {state==='ambiguous targets'&&<small>Ambiguous reference: each link is a separate candidate.</small>}
          {links.map((link,i)=>link.target.table==='@url'?<div key={i}>
            {s.id==='fcc_filing_documents'&&s.source==='fcc_filings'?<FccDocumentReference link={link} receipt={held} fieldAvailable={s.receiptFields.includes('pdf_extraction_results_json')}/>:<><a href={link.values[0]} target="_blank" rel="noreferrer">Open offered document</a><small>Capture and text extraction are not established by this link.</small></>}
          </div>:<button key={i} disabled={!link.target.available||link.target.directions?.forward.available===false} onClick={()=>onOpen(link.target.table,link.filters,undefined,link.target.completeKey===true)}>
            <span>{link.target.table==='@receipt:congress_acquisition'?'Detail read attempts':catalog.find(t=>t.id===link.target.table)?.label??pretty(link.target.table.replace('@receipt:',''))}<small>{link.target.columns.map((c,i)=>`${c}: ${link.values[i]}`).join(' · ')}</small></span>
            {!link.target.available&&<small>Target is not published</small>}
            {link.target.available&&<small>{link.target.completeKey?'Open record · checks for one exact match':'Show related records'}</small>}
          </button>)}
          {elements(s,current).values.length>0&&<details><summary>Source occurrences · {elements(s,current).values.length}</summary><ol>{elements(s,current).values.map((value,i)=><li key={i}><pre className="source-passage">{display(value)}</pre></li>)}</ol></details>}
          {!links.length&&<small>{!s.available?'Source fields are not published yet.':state==='stated'?'No complete, supported target key in this reference.':state==='empty'?'The source lists no references.':state==='unread'?'Not read yet.':state==='not stated'?'The read source states no reference.':state==='unknown read state'?'No reference is stored; the source read state is unknown.':state==='unresolved targets'?'No recorded target identity. See the interpretation and target statuses below.':state==='unsupported shape'?'The stored reference format is unsupported.':state}</small>}
        </div>;
      })}
      {typeof current.record_entry_text==='string'&&current.record_entry_text&&<details><summary>Congressional Record source passage</summary><p>{String(current.record_granule_id??'')}</p><pre className="source-passage">{current.record_entry_text}</pre></details>}
      {wanted.length>0&&table.publication?.nativeReceipts&&<div className="source-reference"><button disabled={busy} onClick={load}>{busy?'Reading matching receipt…':'Read retained source details'}</button><small>Uses this record’s exact identity and publication generation.</small></div>}
      {Object.keys(held).length>0&&<details><summary>Retained source details</summary><dl>{Object.entries(held).map(([key,value])=><div key={key}><dt>{pretty(key)}</dt><dd>{display(value)}</dd></div>)}</dl><small>These details are evidence for this record. Navigation uses its published main fields.</small></details>}
      {busy&&<p role="status">Reading selected generation evidence…</p>}
      {error&&<p role="alert">{error}</p>}
      {evidence&&<div className="source-reference"><strong>Retained source evidence</strong>{evidence.records.map((r,i)=><dl key={i}>{Object.entries(r).map(([k,v])=><div key={k}><dt>{pretty(k)}</dt><dd>{v==null?'Not stated':display(v)}</dd></div>)}</dl>)}{!evidence.records.length&&<p>{evidence.partial?'No match in the checked receipt rows. The search is incomplete.':'No matching source evidence in this selected generation.'}</p>}{evidence.partial&&<button disabled={busy} onClick={()=>readEvidence(evidence.dataset,evidence.filters,evidence.cursor)}>Continue checking source evidence</button>}</div>}
      {incoming.length>0&&<details><summary>Records that reference this record</summary>
        {incoming.map(({s,t,i})=>{
          const values=t.columns.map(c=>row[c]), complete=values.every(v=>v!=null&&['string','number','bigint'].includes(typeof v));
          return <button key={`${s.id}:${i}`} disabled={!complete||!t.available||t.directions?.reverse.available===false} onClick={()=>onOpen(s.source,[],{id:s.id,target:i,values:values.map(String)})}><span>{catalog.find(d=>d.id===s.source)?.label??pretty(s.source)}<small>{!complete?'This row has no complete target key.':!t.available?'Source keys are not published.':'Show related records listing this exact key.'}</small></span></button>;
        })}
      </details>}
    </div>
  </details>;
}
