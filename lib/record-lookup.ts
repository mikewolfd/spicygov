import type {Dataset,Filter,Row} from './catalog';
import {readPage} from './reader';
import {billKeyCache,subjectBinding} from './subject-key-cache';
export type LookupResult={status:'found'|'missing'|'ambiguous'|'incomplete';cursor:number;positions:number[];row?:Row};
let continuation:{request:string;table:Dataset;cursor:number;positions:number[]}|undefined;
export function completeIdentity(table:Dataset,filters:Filter[]):boolean {
  const identity=table.recordIdentity?.columns;
  return !!identity?.length && identity.length===filters.length && new Set(filters.map(f=>f.column)).size===filters.length && identity.every(c=>filters.some(f=>f.column===c&&!f.values));
}
export async function bindLookupMembers(table:Dataset):Promise<Dataset> {
  const members=[];
  for(const member of table.members) {
    if(member.etag){members.push(member);continue;}
    // Pin the served version once, then use If-Match for every key and detail range.
    const response=await fetch(member.url,{method:'HEAD',cache:'no-store'});
    const etag=response.headers.get('etag');
    if(!response.ok||!etag||etag.startsWith('W/')||Number(response.headers.get('content-length'))!==member.byteSize)throw new Error('This publication has no checked file version for an exact record lookup. Reload the catalog or show related records.');
    members.push({...member,etag});
  }
  return {...table,members};
}
/** Check current qualified keys before reading a single record's full fields. */
export async function lookupRecord(table:Dataset,filters:Filter[],cursor=0,previous:number[]=[],onProgress:(n:number)=>void=()=>{},maxScanRows=250000):Promise<LookupResult> {
  if(!completeIdentity(table,filters))throw new Error('This reference supplies a scope, not a complete record identity. Show related records.');
  if(!table.members.every(m=>m.etag))throw new Error('This publication has no checked file version for an exact record lookup. Reload the catalog or show related records.');
  if(!Number.isSafeInteger(cursor)||cursor<0||previous.length>1||previous.some(p=>!Number.isSafeInteger(p)||p<0||p>=cursor))throw new Error('Invalid record lookup continuation.');
  if(maxScanRows>250000)throw new Error('Record lookup exceeds its bounded scan limit.');
  const result=await readPage({table,columns:filters.map(f=>f.column),filters,cursor,limit:2-previous.length,maxScanRows},onProgress);
  const positions=[...previous,...result.positions];
  if(positions.length>1)return {status:'ambiguous',cursor:result.cursor,positions};
  if(!result.done)return {status:'incomplete',cursor:result.cursor,positions};
  if(!positions.length)return {status:'missing',cursor:result.cursor,positions};
  const detail=await readPage({table,columns:table.columns.map(c=>c.name),filters:[],cursor:positions[0],limit:1});
  if(detail.positions[0]!==positions[0])throw new Error('The matched record is no longer readable in this publication.');
  return {status:'found',cursor:result.cursor,positions,row:detail.rows[0]};
}
export async function locateRecord(table:Dataset,filters:Filter[],cursor=0,previous:number[]=[],onProgress:(n:number)=>void=()=>{}):Promise<LookupResult> {
  if(!completeIdentity(table,filters))throw new Error('This reference supplies a scope, not a complete record identity. Show related records.');
  const request=JSON.stringify([subjectBinding(table),filters]);
  if(cursor && (!continuation||continuation.request!==request||continuation.cursor!==cursor||JSON.stringify(continuation.positions)!==JSON.stringify(previous)))throw new Error('This lookup continuation no longer matches its selected files. Restart the lookup.');
  const bound=cursor?continuation!.table:await bindLookupMembers(table);
  const cache=cursor===0?await billKeyCache(bound,onProgress):undefined;
  if(!cache){const result=await lookupRecord(bound,filters,cursor,previous,onProgress);continuation=result.status==='incomplete'?{request,table:bound,cursor:result.cursor,positions:result.positions}:undefined;return result;}
  continuation=undefined;
  const position=cache.positions.get(filters[0].value);
  if(position===undefined)return {status:'missing',cursor:bound.rows,positions:[]};
  const detail=await readPage({table:bound,columns:bound.columns.map(c=>c.name),filters,cursor:position,limit:1,maxScanRows:1});
  if(detail.positions[0]!==position)throw new Error('The admitted bill locator no longer matches its exact subject key. Reload the catalog.');
  return {status:'found',cursor:bound.rows,positions:[position],row:detail.rows[0]};
}
