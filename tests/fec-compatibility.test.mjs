import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {build} from 'esbuild';
const {outputFiles}=await build({stdin:{contents:`export * from './lib/fec-compatibility'; export * from './lib/reader'; export * from './lib/navigation'; export * from './lib/catalog'; export * from './lib/record-lookup'; export * from './lib/reader-binding';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const api=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/fec-semantic-fixtures.json',import.meta.url)));
const file=readFileSync(new URL('./fixtures/fec-main.parquet',import.meta.url));
const headerFile=readFileSync(new URL('./fixtures/fec-header.parquet',import.meta.url));
const headerSchema=JSON.parse(readFileSync(new URL('./fixtures/fec-header-schema.json',import.meta.url)));
const sha=c=>'sha256:'+c.repeat(64),pin=c=>({artifactDigest:sha(c),logicalId:'urn:spicy:artifact:spicy-regs-rollup-generation:'+c.repeat(64)});
const queryPin=pin('a'),observationsPin=pin('b'),historicalObservationsPin=pin('c');
const program=structuredClone(fixtures.program);
program.outputs.filing_association_source_generation_pin=['literal',observationsPin.artifactDigest];
program.outputs.filing_association_evidence_generation_pin=['literal',historicalObservationsPin.artifactDigest];
const logicalColumns=Object.keys(program.outputs).map(name=>[name,name==='filing_association_target_count'?'BIGINT':name==='filing_association_target_record_ids'?'VARCHAR[]':'VARCHAR']);
const descriptor={format:'fec-retained-query-serving/1',queryPin,observationsPin,historicalObservationsPin,observationsProofSha256:sha('d'),
  associationPolicy:'fec-retained-filing-association/1',targetMappingVersion:'fec-identity-observations/1',targetIdentityVersion:'fec-typed-observation/1',
  preservedSourceColumns:{fec_collections:['collection_id'],fec_source_records:['collection_id','source_record_id','source_sha256']},
  logicalColumns,tableModes:{fec_receipts:['header','native-file-number']},decisionProgram:program,namespaceEvidence:Object.fromEntries(Object.entries(program.lookups.routes).filter(([,r])=>r.evidence).map(([n,r])=>[n,r.evidence])),filerFields:Object.fromEntries(Object.entries(program.lookups.routes).map(([n,r])=>[n,r.filerField])),numberMappings:Object.fromEntries(Object.entries(program.lookups.routes).map(([n,r])=>[n,r.mapper]))};
const physicalNames=[...new Set([0,2,15,16,17].flatMap(i=>Object.keys(fixtures.cases[i].row)).concat('filing_key'))].sort();
const physicalColumns=physicalNames.map(name=>({name,type:'VARCHAR',description:''}));
const raw={id:'fec_receipts',label:'Receipts',family:'fec-query',...queryPin,rows:6,columns:physicalColumns,members:[],metadataState:'current',recordIdentity:{columns:['record_id'],basis:'declared_main_key',uniqueness:'unknown'},connectionNotes:[]};
const selected=[raw,{...raw,id:'fec_filings'}, {...raw,id:'fec_source_records',family:'fec-observations',...observationsPin}];
const checked=()=>api.validateCompatibility(structuredClone(descriptor),selected,sha('e'));
const bind=()=>api.bindFecCompatibility(selected,checked())[0];
const part=name=>({path:[name],from:'row'});
const route={id:'native_filing_fec_receipts',source:'fec_receipts',mode:'row',fields:[],elementPath:[],ruleVersion:'source-navigation/1',receiptFields:[],meaning:'Retained filing metadata',available:false,
  targets:[{table:'fec_filings',columns:['filing_key'],keys:[{parts:[part('filing_key')],separator:'',pattern:'.+'}],
    guards:[{...part('filing_association_status'),values:['resolved_native_filing_key']},{...part('filing_association_target_generation_scope'),values:['self']},{...part('filing_association_source_generation_pin'),sameAs:{path:[''],from:'row',literal:historicalObservationsPin.artifactDigest}}],
    available:true,sourceAvailable:false,requiredMainFields:[{path:'filing_association_status',status:'missing'}],directions:{forward:{available:false,measurement:{status:'unknown',scope:'unmeasured'},lookup:{status:'unknown',scope:'unknown',requiresExactMatch:true}},reverse:{available:false,measurement:{status:'unknown',scope:'unmeasured'},lookup:{status:'unknown',scope:'unknown',requiresExactMatch:true}}}}]};

test('browser expressions match the maintained SQL fixtures',()=>{
  assert.equal(fixtures.format,'fec-serving-semantic-fixtures/1');
  for(const c of fixtures.cases){const actual=api.evaluateFec(fixtures.program,c.row);for(const [key,value] of Object.entries(c.expected))assert.deepEqual(actual[key],value,`${c.name}: ${key}`);}
});
test('context failures, header precedence, duplicate targets and raw-key override stay explicit',()=>{
  const row=fixtures.cases[0].row;
  assert.equal(api.evaluateFec(program,{...row,source_locator_json:'{}'}).filing_association_status,'unresolved_source_context');
  assert.equal(api.evaluateFec(program,{...row,source_sha256:'wrong'}).filing_key,null);
  const resolved=api.evaluateFec(program,{...row,filing_key:'wrong'});
  assert.equal(resolved.filing_association_target_count,2);
  assert.deepEqual(resolved.filing_association_target_record_ids,['one','two']);
  assert.equal(api.evaluateFec(program,{...row,filing_header_record_id:'absent'}).filing_key,null);
  assert.equal(api.evaluateFec(program,{...row,report_number:'123\n'}).filing_key,null);
  assert.equal(api.evaluateFec(program,{...row,report_number:123n}).filing_key,null);
});
test('descriptor binds both exact pins and only extends the logical main schema',()=>{
  const bound=bind();assert.deepEqual(bound.physicalColumns,raw.columns);assert.notEqual(bound.columns,raw.columns);
  assert.ok(bound.columns.some(c=>c.name==='filing_association_status'));
  assert.equal(raw.columns.some(c=>c.name==='filing_association_status'),false);
  assert.notEqual(api.subjectBinding(raw),api.subjectBinding(bound));
  assert.notEqual(api.subjectBinding(bound),api.subjectBinding({...bound,fecCompatibility:{...bound.fecCompatibility,sha256:sha('f')}}));
  for(const mutate of [d=>d.queryPin=pin('f'),d=>d.queryPin.logicalId=pin('f').logicalId,d=>d.observationsPin=pin('f'),d=>d.observationsProofSha256='wrong',d=>d.format='next',d=>d.preservedSourceColumns.fec_source_records=['source_record_id'],d=>d.decisionProgram.outputs.filing_key=['execute','bad'],d=>d.logicalColumns.push(['surprise','VARCHAR'])]){
    const d=structuredClone(descriptor);mutate(d);assert.throws(()=>api.validateCompatibility(d,selected,sha('e')));
  }
  const bad=structuredClone(descriptor);bad.decisionProgram.outputs.filing_key=['regex',['literal','x'],['literal','(x+)+']];assert.throws(()=>api.validateCompatibility(bad,selected,sha('e')));
  assert.deepEqual(api.bindFecCompatibility(selected),selected);
});
test('only qualified main filing routes regain navigation; measurements remain unknown',()=>{
  const bound=api.bindFecCompatibility(selected,checked());
  const routes=api.usableNavigation(api.fecNavigation([route],bound,checked()),bound);
  assert.equal(routes[0].targets[0].available,true);
  assert.equal(routes[0].targets[0].directions.reverse.available,true);
  assert.equal(routes[0].targets[0].directions.forward.measurement.status,'unknown');
  assert.equal(api.usableNavigation([route],selected)[0].targets[0].available,false);
});
test('metadata checks physical schema while qualified routes use logical main fields',()=>{
  const tables=api.bindFecCompatibility(selected,checked());
  const bundle={generatedAt:'2026-10-16T00:00:00Z',publication:{families:{'fec-query':queryPin.artifactDigest,'fec-observations':observationsPin.artifactDigest}},joins:[],navigation:[route],
    tables:Object.fromEntries(selected.map(t=>[t.id,{family:t.family,publicationSchema:t.columns.map(c=>[c.name,c.type]),metadataStatus:'documented',sourceStatus:'documented',sources:[],inputs:[]}]))};
  const result=api.applyMetadata(tables,bundle,checked());
  assert.equal(result.tables.find(t=>t.id===raw.id).metadataState,'current');
  assert.equal(result.navigation[0].targets[0].available,true);
  const incompatible=structuredClone(bundle);incompatible.tables.fec_receipts.publicationSchema.push(['unexpected','VARCHAR']);
  const refused=api.applyMetadata(tables,incompatible,checked());assert.equal(refused.tables.find(t=>t.id===raw.id).metadataState,'incompatible');assert.equal(refused.navigation.length,0);
});
test('header-self aliases are projected and evaluated through the producer program',()=>{
  const financial=fixtures.cases.find(c=>c.name==='header-match').row;
  const {filing_header_record_id,filing_header_locator_json,...rest}=financial;
  const row={...rest,header_record_id:filing_header_record_id,header_locator_json:filing_header_locator_json};
  assert.equal(api.evaluateFec(program,row).filing_key,fixtures.cases[0].expected.filing_key);
  const table={...raw,id:'fec_filing_header_associations',columns:Object.keys(row).map(name=>({name,type:'VARCHAR'}))};
  const compat={...checked(),tableModes:{fec_filing_header_associations:['header']}};
  const bound=api.bindFecCompatibility([table],compat)[0];assert.ok(bound.fecCompatibility);
  assert.ok(api.fecReadColumns(bound,['filing_key']).includes('header_record_id'));
  assert.equal(api.fecReadColumns(bound,['filing_key']).includes('filing_header_record_id'),false);
});
test('preserved source bridge retains historical witness values and fails closed without qualification',()=>{
  const source={...selected[1],id:'fec_record_evidence',columns:['collection_id','source_record_id','source_sha256','witness_generation_pin'].map(name=>({name,type:'VARCHAR'}))};
  const observations={...selected[2],columns:['collection_id','source_record_id','source_sha256'].map(name=>({name,type:'VARCHAR'}))};
  const witness={...route,id:'receipt_fec_record_evidence_source_record_id',source:source.id,available:true,targets:[{table:observations.id,columns:['collection_id','source_record_id','source_sha256'],
    keys:['collection_id','source_record_id','source_sha256'].map(name=>({parts:[part(name)],separator:'',pattern:'.+'})),guards:[{...part('witness_generation_pin'),sameAs:{path:[''],from:'row',literal:observationsPin.artifactDigest}}],available:true,sourceAvailable:true}]};
  const tables=[source,selected[1],observations], row={collection_id:'c',source_record_id:'r',source_sha256:sha('f'),witness_generation_pin:historicalObservationsPin.artifactDigest};
  const oldWitness={...witness,targets:[{...witness.targets[0],guards:[{...part('witness_generation_pin'),sameAs:{path:[''],from:'row',literal:historicalObservationsPin.artifactDigest}}]}]};
  const unqualified=api.usableNavigation(api.fecNavigation([oldWitness],tables),tables);assert.equal(unqualified[0].targets[0].available,false);
  const oldTables=[source,selected[1],{...observations,...historicalObservationsPin}];
  assert.equal(api.usableNavigation(api.fecNavigation([oldWitness],oldTables),oldTables)[0].targets[0].available,true);
  const bridged=api.usableNavigation(api.fecNavigation([witness],tables,checked()),tables);assert.equal(bridged[0].targets[0].available,true);
  assert.equal(api.forwardLinks(bridged[0],row).length,1);assert.equal(row.witness_generation_pin,historicalObservationsPin.artifactDigest);
  assert.equal(api.forwardLinks(bridged[0],{...row,witness_generation_pin:sha('f')}).length,0);
  const unknown={...witness,targets:[{...witness.targets[0],columns:['unsupported_key']}]};assert.equal(api.fecNavigation([unknown],tables,checked())[0].targets[0].guards[0].sameAs.literal,observationsPin.artifactDigest);
});

const server=createServer((req,res)=>{
  const pathname=new URL(req.url,'http://local').pathname;
  if(pathname==='/main.parquet'||pathname==='/header.parquet'){
    const body=pathname==='/main.parquet'?file:headerFile;
    res.setHeader('etag','"fixture"');const m=/bytes=(\d+)-(\d+)/.exec(req.headers.range??'');
    if(m){const start=+m[1],end=+m[2];res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${body.length}`});res.end(body.subarray(start,end+1));}
    else{res.writeHead(200,{'Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);}return;
  }
  if(pathname.startsWith('/missing/')){res.writeHead(404).end();return;}
  if(pathname.startsWith('/oversize/')){res.writeHead(200,{'Content-Length':8*1024*1024+1}).end();return;}
  if(pathname.startsWith('/stream/')){res.writeHead(200);res.end(' '.repeat(8*1024*1024+1));return;}
  if(pathname.startsWith('/bad/')){res.writeHead(200).end('{');return;}
  if(pathname.startsWith('/wrong/')){res.writeHead(200).end(JSON.stringify({...descriptor,observationsPin:pin('f')}));return;}
  res.writeHead(200).end(JSON.stringify(descriptor));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
test('HTTP discovery is pair-derived, bounded and fails closed',async()=>{
  const loaded=await api.loadFecCompatibility(selected,base);assert.match(loaded.sha256,/^sha256:[0-9a-f]{64}$/);
  assert.equal(await api.loadFecCompatibility(selected,base+'/missing'),undefined);
  assert.equal(await api.loadFecCompatibility([],base),undefined);
  for(const path of ['/oversize','/stream','/bad','/wrong'])await assert.rejects(api.loadFecCompatibility(selected,base+path));
});
test('real Parquet main relation enriches before filter, reverse connection, sort, detail and audit',async()=>{
  const table={...bind(),members:[{url:base+'/main.parquet',rows:6,byteSize:file.length,etag:'fixture'}]};
  const key=fixtures.cases[0].expected.filing_key;
  const request={table,columns:['record_id','filing_key','filing_association_status'],filters:[],cursor:0,limit:40};
  const all=await api.readPage(request);assert.equal(all.rows.length,6);assert.deepEqual(all.positions,[0,1,2,3,4,5]);
  assert.deepEqual(all.rows.map(r=>r.filing_key),[key,null,null,key,null,key]);
  const filtered=await api.readPage({...request,filters:[{column:'filing_key',value:key}]});assert.deepEqual(filtered.positions,[0,3,5]);
  const navigation=api.fecNavigation([route],[table,selected[1],selected[2]],checked())[0];
  assert.equal(api.forwardLinks(navigation,all.rows[0]).length,1);assert.equal(api.forwardLinks(navigation,all.rows[1]).length,0);
  const reverse=await api.readPage({...request,connection:{id:route.id,target:0,values:[key]},navigation});assert.deepEqual(reverse.positions,[0,3,5]);
  const sorted=await api.readPage({...request,sort:{column:'filing_association_status',direction:'asc'},limit:2});assert.deepEqual(sorted.positions,[0,3]);
  const next=await api.readPage({...request,sort:{column:'filing_association_status',direction:'asc'},cursor:sorted.cursor,limit:2});assert.equal(next.positions[0],5);
  const detail=await api.readPage({...request,columns:table.columns.map(c=>c.name),cursor:3,limit:1});assert.equal(detail.rows[0].filing_key,key);assert.equal(detail.rows[0].filing_association_source_generation_pin,observationsPin.artifactDigest);
  const batches=[];await api.readColumnBatches(table,['filing_key'],6,rows=>batches.push(...rows));assert.deepEqual(batches.map(r=>r.filing_key),all.rows.map(r=>r.filing_key));
  const lookup=await api.lookupRecord({...table,recordIdentity:{columns:['source_record_id']}},[{column:'source_record_id',value:'native-row'}]);assert.equal(lookup.status,'ambiguous');
  const rawPage=await api.readPage({...request,table:{...raw,members:table.members},columns:['filing_key']});assert.ok(rawPage.rows.every(r=>r.filing_key==='unqualified-raw-key'));
});
test('header-self uses the exact selected physical schema through Parquet and record lookup',async()=>{
  const header={...raw,id:'fec_filing_header_associations',rows:1,columns:headerSchema.map(([name,type])=>({name,type})),members:[{url:base+'/header.parquet',rows:1,byteSize:headerFile.length,etag:'fixture'}]};
  const compatibility={...checked(),tableModes:{[header.id]:['header']}};
  const table=api.bindFecCompatibility([header],compatibility)[0];assert.ok(table.fecCompatibility);
  const page=await api.readPage({table,columns:table.columns.map(c=>c.name),filters:[],cursor:0,limit:1});
  assert.equal(page.rows[0].filing_key,fixtures.cases[0].expected.filing_key);
  assert.equal(page.rows[0].header_record_id,'header');assert.equal(page.rows[0].filing_association_status,'resolved_native_filing_key');
  const detail=await api.lookupRecord(table,[{column:'record_id',value:page.rows[0].record_id}]);
  assert.equal(detail.status,'found');assert.equal(detail.row.filing_key,page.rows[0].filing_key);
});
test.after(()=>server.close());
