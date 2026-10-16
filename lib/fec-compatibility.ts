import type {Dataset, Row} from './catalog';
import type {Navigation, Target} from './navigation';
import {navigationColumns} from './navigation';

const MAX_BYTES = 8 * 1024 * 1024;
const digest = (v: unknown): v is string => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (v: unknown, k: unknown): unknown => object(v) && typeof k === 'string' && Object.hasOwn(v, k) ? v[k] ?? null : null;
type Pin = {logicalId: string; artifactDigest: string};
type Expression = unknown[];
export type DecisionProgram = {format: string; lookups: Record<string, Record<string, unknown>>; bindings: [string, Expression][]; outputs: Record<string, Expression>};
export type FecCompatibility = {
  format: string; queryPin: Pin; observationsPin: Pin; historicalObservationsPin: Pin;
  observationsProofSha256: string; preservedSourceColumns: Record<string, string[]>;
  logicalColumns: [string, string][]; tableModes: Record<string, string[]>;
  decisionProgram: DecisionProgram; filerFields: Record<string, string>; sha256: string;
};
const logicalTypes: Record<string, string> = {
  filing_key:'VARCHAR', filing_association_status:'VARCHAR', filing_link_status:'VARCHAR',
  filing_association_policy:'VARCHAR', filing_association_source_generation_pin:'VARCHAR',
  filing_association_evidence_generation_pin:'VARCHAR', filing_association_target_generation_scope:'VARCHAR',
  filing_association_target_generation_pin:'VARCHAR', filing_association_record_id:'VARCHAR', filing_association_referenced_key:'VARCHAR',
  filing_association_target_count:'BIGINT', filing_association_target_record_ids:'VARCHAR[]',
};
const preserved = {fec_collections:['collection_id'], fec_source_records:['collection_id','source_record_id','source_sha256']};
const pinValid = (p: unknown): p is Pin => object(p) && digest(p.artifactDigest) && typeof p.logicalId === 'string' && /^urn:spicy:artifact:spicy-regs-rollup-generation:[0-9a-f]{64}$/.test(p.logicalId);
const samePin = (p: Pin, t: Dataset) => p.artifactDigest === t.artifactDigest && p.logicalId === t.logicalId;
const selected = (tables: Dataset[]) => ({query:tables.find(t=>t.id==='fec_filings'), observations:tables.find(t=>t.id==='fec_source_records')});

type Eval = (variables: Map<string, unknown>) => unknown;
type Compiled = {run:(row:Row)=>Row; inputs:string[]};
const compiled = new WeakMap<DecisionProgram, Compiled>();
/** Compile only the producer's finite expression vocabulary, once per selected descriptor. */
function compile(program: DecisionProgram): Compiled {
  const cached = compiled.get(program); if (cached) return cached;
  if (!object(program) || program.format !== 'fec-row-expressions/1' || !object(program.lookups)
    || Object.keys(program.lookups).sort().join(',') !== 'headers,routes,targets'
    || !Object.values(program.lookups).every(object) || !Array.isArray(program.bindings) || program.bindings.length > 32 || !object(program.outputs)) throw new Error('Unsupported FEC decision program.');
  const variables = new Set(['row']), inputs = new Set<string>(); let nodes = 0;
  const patterns = new Set(['-?[1-9][0-9]*', '[\\s\\S]+', 'sha256:[0-9a-f]{64}', 'unresolved_header_(association_ambiguous|policy_version|policy_semantics)']);
  function expr(node: unknown, depth = 0): Eval {
    if (++nodes > 4096 || depth > 32 || !Array.isArray(node) || typeof node[0] !== 'string') throw new Error('Invalid FEC decision expression.');
    const [op,...args] = node;
    if (op === 'literal') {
      if (args.length !== 1 || !(args[0] === null || ['string','boolean','number'].includes(typeof args[0]) || Array.isArray(args[0]) && args[0].length === 0)) throw new Error('Invalid FEC literal.');
      return () => args[0];
    }
    if (op === 'var') {
      if (args.length !== 1 || !variables.has(args[0])) throw new Error('Unknown FEC decision variable.');
      return v => v.get(args[0]) ?? null;
    }
    const arities: Record<string, number[]> = {get:[2],if:[3],not:[1],eq:[2],regex:[2],lookup:[2],json:[1]};
    if (!(op in arities) && !['and','or','concat','tuple'].includes(op) || op in arities && !arities[op].includes(args.length) || args.length > 32) throw new Error('Unsupported FEC decision operator.');
    if (op === 'get' && JSON.stringify(args[0]) === '["var","row"]' && Array.isArray(args[1]) && args[1][0] === 'literal' && typeof args[1][1] === 'string') inputs.add(args[1][1]);
    const a = args.map(n=>expr(n,depth+1));
    switch(op) {
      case 'get': return v=>own(a[0](v),a[1](v));
      case 'if': return v=>a[a[0](v) === true ? 1 : 2](v);
      case 'and': return v=>a.every(f=>f(v) === true);
      case 'or': return v=>a.some(f=>f(v) === true);
      case 'not': return v=>a[0](v) !== true;
      case 'eq': return v=>{const x=a[0](v),y=a[1](v); return typeof x === typeof y && x === y;};
      case 'regex': {
        if (!Array.isArray(args[1]) || args[1][0] !== 'literal' || !patterns.has(args[1][1])) throw new Error('Unsupported FEC decision pattern.');
        const re = new RegExp(`^(?:${args[1][1]})$`);
        return v=>{const x=a[0](v);return typeof x === 'string' && re.exec(x)?.[0] === x;};
      }
      case 'concat': return v=>{const values=a.map(f=>f(v));return values.every(x=>typeof x === 'string') ? values.join('') : null;};
      case 'tuple': return v=>a.map(f=>f(v));
      case 'lookup': {
        if (!Array.isArray(args[0]) || args[0][0] !== 'literal' || !['routes','targets','headers'].includes(args[0][1])) throw new Error('Unknown FEC lookup.');
        const lookup=program.lookups[args[0][1]];
        return v=>{const key=a[1](v);return own(lookup,Array.isArray(key)?JSON.stringify(key):key);};
      }
      case 'json': return v=>{try {const x=a[0](v); if(typeof x!=='string')return null;const parsed=JSON.parse(x);return object(parsed)?parsed:null;}catch{return null;}};
      default: throw new Error('Unsupported FEC expression.');
    }
  }
  const bindings = program.bindings.map(binding=>{
    if (!Array.isArray(binding) || binding.length !== 2 || typeof binding[0] !== 'string' || variables.has(binding[0])) throw new Error('Invalid FEC binding.');
    const evaluate = expr(binding[1]); variables.add(binding[0]);return [binding[0],evaluate] as const;
  });
  if (Object.keys(program.outputs).sort().join(',') !== Object.keys(logicalTypes).sort().join(',')) throw new Error('Invalid FEC decision outputs.');
  const outputs=Object.entries(program.outputs).map(([name,node])=>[name,expr(node)] as const);
  // The only dynamic row access is the route's declared filer field.
  for (const route of Object.values(program.lookups.routes)) {
    if (!object(route) || typeof route.filerField !== 'string' || !['reporting_committee_id','reporting_entity_id','spender_native_id'].includes(route.filerField)) throw new Error('Invalid FEC filer field.');
    inputs.add(route.filerField);
  }
  const result:Compiled = {inputs:[...inputs], run:row=>{
    const v=new Map<string,unknown>([['row',row]]);
    for(const [name,f] of bindings)v.set(name,f(v));
    return Object.fromEntries(outputs.map(([name,f])=>[name,f(v)]));
  }};
  compiled.set(program,result);return result;
}
export function evaluateFec(program: DecisionProgram, row: Row): Row {return compile(program).run(row);}

export function validateCompatibility(value: unknown, tables: Dataset[], sha256: string): FecCompatibility {
  const {query,observations}=selected(tables);
  if(!object(value) || value.format !== 'fec-retained-query-serving/1' || !query || !observations
    || !pinValid(value.queryPin) || !samePin(value.queryPin,query) || !pinValid(value.observationsPin) || !samePin(value.observationsPin,observations)
    || !pinValid(value.historicalObservationsPin) || !digest(value.observationsProofSha256) || !digest(sha256)
    || value.associationPolicy !== 'fec-retained-filing-association/1' || value.targetMappingVersion !== 'fec-identity-observations/1' || value.targetIdentityVersion !== 'fec-typed-observation/1'
    || !object(value.preservedSourceColumns) || Object.keys(value.preservedSourceColumns).sort().join(',') !== Object.keys(preserved).sort().join(',')
    || Object.entries(preserved).some(([name,columns])=>JSON.stringify(value.preservedSourceColumns[name])!==JSON.stringify(columns))
    || !Array.isArray(value.logicalColumns) || value.logicalColumns.length !== Object.keys(logicalTypes).length
    || new Set(value.logicalColumns.map((c:any)=>c?.[0])).size !== value.logicalColumns.length
    || !value.logicalColumns.every((c:any)=>Array.isArray(c)&&c.length===2&&Object.hasOwn(logicalTypes,c[0])&&logicalTypes[c[0]]===c[1])
    || !object(value.tableModes) || !Object.entries(value.tableModes).every(([name,modes])=>name.startsWith('fec_')&&Array.isArray(modes)&&modes.length>0&&modes.length<=2&&new Set(modes).size===modes.length&&modes.every(m=>['header','native-file-number'].includes(m)))
    || !object(value.namespaceEvidence) || !Object.values(value.namespaceEvidence).every(digest)
    || !object(value.filerFields)) throw new Error('FEC compatibility does not match this data release.');
  compile(value.decisionProgram);
  const outputs=value.decisionProgram.outputs;
  for(const [name,expected] of Object.entries({filing_association_policy:value.associationPolicy,
    filing_association_source_generation_pin:value.observationsPin.artifactDigest,
    filing_association_evidence_generation_pin:value.historicalObservationsPin.artifactDigest,
    filing_association_target_generation_scope:'self',filing_association_target_generation_pin:null})) {
    if(JSON.stringify(outputs[name])!==JSON.stringify(['literal',expected]))throw new Error('FEC decisions use a different release scope.');
  }
  const routes=value.decisionProgram.lookups.routes;
  if(!object(value.numberMappings) || Object.keys(routes).sort().join(',')!==Object.keys(value.numberMappings).sort().join(',')
    || Object.entries(routes).some(([namespace,route])=>!object(route)||route.mapper!==value.numberMappings[namespace]||route.filerField!==value.filerFields[namespace]||route.evidence!==(value.namespaceEvidence[namespace]??null)))throw new Error('FEC namespace evidence differs from its decisions.');
  // Large producer-side witness records need not travel to every reader worker.
  return {format:value.format,queryPin:value.queryPin,observationsPin:value.observationsPin,historicalObservationsPin:value.historicalObservationsPin,
    observationsProofSha256:value.observationsProofSha256,preservedSourceColumns:value.preservedSourceColumns,
    logicalColumns:value.logicalColumns,tableModes:value.tableModes,decisionProgram:value.decisionProgram,filerFields:value.filerFields,sha256};
}

export async function loadFecCompatibility(tables: Dataset[], base: string, signal?: AbortSignal): Promise<FecCompatibility|undefined> {
  const {query,observations}=selected(tables);
  if(!query || !observations || !digest(query.artifactDigest) || !digest(observations.artifactDigest))return;
  const response=await fetch(`${base}/fec-compatibility/v1/${observations.artifactDigest.slice(7)}/${query.artifactDigest.slice(7)}.json`,{signal,cache:'force-cache'});
  if(response.status===404)return;
  if(!response.ok)throw new Error('Filing connections could not be checked for this release.');
  if(Number(response.headers.get('content-length'))>MAX_BYTES){await response.body?.cancel();throw new Error('FEC compatibility exceeds its size limit.');}
  const reader=response.body?.getReader();if(!reader)throw new Error('FEC compatibility is empty.');
  const chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw new Error('FEC compatibility exceeds its size limit.');chunks.push(value);}}
  catch(error){await reader.cancel();throw error;}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  const sha256='sha256:'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  return validateCompatibility(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),tables,sha256);
}

export function bindFecCompatibility(tables: Dataset[], compatibility?: FecCompatibility): Dataset[] {
  if(!compatibility)return tables;
  return tables.map(table=>{
    const modes=compatibility.tableModes[table.id];
    if(!modes || !samePin(compatibility.queryPin,table))return table;
    const physicalColumns=table.physicalColumns??table.columns, fields=new Set(physicalColumns.map(c=>c.name));
    if(!['record_id','collection_id','source_record_id','source_authority','source_sha256','selection_evidence_sha256','source_locator_json'].every(f=>fields.has(f))
      || modes.includes('header')&&!(['filing_header_record_id','filing_header_locator_json'].every(f=>fields.has(f))||['header_record_id','header_locator_json'].every(f=>fields.has(f)))
      || modes.includes('native-file-number')&&!['source_namespace','mapping_version','report_number'].every(f=>fields.has(f)))return table;
    const virtual=compatibility.logicalColumns.map(([name,type])=>({name,type,description:'Qualified filing connection for this data release.'}));
    return {...table,physicalColumns,fecCompatibility:compatibility,columns:[...physicalColumns.filter(c=>!Object.hasOwn(logicalTypes,c.name)),...virtual]};
  });
}
export function fecReadColumns(table: Dataset, requested: string[]): string[] {
  if(!table.fecCompatibility)return requested;
  const physical=new Set(table.physicalColumns!.map(c=>c.name));
  return [...new Set([...requested,...compile(table.fecCompatibility.decisionProgram).inputs])].filter(c=>physical.has(c));
}
/** Mutating only the newly decoded row retains hyparquet's row-index symbol. */
export function enrichFecRows<T extends Row>(table: Dataset, rows: T[]): T[] {
  if(table.fecCompatibility){const {run}=compile(table.fecCompatibility.decisionProgram);for(const row of rows)Object.assign(row,run(row));}
  return rows;
}

/** Rebind only the maintained filing and preserved-source routes, without changing historical row pins. */
export function fecNavigation(specs: Navigation[], tables: Dataset[], compatibility?: FecCompatibility): Navigation[] {
  if(!compatibility) {
    const {query,observations}=selected(tables);
    if(!query||!observations||query.artifactDigest===observations.artifactDigest)return specs;
    return specs.map(spec=>{
      const source=tables.find(t=>t.id===spec.source);
      if(!source||source.artifactDigest!==query.artifactDigest)return spec;
      return {...spec,targets:spec.targets.map(target=>{
        const destination=tables.find(t=>t.id===target.table);
        const witnessGuards=target.guards.filter(g=>g.path.join('.')==='witness_generation_pin');
        return Object.hasOwn(preserved,target.table)&&witnessGuards.length
          && !witnessGuards.some(g=>g.sameAs?.literal===destination?.artifactDigest)
          ? {...target,available:false,sourceAvailable:false,unavailableReason:'Source evidence has not been qualified for this release.'}:target;
      })};
    });
  }
  const lookup=new Map(tables.map(t=>[t.id,t]));
  return specs.map(spec=>{
    const source=lookup.get(spec.source);
    if(!source || !samePin(compatibility.queryPin,source))return spec;
    let changed=false;
    const targets=spec.targets.map((target):Target=>{
      const destination=lookup.get(target.table);if(!destination)return target;
      const filing=!!source.fecCompatibility && spec.id===`native_filing_${source.id}` && target.table==='fec_filings' && samePin(compatibility.queryPin,destination)
        && target.guards.some(g=>g.path.join('.')==='filing_association_target_generation_scope'&&g.values?.includes('self'));
      const preservedColumns=compatibility.preservedSourceColumns[target.table];
      const witness=!!preservedColumns && samePin(compatibility.observationsPin,destination) && target.columns.every(c=>preservedColumns.includes(c))
        && target.guards.some(g=>g.path.join('.')==='witness_generation_pin'&&g.sameAs?.literal);
      if(!filing&&!witness)return target;
      const guards=target.guards.map(g=>{
        if(filing&&g.path.join('.')==='filing_association_source_generation_pin'&&g.sameAs?.literal)return {...g,sameAs:{...g.sameAs,literal:compatibility.observationsPin.artifactDigest}};
        if(witness&&g.path.join('.')==='witness_generation_pin'&&g.sameAs?.literal)return {...g,sameAs:{...g.sameAs,literal:compatibility.historicalObservationsPin.artifactDigest}};
        return g;
      });
      const candidate={...target,guards};
      if(navigationColumns({...spec,targets:[candidate]}).some(c=>!source.columns.some(x=>x.name===c)))return target;
      changed=true;
      const directions=target.directions?Object.fromEntries(Object.entries(target.directions).map(([name,value])=>[name,{...value,available:true,measurement:{status:'unknown',scope:'selected compatibility release'}}])) as Target['directions']:undefined;
      return {...candidate,sourceAvailable:true,unavailableReason:undefined,requiredMainFields:target.requiredMainFields?.map(f=>({...f,status:'present'})),directions};
    });
    return changed?{...spec,available:true,unavailableReason:undefined,targets}:spec;
  });
}
