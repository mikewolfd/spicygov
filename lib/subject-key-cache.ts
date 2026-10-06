import type {Dataset} from './catalog';
import {readColumnBatches} from './reader';
const RULE='bill-subject-key/1';
const MAX_ROWS=500000,MAX_BYTES=128*1024*1024;
type KeyCache={binding:string;positions:Map<string,number>;estimatedBytes:number};
let retained:KeyCache|undefined;
export function subjectBinding(table:Dataset):string {
  return JSON.stringify([RULE,table.id,table.rows,table.recordsAvailable,table.artifactDigest,table.publicationIdentity,table.recordIdentity,table.columns.map(c=>[c.name,c.type]),table.members]);
}
/** One complete main-key projection, bounded and tied to the exact subject members. */
export async function billKeyCache(table:Dataset,onProgress:(n:number)=>void=()=>{}):Promise<KeyCache|undefined> {
  if(table.id!=='congress_bills'||table.recordIdentity?.columns.join(',')!=='bill_id'||table.rows>MAX_ROWS||table.rows*256>MAX_BYTES||!table.members.every(m=>m.etag&&m.sha256))return;
  const binding=subjectBinding(table);
  if(retained?.binding===binding)return retained;
  retained=undefined;
  const positions=new Map<string,number>();let position=0,estimatedBytes=0;
  const result=await readColumnBatches(table,['bill_id'],MAX_ROWS,rows=>{
    for(const row of rows) {
      const key=row.bill_id;
      if(typeof key!=='string'||!key||positions.has(key))throw new Error('The bill key population contains a missing or duplicate identity. No locator was admitted.');
      estimatedBytes+=256+key.length*2;
      if(estimatedBytes>MAX_BYTES)throw new Error('The bill key locator exceeds its memory limit.');
      positions.set(key,position++);
    }
    onProgress(position);
  });
  if(!result.complete||position!==table.rows)throw new Error('The bill key projection is incomplete. No locator was admitted.');
  retained={binding,positions,estimatedBytes};return retained;
}
