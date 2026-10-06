"use client";
import { useState } from 'react';
import type { Dataset, Filter, Row } from '@/lib/catalog';
import { browseFields, browseTargets, browseValue, congressContext } from '@/lib/shared-browse';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
export function SharedBrowse({table,catalog,filters,row,onOpen}:{table:Dataset;catalog:Dataset[];filters:Filter[];row?:Row;onOpen:(id:string,filters:Filter[])=>void}) {
  const fields=browseFields(table);
  const initial=fields.find(f=>row ? browseValue(f,row[f.column])!==undefined : filters.some(x=>x.column===f.column))??fields[0];
  const [column,setColumn]=useState(initial?.column??'');
  const field=fields.find(f=>f.column===column)??initial;
  const [typed,setTyped]=useState<string|null>(null);
  if(!field)return null;
  const raw=row?.[field.column]??filters.find(f=>f.column===field.column)?.value??'';
  const value=typed??browseValue(field,raw)??'';
  const context=congressContext(table,row,filters);
  const targets=browseTargets(catalog,field,value,context);
  const own=targets.find(t=>t.table.id===table.id&&t.field.column===field.column);
  const others=targets.filter(t=>t.table.id!==table.id||t.field.column!==field.column);
  return <details className="shared-browse" open={row?undefined:filters.some(f=>fields.some(c=>c.column===f.column))}>
    <summary>Browse by shared fields <span>Congress, chamber, agency & more</span></summary>
    <p className="shared-browse-note">Find tables with the same category. Each field keeps its own meaning.</p>
    <form onSubmit={e=>{e.preventDefault();if(own)onOpen(table.id,[...filters.filter(f=>!own.filters.some(x=>x.column===f.column)),...own.filters]);}}>
      <label>Field<NativeSelect value={field.column} onChange={e=>{setColumn(e.target.value);setTyped(null);}}>{fields.map(f=><option key={f.column} value={f.column}>{f.label}</option>)}</NativeSelect></label>
      <label>Value<Input value={value} placeholder={field.axis==='congress'?'119':field.axis==='chamber'?'House or Senate':'Enter a value'} onChange={e=>setTyped(e.target.value)} /></label>
      <Button type="submit" variant="outline" disabled={!own}>Apply here</Button>
    </form>
    <p className="shared-field-meaning"><code>{field.column}</code> · {field.description||field.label}</p>
    {field.axis==='session'&&!context?<p className="shared-browse-note">Select a Congress first; session numbers repeat across Congresses.</p>:null}
    {value&&others.length?<><h3>Other tables for {field.axis==='session'?`session ${browseValue(field,value)} in Congress ${context}`:`${field.label.toLowerCase()} ${browseValue(field,value)}`}</h3><div className="shared-targets">{others.map(t=><button type="button" key={t.table.id+':'+t.field.column} onClick={()=>onOpen(t.table.id,t.filters)} title={t.field.description}><strong>{t.table.label}</strong><span>{t.field.label} · {t.filters.map(f=>f.column+' = '+(f.values??[f.value]).join(' or ')).join(' · ')}</span></button>)}</div><p className="shared-browse-note">These tables have the field; matching records are checked when you open one.</p></>:null}
  </details>;
}
