import type { Dataset, Filter, Row, Join } from '../lib/catalog';
import { pretty, display, related, isIncomingJoin, joinTarget, connectionFilters, connectionLabel } from '../lib/catalog';
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
  if(!outgoing.length&&!incoming.length&&!incomingJoins.length)return null;
  const current=row;
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
            <span>{catalog.find(t=>t.id===link.target.table)?.label??pretty(link.target.table)}<small>{link.target.columns.map((c,i)=>`${c}: ${link.values[i]}`).join(' · ')}</small></span>
            {!link.target.available&&<small>Target is not published</small>}
            {link.target.available&&<small>{link.target.completeKey?'Open record · checks for one exact match':'Show related records'}</small>}
          </button>)}
          {occurrences.length>0&&<details><summary>Source occurrences · {occurrences.length}</summary><ol>{occurrences.map((value,i)=><li key={i}><pre className="source-passage">{display(value)}</pre></li>)}</ol></details>}
          {!links.length&&<small>{!s.available?'Source fields are not published yet.':state==='stated'?'No complete, supported target key in this reference.':state==='empty'?'The source lists no references.':state==='unread'?'Not read yet.':state==='not stated'?'The read source states no reference.':state==='unknown read state'?'No reference is stored; the source read state is unknown.':state==='unresolved targets'?'No recorded target identity. See the interpretation and target statuses below.':state==='unsupported shape'?'The stored reference format is unsupported.':state}</small>}
        </div>;
      })}
      {typeof current.record_entry_text==='string'&&current.record_entry_text&&<details><summary>Congressional Record source passage</summary><p>{String(current.record_granule_id??'')}</p><pre className="source-passage">{current.record_entry_text}</pre></details>}
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
