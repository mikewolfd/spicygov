import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { validatePublicDirectory } from '../scripts/catalog-public-validation.mjs';
import { catalogOpsMiddleware, isLoopback, loopbackHost } from '../scripts/catalog-ops-server.mjs';
const producerPython = process.env.SOURCE_CATALOG_PYTHON || 'python3';
const producerSource = process.env.SOURCE_CATALOG_PYTHONPATH || '../spicy-regs/src';

function exportWithProducer(name, input) {
 const result = spawnSync(producerPython, ['-B', '-c', `import json,sys; from spicy_regs.source_catalog.exporter import ${name}; print(json.dumps(${name}(json.load(sys.stdin))))`], {
  input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000,
  env: {...process.env, PYTHONPATH: producerSource, PYTHONNOUSERSITE: '1'},
 });
 assert.ifError(result.error);
 assert.equal(result.status, 0, `Catalog producer failed (Python: ${producerPython}, source: ${producerSource}, signal: ${result.signal ?? 'none'}):\n${result.stderr}`);
 return JSON.parse(result.stdout);
}

const built = await build({entryPoints:['lib/source-catalog.ts'],bundle:true,platform:'node',format:'esm',write:false});
const { parseCatalogManifest, parseCatalogDetail, parseCatalogFilePage, catalogPartitionUrl, SourceCatalogReader, parseCatalogParquet } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const generation = 'sha256:'+'a'.repeat(64), otherGeneration = 'sha256:'+'b'.repeat(64);
const item = { id:'unintegrated',title:'Held collection without publication',statuses:['held','unintegrated'],families:[],tables:[],routeCount:2,holdings:{aliases:1,objects:1,decodedBytes:10,missing:0},periods:[],detailPath:'generations/a/collections/unintegrated.json' };
const manifest = { format:'spicy-source-catalog',version:1,generation,generatedAt:'2026-10-10T00:00:00Z',collections:[item],totals:{collections:1} };
const route = { id:'legacy',label:'Historical bulk',deliveryMethod:'bulk',lifecycle:'legacy',custodian:'publisher',contentBehavior:'snapshot',periods:[{kind:'edition',label:'Historical edition',basis:'Retained publisher listing'}] };
const detail = { format:'spicy-source-collection',version:1,generation,collection:item,routes:[route,{...route,id:'api',label:'Current API',deliveryMethod:'api',lifecycle:'active',periods:[]}],tables:[],files:{pages:[{path:'generations/a/files/0.json',rows:1}],total:1},planned:[{id:'plan',status:'unassigned',reason:'Mapping unresolved'}],observations:[],relationships:[] };
const page = { format:'spicy-source-files',version:1,generation,collectionId:item.id,files:[{id:'alias',name:'original.zip',status:'held',bytes:10}] };
const reconciliation = {scope:'current',version:generation,status:'verified',sourceFiles:2,matchedSourceFiles:2,missingSourceFiles:0,capturedSourceFiles:2,inputClosureComplete:true,reasons:[],evidenceLinks:[{label:'Build receipt',url:'https://data.example/build.json'}]};
test('reconciliation reader and producer retain exact versions, counts and public evidence only', () => {
 const publication=exportWithProducer('public_reconciliation',{...reconciliation,localFileIds:['private'],evidenceIds:['receipt'],raw:{localPath:'/home/private'}});
 assert.deepEqual(publication,reconciliation);
 const parsed=parseCatalogDetail({...detail,tables:[{id:'table',family:'family',status:'published',artifactDigest:generation,publication}]},generation,item.id);
 assert.equal(parsed.tables[0].publication.matchedSourceFiles,2);
 for (const bad of [{...publication,version:otherGeneration},{...publication,sourceFiles:0,matchedSourceFiles:0},{...publication,missingSourceFiles:1},{...publication,localFileIds:['private']},{...publication,evidenceLinks:[{label:'Private',url:'https://data.example/build.json?token=private'}]}]) {
  assert.throws(()=>parseCatalogDetail({...detail,tables:[{id:'table',family:'family',status:'published',artifactDigest:generation,publication:bad}]},generation,item.id));
 }
});
test('maintained reconciliation importer and exporter produce details accepted by the browser reader', async () => {
 // Build a finite fixture through producer APIs; CI does not need producer test modules or pytest.
 const result=spawnSync(producerPython,['-B','-c',`
import base64,json,tempfile
from pathlib import Path
from spicy_regs.source_catalog.publication import reconcile
from spicy_regs.source_catalog.exporter import export
from spicy_regs.source_catalog.storage import connect,digest,schema

def write_pin(path,value):
    path.write_text(json.dumps(value))
    return {'path':str(path),'sha256':digest(path),'bytes':path.stat().st_size}

with tempfile.TemporaryDirectory() as folder:
    root=Path(folder)
    original=root/'original.txt'
    original.write_bytes(b'original')
    original_sha=digest(original)
    original_bytes=original.stat().st_size
    version='sha256:'+'a'*64
    output_sha='sha256:'+'b'*64
    base=root/'base.sqlite'
    with connect(base) as db:
        schema(db)
        db.execute("INSERT INTO metadata VALUES('generation',?)",(json.dumps('sha256:'+'0'*64),))
        db.execute("INSERT INTO collections VALUES('family:test','Test',?)",(json.dumps({'families':['test']}),))
        db.execute('INSERT INTO objects VALUES(?,?)',(original_sha,original_bytes))
        db.execute("INSERT INTO files VALUES('raw:one','family:test',NULL,'original','held',?,?,?,?)",(
            original_sha,original_bytes,str(original),json.dumps({'encoded_bytes':original_bytes,'presence_mtime_ns':original.stat().st_mtime_ns})))
    descriptor={'sha256':output_sha,'byteSize':4,'rows':1,'columns':[['id','VARCHAR']]}
    publication={'format':'spicy-regs-publication','version':1,'families':{'test':{
        'prefix':'generations/test/'+'a'*64,'logicalId':'urn:test','artifactDigest':version,
        'tables':{'one.parquet':descriptor}}}}
    receipt={'family':'test','artifact_digest':version,'complete':False,'conflicts':[],
        'outputs':[{'table':'one','object_key':'one.parquet','sha256':output_sha,'bytes':4}],
        'sources':[{'sha256':original_sha,'bytes':original_bytes,'provenance':'build-consumption'}],'parents':[]}
    selection={'format':'spicy-publication-reconciliation','version':1,
        'publication':write_pin(root/'publication.json',publication),
        'receipts':[write_pin(root/'receipts.json',{'format':'spicy-publication-inputs','version':1,'generations':[receipt]})]}
    selection_path=root/'selection.json'
    write_pin(selection_path,selection)
    index=root/'selected.sqlite'
    reconcile(base,index,selection_path)
    output=root/'public'
    manifest=export(index,output)
    details=[json.loads((output/item['detailPath']).read_text()) for item in manifest['collections']]
    pages=[{'part':page,'collectionId':item['collection']['id'],'body':base64.b64encode((output/page['path']).read_bytes()).decode()}
           for item in details for page in item['files']['pages']]
    print(json.dumps({'manifest':manifest,'details':details,'pages':pages}))
`],{encoding:'utf8',timeout:30_000,env:{...process.env,PYTHONPATH:producerSource,PYTHONNOUSERSITE:'1'}});
 assert.ifError(result.error); assert.equal(result.status,0,result.stderr);
 const produced=JSON.parse(result.stdout), manifest=parseCatalogManifest(produced.manifest);
 const details=produced.details.map(raw=>parseCatalogDetail(raw,manifest.generation,raw.collection.id));
 for(const raw of produced.pages) {
  const body=Buffer.from(raw.body,'base64');
  const page=await parseCatalogParquet(body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength),{generation:manifest.generation,collectionId:raw.collectionId,inventoryKind:'active',part:raw.part});
  assert.equal(page.files.length,raw.part.rows);
 }
 const row=details.flatMap(detail=>detail.tables).find(table=>table.id==='one');
 assert.equal(row.status,'publication-pinned');
 assert.equal(row.publication.status,'missing_provenance');
 assert.equal(row.publication.matchedSourceFiles,1);
});
test('reconciliation display qualifies verified results against the selected live publication', async () => {
 const {createRequire}=await import('node:module'); const {createElement}=await import('react'); const {renderToStaticMarkup}=await import('react-dom/server');
 const ui=await build({entryPoints:['components/source-catalog.tsx'],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime']});
 const loaded={exports:{}}; new Function('require','module','exports',ui.outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
 const destination={id:'table',family:'family',status:'published',artifactDigest:generation,publication:reconciliation};
 const render=artifactDigest=>renderToStaticMarkup(createElement(loaded.exports.TableDestinations,{destinations:[destination],tables:[{id:'table',label:'Table',artifactDigest}]}));
 assert.match(render(generation),/Build records complete for the checked publication/);
 const stale=render(otherGeneration); assert.match(stale,/historical build records describe an earlier publication/); assert.ok(!stale.includes('Build records complete for the checked publication')); assert.ok(stale.includes(generation)); assert.ok(stale.includes(otherGeneration));
 assert.match(render(undefined),/Current publication identity could not be compared/);
 assert.match(render(generation),/2 of 2 exact historical file references/);
 const reasons=['capture-observation-does-not-prove-build-consumption','incomplete-build-input-provenance','unknown-future-reason'];
 const unverified={...destination,publication:{...reconciliation,status:'missing_provenance',inputClosureComplete:false,reasons}};
 const readable=renderToStaticMarkup(createElement(loaded.exports.TableDestinations,{destinations:[unverified],tables:[{id:'table',label:'Table',artifactDigest:generation}]}));
 assert.match(readable,/An acquisition record shows the file was captured/);
 assert.match(readable,/The build does not document every required original input/);
 assert.match(readable,/Additional source evidence needs review/);
 for(const code of reasons) assert.ok(!readable.includes(code));
 assert.deepEqual(unverified.publication.reasons,reasons);
});
test('upstream and held collections remain independent of publication; routes retain their different periods', () => {
 assert.equal(parseCatalogManifest(manifest).collections[0].tables.length,0);
 const parsed = parseCatalogDetail(detail,generation,item.id); assert.equal(parsed.routes[0].periods[0].kind,'edition'); assert.equal(parsed.routes[1].periods.length,0); assert.equal(parsed.planned[0].status,'unassigned');
});
test('reader loads manifest, chosen detail and one chosen file page only', async () => {
 const urls=[]; const fetcher = async url => { urls.push(url); return new Response(JSON.stringify(urls.length===1?manifest:urls.length===2?detail:page)); };
 const reader = new SourceCatalogReader('https://data.example/source-catalog/manifest.json',false,fetcher);
 const selected = await reader.manifest(); assert.equal(urls.length,1);
 const selectedDetail = await reader.detail(selected,selected.collections[0]); assert.equal(urls.length,2);
 const files=await reader.files(selected,selectedDetail,0); assert.equal(urls.length,3); assert.equal(files.files[0].id,'alias'); assert.equal(urls[2],'https://data.example/source-catalog/generations/a/files/0.json');
});
test('generation drift, mismatched collection, malformed totals and duplicate IDs fail explicitly', () => {
 assert.throws(()=>parseCatalogDetail({...detail,generation:otherGeneration},generation,item.id),/generation changed/);
 assert.throws(()=>parseCatalogFilePage(page,generation,'other',1),/collection mismatch/);
 assert.throws(()=>parseCatalogDetail({...detail,files:{...detail.files,total:2}},generation,item.id),/partitions/);
 assert.throws(()=>parseCatalogManifest({...manifest,collections:[item,item]}),/Duplicate/);
 assert.throws(()=>parseCatalogManifest({}),/version/);
 assert.throws(()=>parseCatalogManifest({...manifest,version:4}),/version/);
});
test('public metadata refuses local fields and credential-bearing route URLs', () => {
 for (const bad of [{...manifest,audience:'internal'},{...manifest,localPath:'/Users/private'},{...manifest,collections:[{...item,description:'/home/user/corpus/file'}]}]) assert.throws(()=>parseCatalogManifest(bad));
 assert.throws(()=>parseCatalogDetail({...detail,routes:[{...route,accessUrl:'https://example.test/?api_key=secret'}]},generation,item.id),/Credential/);
 assert.throws(()=>parseCatalogFilePage({...page,files:[{...page.files[0],localPath:'/private/corpus'}]},generation,item.id,1),/Internal/);
 const internal = parseCatalogFilePage({...page,audience:'internal',files:[{...page.files[0],localPath:'/private/corpus',encodedBytes:5,verification:'verified'}]},generation,item.id,1,true); assert.equal(internal.files[0].localPath,'/private/corpus');
});
test('partition references cannot traverse, encode traversal, change origin or carry query credentials', () => {
 for (const path of ['../private.json','/private.json','https://other.test/a.json','a/%2e%2e/private.json','a\\private.json','a.json?token=secret','a//b.json']) assert.throws(()=>catalogPartitionUrl('https://data.example/catalog/manifest.json',path),/Unsafe/);
 assert.equal(catalogPartitionUrl('https://data.example/catalog/manifest.json','generation/files.json'),'https://data.example/catalog/generation/files.json');
});
test('failed requests surface catalog errors instead of empty successful universes', async () => {
 await assert.rejects(new SourceCatalogReader('/manifest.json',false,async()=>new Response('',{status:404})).manifest(),/404/);
});
test('production artifact validation rejects an internal export and symlink escape', async () => {
 const root = await mkdtemp(join(tmpdir(),'catalog-public-')); const folder=join(root,'source-catalog'); await mkdir(folder);
 try { await writeFile(join(folder,'manifest.json'),JSON.stringify({...manifest,collections:[]})); await validatePublicDirectory(root); await writeFile(join(folder,'manifest.json'),JSON.stringify({...manifest,audience:'internal'})); await assert.rejects(validatePublicDirectory(root),/Internal/); await rm(join(folder,'manifest.json')); await symlink('/tmp',join(folder,'external')); await assert.rejects(validatePublicDirectory(root),/symlink/); } finally { await rm(root,{recursive:true,force:true}); }
});
test('operations server restricts host, method, traversal and symlinks while reading exact internal partitions', async () => {
 assert.equal(isLoopback('10.0.0.1'),false); assert.equal(loopbackHost('localhost.attacker.test'),false);
 const root=await mkdtemp(join(tmpdir(),'catalog-ops-')); await writeFile(join(root,'manifest.json'),JSON.stringify({...manifest,audience:'internal'})); await symlink('/etc/passwd',join(root,'escape.json'));
 const middleware=await catalogOpsMiddleware(root); const server=createServer((req,res)=>{ void middleware(req,res,()=>{res.statusCode=404;res.end();}); }); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const url=`http://127.0.0.1:${server.address().port}`;
 try {
  assert.equal((await fetch(url+'/__source-catalog-internal/manifest.json')).status,200);
  assert.equal(await new Promise((resolve,reject) => { const req = request(url+'/__source-catalog-internal/manifest.json',{headers:{host:'attacker.example'}},res => { res.resume(); resolve(res.statusCode); }); req.on('error',reject); req.end(); }),403);
  assert.equal((await fetch(url+'/__source-catalog-internal/manifest.json',{headers:{origin:'https://attacker.example'}})).status,403);
  assert.equal((await fetch(url+'/__source-catalog-internal/manifest.json',{method:'POST'})).status,405);
  assert.equal((await fetch(url+'/__source-catalog-internal/%2e%2e/private.json')).status,404);
  assert.equal((await fetch(url+'/__source-catalog-internal/escape.json')).status,404);
 } finally { await new Promise(resolve=>server.close(resolve)); await rm(root,{recursive:true,force:true}); }
});

test('oversized declared and streamed responses fail before parsing or displaying data', async () => {
 const declared = new SourceCatalogReader('/manifest.json',false,async()=>new Response('{}',{headers:{'content-length':String(17*1024*1024)}}));
 await assert.rejects(declared.manifest(),/16 MiB/);
 let count=0, cancelled=false;
 const streamed = new SourceCatalogReader('/manifest.json',false,async()=>new Response(new ReadableStream({pull(controller){count++; controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}})));
 await assert.rejects(streamed.manifest(),/16 MiB/); assert.equal(cancelled,true); assert.ok(count<=18);
});

test('logical file hash IDs remain public while filesystem URIs are rejected', () => {
 const id = 'file:'+'c'.repeat(64);
 assert.equal(parseCatalogFilePage({...page,files:[{...page.files[0],id}]},generation,item.id,1).files[0].id,id);
 assert.throws(()=>parseCatalogFilePage({...page,files:[{...page.files[0],id:'file:///home/private'}]},generation,item.id,1),/Local path/);
 assert.throws(()=>parseCatalogManifest({...manifest,collections:[{...item,description:id}]}),/Local path/);
});

test('validator CLI reports a concise artifact error with a nonzero exit', async () => {
 const root=await mkdtemp(join(tmpdir(),'catalog-cli-'));
 try { await writeFile(join(root,'manifest.json'),JSON.stringify({...manifest,audience:'internal'})); const result=spawnSync(process.execPath,['scripts/catalog-public-validation.mjs',root],{encoding:'utf8'}); assert.equal(result.status,1); assert.match(result.stderr,/manifest.json: Internal/); assert.ok(result.stderr.length<1024); assert.equal(result.stderr.includes('data:text/javascript'),false); } finally { await rm(root,{recursive:true,force:true}); }
});

test('default reader invokes browser fetch with the global receiver', async () => {
 const original=globalThis.fetch;
 try { globalThis.fetch=function(){ assert.equal(this,globalThis); return Promise.resolve(new Response(JSON.stringify(manifest))); }; const result=await new SourceCatalogReader('/manifest.json').manifest(); assert.equal(result.generation,generation); } finally { globalThis.fetch=original; }
});

test('catalog deadline aborts stalled headers and allows a successful retry', async () => {
 let attempts=0, requestSignal;
 const reader=new SourceCatalogReader('/manifest.json',false,async (_url,init)=>{
  attempts++;requestSignal=init.signal;
  return attempts===1 ? new Promise(()=>{}) : new Response(JSON.stringify(manifest));
 },20);
 await assert.rejects(reader.manifest(),/timed out.*Try again/);
 assert.equal(requestSignal.aborted,true);
 assert.equal((await reader.manifest()).generation,generation);
 assert.equal(requestSignal.aborted,false);
});

test('catalog deadline covers stalled body reads and cancels the stream', async () => {
 let cancelled=false;
 const reader=new SourceCatalogReader('/manifest.json',false,async()=>new Response(new ReadableStream({
  start(controller){controller.enqueue(new TextEncoder().encode('{"format":'));},
  cancel(){cancelled=true;}
 })),20);
 await assert.rejects(reader.manifest(),/timed out/);
 assert.equal(cancelled,true);
});

test('caller cancellation remains distinct from a deadline and skips pre-aborted reads', async () => {
 const before=new AbortController();before.abort();
 let calls=0;
 const reader=new SourceCatalogReader('/manifest.json',false,async()=>{calls++;return new Promise(()=>{});},1000);
 await assert.rejects(reader.manifest(before.signal),{name:'AbortError'});assert.equal(calls,0);
 const during=new AbortController(), pending=reader.manifest(during.signal);
 during.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,1);
});

const unknownStage = {status:'unknown',measurements:[]};
const measurement = {count:1,unit:'captured-table-artifact-version',version:generation,evidenceBasis:'Retained publication snapshot; no live readback',scope:{table:'structure',capturedAt:'2026-10-09T00:00:00Z'},period:null};
const coverage = {completenessDenominator:null,stages:{expected:unknownStage,advertised:unknownStage,acquired:unknownStage,processed:unknownStage,published:{status:'evidence-recorded',measurements:[measurement]}}};
test('reader accepts independently scoped coverage and destination links, and older details remain readable', () => {
 const parsed = parseCatalogDetail({...detail,coverage,planned:[{id:'code',status:'implemented-scoped-local',destinationIds:['current','historical']}]},generation,item.id);
 assert.equal(parsed.coverage.stages.expected.status,'unknown');
 assert.equal(parsed.coverage.stages.published.measurements[0].version,generation);
 assert.deepEqual(parsed.planned[0].destinationIds,['current','historical']);
 assert.equal(parseCatalogDetail(detail,generation,item.id).coverage,undefined);
});
test('coverage rejects unsupported fields, incomplete stages, empty scope and fabricated denominators', () => {
 for (const bad of [
  {...coverage,completenessDenominator:100},
  {...coverage,stages:{published:coverage.stages.published}},
  {...coverage,stages:{...coverage.stages,expected:{status:'complete',measurements:[]}}},
  {...coverage,stages:{...coverage.stages,published:{status:'unknown',measurements:[measurement]}}},
  {...coverage,stages:{...coverage.stages,published:{status:'evidence-recorded',measurements:[{...measurement,scope:{}}]}}},
  {...coverage,stages:{...coverage.stages,published:{status:'evidence-recorded',measurements:[{...measurement,scope:{query:{agency:'X'}}}]}}},
  {...coverage,stages:{...coverage.stages,published:{status:'evidence-recorded',measurements:[{...measurement,period:{raw:'private'}}]}}},
  {...coverage,stages:{...coverage.stages,published:{status:'evidence-recorded',measurements:[{...measurement,verification:'internal'}]}}},
  {...coverage,stages:{...coverage.stages,published:{status:'evidence-recorded',measurements:[{...measurement,version:'https://example.test/?signature=secret'}]}}},
 ]) assert.throws(()=>parseCatalogDetail({...detail,coverage:bad},generation,item.id));
 assert.throws(()=>parseCatalogDetail({...detail,planned:[{id:'code',status:'implemented',destinationIds:'current'}]},generation,item.id),/array/);
});
test('Python public coverage producer is accepted by the maintained TypeScript reader', () => {
 const input = {stages:Object.fromEntries(['expected','advertised','acquired','processed','published'].map(stage=>[stage,{status:'unknown',measurements:[]}]))};
 input.stages.processed = {status:'evidence-recorded',measurements:[{count:1,unit:'qualified-candidate-table-version',scope:{collection_id:item.id,table:'structure',qualification_scope:'Title 1 only'},version:generation,verification:'Recorded qualification; no publication inference',period:null,evidence_ids:['/Users/private/proof']}]};
 const exported = exportWithProducer('public_coverage', input);
 const parsed = parseCatalogDetail({...detail,coverage:exported},generation,item.id);
 assert.equal(parsed.coverage.stages.processed.measurements[0].scope.qualificationScope,'Title 1 only');
 assert.equal(parsed.coverage.stages.published.status,'unknown');
});

test('coverage presentation shows stage uncertainty, scoped versions and unpublished candidates without another fetch', async () => {
 const { createRequire } = await import('node:module');
 const { createElement } = await import('react');
 const { renderToStaticMarkup } = await import('react-dom/server');
 const output=await build({entryPoints:['components/source-catalog.tsx'],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime']});
 const loaded={exports:{}};
 new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
 const data={...coverage,stages:{...coverage.stages,processed:{status:'evidence-recorded',measurements:[{...measurement,unit:'qualified-candidate-table-version',scope:{table:'structure',qualificationScope:'Title 1 native structure only'},evidenceBasis:'Recorded local qualification; no publication inference'}]},published:unknownStage}};
 const html=renderToStaticMarkup(createElement(loaded.exports.CoverageAccounting,{coverage:data}));
 for (const label of ['Expected','Advertised','Acquired','Processed','Published','Title 1 native structure only','Covered period unknown.','Expected inventories and retained-file counts can use different units']) assert.ok(html.includes(label),label);
 assert.ok(html.includes(generation));
});

const publicationObservation = {
 id:'publication:fixture',family:'laws',captureAt:'2026-10-10T19:54:12.354210+00:00',familyPublishedAt:'2026-10-10T01:36:31Z',serverDate:'2026-10-10T19:54:12+00:00',responseSha256:generation,artifactDigest:otherGeneration,artifactPrefix:'generations/laws/'+ 'b'.repeat(64),associationStatus:'exact-family',tables:[{table:'table3_records.parquet',bytes:54080,rows:2983,sha256:generation}],
};
test('retained publication is optional and preserves historical tables, coverage and separate timestamps', () => {
 const historic = {...detail,tables:[{id:'table3_records',family:'laws',status:'publication-pinned',artifactDigest:generation}]};
 const parsed = parseCatalogDetail({...historic,publicationObservations:[publicationObservation]},generation,item.id);
 assert.deepEqual(parsed.tables,historic.tables); assert.equal(parsed.publicationObservations[0].artifactDigest,otherGeneration);
 assert.notEqual(parsed.publicationObservations[0].captureAt,parsed.publicationObservations[0].serverDate);
 assert.equal(parseCatalogDetail(detail,generation,item.id).publicationObservations,undefined);
});
test('retained publication reader accepts exact partitions and rejects ambiguous identities and internal fields', () => {
 const partition = {...publicationObservation,associationStatus:'unqualified',tables:[{table:'bill_sections.parquet',bytes:4,rows:2,partitionColumns:['congress'],members:[{key:'bill_sections/congress=119/part-000.parquet',partition:{congress:'119'},bytes:4,rows:2,sha256:generation}]}]};
 const parsed = parseCatalogDetail({...detail,publicationObservations:[partition]},generation,item.id);
 assert.equal(parsed.publicationObservations[0].tables[0].members[0].partition.congress,'119');
 const cases = [
  {...partition,captureAt:'2026-10-10T19:54:12'},
  {...partition,associationStatus:'qualified-current'},
  {...partition,artifactDigest:'sha256:bad'},
  {...partition,tables:[{...partition.tables[0],sha256:generation}]},
  {...partition,tables:[{...partition.tables[0],rows:3}]},
  {...partition,tables:[{...partition.tables[0],members:[{...partition.tables[0].members[0],key:'../escape'}]}]},
  {...partition,tables:[{...partition.tables[0],members:[{...partition.tables[0].members[0],partition:{year:'119'}}]}]},
  {...partition,localPath:'/Users/private/retained.json'},
 ];
 for (const row of cases) assert.throws(()=>parseCatalogDetail({...detail,publicationObservations:[row]},generation,item.id));
 assert.throws(()=>parseCatalogDetail({...detail,publicationObservations:[partition,partition]},generation,item.id),/Duplicate/);
});
test('retained publication display states qualification limits and every distinct time', async () => {
 const ui = await build({entryPoints:['components/source-catalog.tsx'],bundle:true,platform:'node',format:'esm',write:false,external:['react','react-dom/server'],jsx:'automatic'});
 const folder = await mkdtemp(join(tmpdir(),'catalog-publication-ui-'));
 try {
  await symlink(join(process.cwd(),'node_modules'),join(folder,'node_modules'),'dir');
  await writeFile(join(folder,'ui.mjs'),ui.outputFiles[0].contents);
  const {RetainedPublications} = await import('file://'+join(folder,'ui.mjs'));
  const React = await import('react'); const {renderToStaticMarkup} = await import('react-dom/server');
  const html = renderToStaticMarkup(React.createElement(RetainedPublications,{observations:[{...publicationObservation,associationStatus:'unqualified'}]}));
  for (const text of ['Client capture time','Family publication time','Server HTTP Date','Inventory association unqualified','current live status','table3_records.parquet','2,983',otherGeneration]) assert.ok(html.includes(text),text);
 } finally {await rm(folder,{recursive:true,force:true});}
});

test('Python retained publication exporter and maintained reader agree while nested evidence stays private', () => {
 const input = {...publicationObservation,localPath:'/Users/private/response.json',tables:[{table:'bill_sections.parquet',bytes:4,rows:2,partitionColumns:['congress'],localPath:'/Users/private/table',members:[{key:'bill_sections/congress=119/part.parquet',partition:{congress:'119'},sha256:generation,bytes:4,rows:2,localPath:'/Users/private/part'}]}]};
 const exported = exportWithProducer('public_publication', input);
 assert.equal(JSON.stringify(exported).includes('/Users/'), false);
 const parsed = parseCatalogDetail({...detail,publicationObservations:[exported]},generation,item.id);
 assert.equal(parsed.publicationObservations[0].tables[0].members[0].partition.congress,'119');
});


const savedPeriod = {kind:'observed-retained-scope',label:'Saved records',start:'1994',end:'1995',basis:'Exact saved records; completeness unknown'};
const requestedPeriod = {kind:'requested-scope',label:'Requested range',start:'1900',end:'2026',basis:'Selected request only'};
const {periods: legacyPeriods, ...slimFields} = item;
const slimItem = {...slimFields,periodSummary:{count:3,observedRetained:savedPeriod}};
const slimManifest = {...manifest,version:2,collections:[slimItem]};
const slimDetail = {...detail,version:2,collection:{...slimItem,periods:[requestedPeriod,savedPeriod,{...savedPeriod}]}};
const slimPage = {...page,version:2};
test('v2 keeps exhaustive periods in lazy details while v1 remains intentionally readable', async () => {
 assert.equal(parseCatalogManifest(manifest).version,1);
 assert.equal(parseCatalogDetail(detail,generation,item.id).collection.periods.length,0);
 const parsed=parseCatalogManifest(slimManifest);
 assert.equal(parsed.collections[0].periods,undefined);
 assert.deepEqual(parsed.collections[0].periodSummary,{count:3,observedRetained:savedPeriod});
 const urls=[];
 const reader=new SourceCatalogReader('https://data.example/source-catalog/manifest.json',false,async url=>{urls.push(url); return new Response(JSON.stringify(urls.length===1?slimManifest:urls.length===2?slimDetail:slimPage));});
 const selected=await reader.manifest(); assert.equal(urls.length,1);
 const expanded=await reader.detail(selected,selected.collections[0]); assert.equal(urls.length,2);
 assert.deepEqual(expanded.collection.periods,[requestedPeriod,savedPeriod,savedPeriod]);
 assert.equal((await reader.files(selected,expanded,0)).files.length,1); assert.equal(urls.length,3);
});
test('v2 refuses exhaustive manifest arrays, invalid summaries and missing detail periods', () => {
 for(const periodSummary of [{count:-1},{count:1,periods:[savedPeriod]},{count:0,observedRetained:savedPeriod},{count:1,observedRetained:requestedPeriod},{count:1,observedRetained:{...savedPeriod,start:undefined}}]) {
  assert.throws(()=>parseCatalogManifest({...slimManifest,collections:[{...slimItem,periodSummary}]}));
 }
 assert.throws(()=>parseCatalogManifest({...slimManifest,collections:[{...slimItem,periods:[savedPeriod]}]}),/Unsupported catalog field/);
 assert.throws(()=>parseCatalogManifest({...manifest,collections:[{...item,periodSummary:{count:0}}]}),/Unsupported catalog field/);
 assert.throws(()=>parseCatalogDetail({...slimDetail,collection:slimItem},generation,item.id),/array/);
 assert.throws(()=>parseCatalogDetail({...slimDetail,collection:{...slimDetail.collection,periodSummary:{count:2}}},generation,item.id),/count mismatch/);
 assert.throws(()=>parseCatalogDetail({...slimDetail,collection:{...slimDetail.collection,periodSummary:{count:3}}},generation,item.id),/observed period summary mismatch/);
 const conflicting={...slimDetail,collection:{...slimItem,periods:[requestedPeriod,savedPeriod,{...savedPeriod,start:'2000'}]}};
 assert.throws(()=>parseCatalogDetail(conflicting,generation,item.id),/observed period summary mismatch/);
 const uncombined={...conflicting,collection:{...conflicting.collection,periodSummary:{count:3}}};
 assert.equal(parseCatalogDetail(uncombined,generation,item.id).collection.periods.length,3);
});
test('reader refuses cross-version details and file pages within the same generation', async () => {
 const reader=new SourceCatalogReader('https://data.example/source-catalog/manifest.json',false,async()=>new Response(JSON.stringify(detail)));
 await assert.rejects(reader.detail(slimManifest,slimItem),/partition version/);
 const filesReader=new SourceCatalogReader('https://data.example/source-catalog/manifest.json',false,async()=>new Response(JSON.stringify(page)));
 await assert.rejects(filesReader.files(slimManifest,slimDetail,0),/partition version/);
});
