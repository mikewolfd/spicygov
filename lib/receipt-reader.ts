import { matchesConnection, type Connection, type Navigation } from './navigation';
import type { Dataset, Row } from './catalog';
import { memberFooter, readPage } from './reader';
import { parseExact } from './exact-json';
import type { NativeReceipts } from './publication-evidence';
export { parseExact } from './exact-json';
export function unpack(v: unknown): unknown {
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string') throw new Error('Unsupported receipt encoding.');
  const [tag, body] = v;
  if (tag === 'dict' && Array.isArray(body)) return Object.fromEntries(body.map(pair => {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') throw new Error('Malformed receipt mapping.');
    return [pair[0], unpack(pair[1])];
  }));
  if (tag === 'list' && Array.isArray(body)) return body.map(unpack);
  if (['null','str','int','bool','decimal','date','datetime'].includes(tag)) return body;
  if (tag === 'float' && typeof body === 'string') {
    const match=/^(-?)0x([01])\.([0-9a-f]+)p([+-][0-9]+)$/.exec(body);
    if(!match)throw new Error('Malformed receipt floating point value.');
    return (match[1]? -1:1)*(Number(match[2])+parseInt(match[3],16)/16**match[3].length)*2**Number(match[4]);
  }
  if(tag==='bytes'&&typeof body==='string')return Uint8Array.from(atob(body),c=>c.charCodeAt(0));
  throw new Error(`Receipt value type ${tag} is not supported by this browser.`);
}
const codepointOrder = (a: string,b: string) => {const aa=Array.from(a),bb=Array.from(b);for(let i=0;i<Math.min(aa.length,bb.length);i++){const n=aa[i].codePointAt(0)!-bb[i].codePointAt(0)!;if(n)return n;}return aa.length-bb.length;};
function pack(v: unknown): unknown {
  if (v === null) return ['null',null];
  if (typeof v === 'string') return ['str',v];
  if (typeof v === 'boolean') return ['bool',v];
  if (typeof v === 'number' && Number.isSafeInteger(v) || typeof v === 'bigint') return ['int',v];
  if (Array.isArray(v)) return ['list',v.map(pack)];
  if (v && typeof v === 'object' && !(v instanceof Date)) return ['dict',Object.keys(v).sort(codepointOrder).map(k => [k,pack((v as Row)[k])])];
  throw new Error('This row uses an exact value type the browser cannot verify. Its receipt connections remain unavailable.');
}
function serialize(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return '['+v.map(serialize).join(',')+']';
  return JSON.stringify(v);
}
export const exactJson = (v: unknown) => serialize(pack(v));
export async function sha256(text: string | ArrayBuffer): Promise<string> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2,'0')).join('');
}
export async function recordIdentity(table: Dataset, row: Row): Promise<{id: string; identity: string}> {
  if (!table.receiptIdentity?.length || table.receiptIdentity.some(k => !(k in row))) throw new Error('The complete receipt identity is unavailable.');
  const pairs = table.receiptIdentity.map(k => [k,row[k]]);
  return {id: await sha256(exactJson([table.id,pairs])), identity: exactJson(pairs)};
}
function receiptDataset(table: Dataset): Dataset {
  const receipt = table.publication?.nativeReceipts;
  if (!receipt) throw new Error('This publication has no matching receipts.');
  const names = ['receipt_id','policy_version','dataset','generation_id','record_id','subject_version','identity_json','outcome','processing_json'];
  return {...table, id: 'etl_receipts', rows: receipt.rows, columns: names.map(name => ({name,type:'VARCHAR',description:''})), members:[{url:receipt.url,rows:receipt.rows,byteSize:receipt.bytes}]};
}
/** Container fields kept only in receipts: the details a receipt lookup adds beyond the published row. */
export function receiptOnlyFields(table: Dataset): string[] {
  const published = new Set(table.columns.map(c => c.name));
  return [...new Set(Object.values(table.receiptContainers ?? {}).flat())].filter(name => !published.has(name));
}
// Receipts are written with identity_json bounds in the footer and a page index (spicy-regs standard layout,
// 2026-11-09), so a lookup by identity reads only the pages that can hold it: ~1.8 MB measured on bill-family.
// A file written before that has no identity bounds; the browser then filters every receipt of the table, which past
// this many receipts is too slow to offer (the same bound as the server's read_receipt_fields).
export const IDENTITY_SCAN_ROWS = 2_000_000;
export type ReceiptLookup = {path: 'identity'} | {path: 'refused'; reason: string};
export function receiptLookup(pin: NativeReceipts | undefined): ReceiptLookup {
  return pin ? {path:'identity'} : {path:'refused', reason:'Matching generation receipts are unavailable.'};
}
type FooterGroup = {num_rows: bigint | number; columns: {meta_data?: {path_in_schema: string[]; statistics?: {min_value?: unknown; max_value?: unknown}}}[]};
const within = (stats: {min_value?: unknown; max_value?: unknown} | undefined, value: string) =>
  typeof stats?.min_value !== 'string' || typeof stats?.max_value !== 'string' || (stats.min_value <= value && value <= stats.max_value);
/** Receipts a lookup must check: rows of the groups whose footer bounds admit the dataset and the identity. */
export function identityCandidates(groups: FooterGroup[], dataset: string, identity: string): number {
  let rows = 0;
  for (const group of groups) {
    const stats = (name: string) => group.columns.find(c => c.meta_data?.path_in_schema.join('.') === name)?.meta_data?.statistics;
    if (within(stats('dataset'), dataset) && within(stats('identity_json'), identity)) rows += Number(group.num_rows);
  }
  return rows;
}
/** `scan` counts receipt rows checked in the groups whose bounds admit this record. */
export type ReceiptProgress = {step: 'scan'; checked: number; total: number};
export async function receiptFields(table: Dataset, row: Row, fields: string[], onProgress: (p: ReceiptProgress)=>void = () => {}): Promise<Row> {
  const pin = table.publication?.nativeReceipts, lookup = receiptLookup(pin);
  if (!pin || !table.artifactDigest) throw new Error('Matching generation receipts are unavailable.');
  if (lookup.path === 'refused') throw new Error(lookup.reason);
  const identity = await recordIdentity(table,row);
  const receiptTable = receiptDataset(table);
  const footer = await memberFooter(receiptTable.members[0]);
  if (Number(footer.num_rows) !== pin.rows) throw new Error('The Parquet footer differs from the published row count.');
  const candidates = identityCandidates(footer.row_groups as FooterGroup[], table.id, identity.identity);
  if (candidates > IDENTITY_SCAN_ROWS) throw new Error(`These receipts were published before identity bounds: finding this record would check ${candidates.toLocaleString('en-US')} receipts. Lookups return with the next publication.`);
  // Two reads, as a columnar engine materializes late. First the identity columns alone: footer planning
  // (maxScanRows) skips row groups whose bounds exclude the identity and the page index skips pages. Then the one
  // matching row, every column, by position: one page per column. Reading every column of the candidate pages
  // instead cost ~57 MB per lookup on bill_sections' 3.7M receipts, whose rows are not in identity order; this
  // costs ~1.8 MB (2026-11-09).
  const located = await readPage({table:receiptTable,columns:['dataset','identity_json','outcome'],
    filters:[{column:'dataset',value:table.id},{column:'identity_json',value:identity.identity},{column:'outcome',value:'accepted'}],
    cursor:0,limit:2,maxScanRows:pin.rows},checked=>onProgress({step:'scan',checked,total:pin.rows}));
  if (located.rows.length !== 1) throw new Error(located.rows.length ? 'Ambiguous accepted receipts; no receipt was chosen.' : 'No accepted receipt for this row in the selected generation.');
  const found = (await readPage({table:receiptTable,columns:receiptTable.columns.map(c=>c.name),filters:[],cursor:located.positions[0],limit:1})).rows;
  if (found.length !== 1) throw new Error(found.length ? 'Ambiguous accepted receipts; no receipt was chosen.' : 'No accepted receipt for this row in the selected generation.');
  const receipt = found[0];
  if (receipt.dataset !== table.id || receipt.record_id !== identity.id || receipt.identity_json !== identity.identity || receipt.outcome !== 'accepted' || receipt.generation_id !== pin.generationId) throw new Error('The receipt identity or generation differs from this row.');
  // Publication admission pins subjects and receipts together. Browser identity remains exact,
  // including integers; do not rehash lossy browser decimal/date conversions as source bytes.
  if (typeof receipt.subject_version !== "string" || !/^sha256:[a-f0-9]{64}$/.test(receipt.subject_version)) throw new Error("The receipt has no accepted subject version.");
  const processing = unpack(parseExact(String(receipt.processing_json))) as Row;
  const result: Row = {};
  for (const field of fields) {
    if (field in processing) { result[field] = processing[field]; continue; }
    const container = Object.entries(table.receiptContainers ?? {}).find(([, names])=>names.includes(field))?.[0];
    const mapping = container ? processing[container] : undefined;
    if (!mapping || typeof mapping !== 'object' || !(field in mapping)) continue;
    result[field] = (mapping as Row)[field];
  }
  return result;
}

export async function readReceiptConnectionPage(request: {table: Dataset; columns: string[]; cursor: number; limit: number; connection: Connection; navigation: Navigation}, onProgress: (n:number)=>void): Promise<{rows:Row[];positions:number[];cursor:number;done:boolean}> {
  const {table,columns,connection,navigation,limit} = request;
  const pin = table.publication?.nativeReceipts;
  if (!pin || !table.receiptIdentity?.length) throw new Error('This connection has no matching generation receipts.');
  const receipts = receiptDataset(table);
  const rows: Row[] = [], positions: number[] = [];
  let cursor = request.cursor;
  // A click scans at most this many receipt rows. Continue keeps the same immutable generation.
  const stop = Math.min(pin.rows, cursor + 50000);
  while (cursor < stop && rows.length < limit) {
    const end = Math.min(cursor+2000,stop);
    const batch = await readPage({table:receipts,columns:receipts.columns.map(c=>c.name),filters:[],cursor,limit:end-cursor});
    for(let i=0;i<batch.rows.length;i++) {
      const receipt = batch.rows[i]; cursor=batch.positions[i]+1;
      if(receipt.dataset!==table.id || receipt.outcome!=='accepted') continue;
      if(receipt.generation_id!==pin.generationId) throw new Error('Receipt connection contains a different generation.');
      const pairs=unpack(parseExact(String(receipt.identity_json)));
      if(!Array.isArray(pairs) || pairs.length!==table.receiptIdentity.length || pairs.some((p,i)=>!Array.isArray(p)||p[0]!==table.receiptIdentity![i])) throw new Error('Receipt connection identity changed.');
      const identity=Object.fromEntries(pairs);
      const processing=unpack(parseExact(String(receipt.processing_json))) as Row;
      const context: Row={...identity,...processing};
      for(const [container,names] of Object.entries(table.receiptContainers??{})) {
        const mapping=processing[container];
        if(mapping&&typeof mapping==='object') for(const name of names) if(name in mapping) context[name]=(mapping as Row)[name];
      }
      if(!matchesConnection(context,navigation,connection)) continue;
      const filters=table.receiptIdentity.map(column=>({column,value:String(identity[column])}));
      const subject=await readPage({table,columns:table.columns.map(c=>c.name),filters,cursor:0,limit:2});
      if(subject.rows.length!==1) throw new Error('Receipt connection has a missing or ambiguous subject; no row was chosen.');
      const id=await recordIdentity(table,subject.rows[0]);
      if(id.id!==receipt.record_id || id.identity!==receipt.identity_json) throw new Error('Receipt connection does not match the exact subject.');
      rows.push(Object.fromEntries(columns.map(c=>[c,subject.rows[0][c]]))); positions.push(subject.positions[0]);
      if(rows.length===limit) break;
    }
    onProgress(cursor);
    if(!batch.rows.length) cursor=end;
  }
  return {rows,positions,cursor,done:cursor>=pin.rows};
}

export async function readSourceEvidence(table: Dataset, dataset: string, filters: {column:string;value:string}[], onProgress: (n:number)=>void=()=>{}, start=0): Promise<{records: Row[];partial:boolean;cursor:number}> {
  const pin=table.publication?.nativeReceipts;
  if(!pin || !/^[a-z][a-z0-9_]*$/.test(dataset) || !filters.length) throw new Error('This source evidence is unavailable.');
  const receipts=receiptDataset(table),records:Row[]=[];
  if(!Number.isSafeInteger(start)||start<0)throw new Error("Invalid evidence continuation.");
  let cursor=start;
  const bound=Math.min(pin.rows,start+50000);
  while(cursor<bound) {
    const batch=await readPage({table:receipts,columns:receipts.columns.map(c=>c.name),filters:[],cursor,limit:Math.min(2000,bound-cursor)});
    cursor=batch.cursor;
    for(let i=0;i<batch.rows.length;i++) {
      const r=batch.rows[i];
      cursor=batch.positions[i]+1;
      if(r.dataset!==dataset || !['accepted','observed'].includes(String(r.outcome)))continue;
      if(r.generation_id!==pin.generationId)throw new Error('Source evidence belongs to a different generation.');
      const p=unpack(parseExact(String(r.processing_json))) as Row;
      const context={...p};
      for(const v of Object.values(p))if(v&&typeof v==='object'&&!Array.isArray(v))Object.assign(context,v);
      if(!filters.every(f=>context[f.column]!=null&&String(context[f.column])===f.value))continue;
      // Show concise evidence facts, not filesystem locators or arbitrary processing payloads.
      const allowed=['scope_id','source_family','source_record_key','edition','occurrence_count','source_bytes','input_sha256','manifest_sha256','rule_version','collection_id','source_record_id','record_id','source_namespace','record_kind','candidate_id','committee_id','cycle','file_number','filing_key','report_code','period_start','period_end','status','source_status','definition_set_id','captured_at','rows','records','count','sha256','record_count','relationship_count','record_outcome','profile','source_system_id','source_state_scope','source_authority','source_generation','source_generation_pin','association_status','current_record_status','table','congress','citation','chamber','event_id','communication_type','number','read_outcome','error_type','recorded_at'];
      records.push(Object.fromEntries(allowed.filter(k=>k in context).map(k=>[k,context[k]])));
      if(records.length>=20)return{records,partial:cursor<pin.rows,cursor};
    }
    onProgress(cursor);
    if(batch.done)break;
  }
  return{records,partial:cursor<pin.rows,cursor};
}
