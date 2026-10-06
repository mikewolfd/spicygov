import { useEffect, useRef, useState } from 'react';
import type { Dataset, Filter, Row } from '../lib/catalog';
import { pretty, display } from '../lib/catalog';
import { elements, forwardLinks, type Connection, type Navigation } from '../lib/navigation';
type Props = {table: Dataset; catalog: Dataset[]; row: Row; navigation: Navigation[]; onOpen: (id:string,filters:Filter[],connection?:Connection)=>void};
export function SourceConnections({table,catalog,row,navigation,onOpen}: Props) {
  const outgoing=navigation.filter(s=>s.source===table.id), incoming=navigation.flatMap(s=>s.targets.map((t,i)=>({s,t,i}))).filter(({t})=>t.table===table.id);
  const [held,setHeld]=useState<Row>({}), [busy,setBusy]=useState(false), [error,setError]=useState(''), [evidence,setEvidence]=useState<{records:Row[];partial:boolean;cursor:number;dataset:string;filters:Filter[]}|null>(null);
  const worker=useRef<Worker|null>(null);
  useEffect(()=>{setHeld({});setEvidence(null);setError('');setBusy(false);return()=>worker.current?.terminate();},[row,table.id]);
  if(!outgoing.length&&!incoming.length)return null;
  const wanted=[...new Set([...outgoing.flatMap(s=>s.receiptFields), ...(Object.values(table.receiptContainers??{}).some(fields=>fields.includes('detail_read')) ? ['detail_read'] : [])])];
  const current={...row,...held};
  function load() {
    worker.current?.terminate();setBusy(true);setError('');
    const w=new Worker(new URL('../lib/parquet.worker.ts',import.meta.url),{type:'module'});worker.current=w;
    w.onmessage=e=>{if(e.data.type==='receipt'){setHeld(e.data.fields);setBusy(false);w.terminate();}if(e.data.type==='error'){setError(e.data.message);setBusy(false);w.terminate();}};
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
      {outgoing.map(original=>{
        const s=original.receiptFields.some(f=>f in held)&&original.mode==='array'?{...original,field:original.receiptFields[0]}:original;
        const links=forwardLinks(s,current), state=elements(s,current).state;
        return <div className="source-reference" key={s.id}>
          <p>{s.meaning}</p>
          {links.map((link,i)=>link.target.table==='@url'?<a key={i} href={link.values[0]} target="_blank" rel="noreferrer">Open offered document <small>Capture and text extraction are not established by this link.</small></a>:<button key={i} disabled={!link.target.available} onClick={()=>link.target.table.startsWith("@receipt:")?readEvidence(link.target.table.slice(9),link.filters):onOpen(link.target.table,link.filters)}>
            <span>{catalog.find(t=>t.id===link.target.table)?.label??pretty(link.target.table.replace('@receipt:',''))}<small>{link.target.columns.map((c,i)=>`${c}: ${link.values[i]}`).join(' · ')}</small></span>
            {!link.target.available&&<small>Target is not published</small>}
          </button>)}
          {!links.length&&<small>{!s.available?'Source fields are not published yet.':state==='stated'?'No complete, supported target key in this reference.':state==='empty'?'The source lists no references.':state==='unread'?'Not read yet.':state==='not stated'?'The read source states no reference.':state==='unknown read state'?'No reference is stored; the source read state is unknown.':state==='unsupported shape'?'The stored reference format is unsupported.':state}</small>}
        </div>;
      })}
      {typeof current.record_entry_text==='string'&&current.record_entry_text&&<details><summary>Congressional Record source passage</summary><p>{String(current.record_granule_id??'')}</p><pre className="source-passage">{current.record_entry_text}</pre></details>}
      {wanted.length>0&&table.publication?.nativeReceipts&&<div className="source-reference"><button disabled={busy} onClick={load}>{busy?'Reading matching receipt…':'Read retained source details'}</button><small>Uses this record’s exact identity and publication generation.</small></div>}
      {busy&&<p role="status">Reading selected generation evidence…</p>}
      {error&&<p role="alert">{error}</p>}
      {evidence&&<div className="source-reference"><strong>Retained source evidence</strong>{evidence.records.map((r,i)=><dl key={i}>{Object.entries(r).map(([k,v])=><div key={k}><dt>{pretty(k)}</dt><dd>{v==null?'Not stated':display(v)}</dd></div>)}</dl>)}{!evidence.records.length&&<p>{evidence.partial?'No match in the checked receipt rows. The search is incomplete.':'No matching source evidence in this selected generation.'}</p>}{evidence.partial&&<button disabled={busy} onClick={()=>readEvidence(evidence.dataset,evidence.filters,evidence.cursor)}>Continue checking source evidence</button>}</div>}
      {incoming.length>0&&<details><summary>Records that reference this record</summary>
        {incoming.map(({s,t,i})=>{
          const values=t.columns.map(c=>row[c]), complete=values.every(v=>v!=null&&['string','number','bigint'].includes(typeof v));
          return <button key={`${s.id}:${i}`} disabled={!complete||!s.available} onClick={()=>onOpen(s.source,[],{id:s.id,target:i,values:values.map(String)})}><span>{catalog.find(d=>d.id===s.source)?.label??pretty(s.source)}<small>{!complete?'This row has no complete target key.':!s.available?'Source keys are not published.':s.receiptFields.length?'Search retained references in this publication.':'Find records listing this exact key.'}</small></span></button>;
        })}
      </details>}
    </div>
  </details>;
}
