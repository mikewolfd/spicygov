import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectCatalog,stageCatalog} from '../scripts/stage-source-catalog.mjs';
import {validatePublicDirectory} from '../scripts/catalog-public-validation.mjs';
import {registerSourcePeriods} from '../scripts/register-source-periods.mjs';
const built=await build({entryPoints:['lib/source-catalog.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {parseCatalogParquet,parseCatalogManifest,parseCatalogDetail,SourceCatalogReader}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const generation='sha256:'+'a'.repeat(64);
const sha=body=>'sha256:'+createHash('sha256').update(body).digest('hex');
const result=spawnSync(process.env.SOURCE_CATALOG_PYTHON || 'python3',['-B','-c',`
import base64,json
from datetime import datetime,timezone
from spicy_regs.source_catalog.file_inventory import schema,encode,native_row
import pyarrow as pa
import pyarrow.parquet as pq
import io

generation='sha256:'+'a'*64
base={field.name:None for field in schema(generation,'fixture','active')}
base.update(alias_id='file:'+'1'*64,dataset_id='fixture',inventory_kind='active',name='publisher-name.json',status='held',provenance_basis='receipt-backed',availability='local',
    route_id='publisher-route',source_id='native-1',source_version='2024',content_sha256=bytes.fromhex('2'*64),original_bytes=10,content_key='objects/sha256/22/'+'2'*64+'.gz',stored_bytes=7,
    captured_at=datetime(2026,10,28,1,2,3,123456,tzinfo=timezone.utc),source_url='https://example.gov/file',period_kind='election-cycle',period_label='2024',period_basis='Native requested scope',
    receipt_key='acquisitions/sha256/33/'+'3'*64,receipt_sha256=bytes.fromhex('3'*64),receipt_entry=1,receipt_kind='acquisition')
second=dict(base,alias_id='legacy-observation:two',status='refused-source',provenance_basis='provisional',captured_at=None,source_url=None,source_urls=['https://example.gov/request','https://example.gov/result'],
    period_kind=None,period_label=None,period_basis=None,periods=[{'kind':'congress','label':'119','basis':'Native scope','start':None,'end':None},{'kind':'issue-date','label':'2026-10-28','basis':'Native date','start':'2026-10-28','end':'2026-10-28'}],
    conflict_fields=['capture-time-conflict'],receipt_key='files.jsonl.gz',receipt_kind='frozen-index',receipt_entry=2,
    original_receipt_key='objects/sha256/44/'+'4'*64+'.gz',original_receipt_sha256=bytes.fromhex('4'*64),original_receipt_pointer='/receipt/files/0')
rows=[base,second]
output={}
def put(name,values,**scope):
    body=encode(values,generation=scope.get('generation',generation),dataset_id='fixture',inventory_kind='active')
    output[name]={'body':base64.b64encode(body).decode(),'rows':len(values)}
put('valid',rows)
put('register-date',[dict(base,period_kind='publication-date',period_label='2026-09-23',period_basis='Observed in source content')])
class NoReceiptReferences:
    def indexed(self,ref):return None
    def original(self,digest):return None
put('register-context-date',[native_row(
    {'id':'context-observation','name':'presidential.xml','status':'held','sha256':'sha256:'+'6'*64,'bytes':10},
    {'encoded_bytes':10,'mapping':{'periods':[{'kind':'publication-date','label':'2025-07-11',
        'origin':'publication-context','rule':'exact-original-unique-published-date-context/1','basis':'Independent pinned context'}]}},
    dataset_id='fixture',publisher=None,inventory_kind='active',references=NoReceiptReferences())])
put('empty-native-text',[dict(base,source_id='',source_version=' ',period_basis='')])
put('unavailable',[dict(base,receipt_key=None,receipt_kind=None,original_receipt_key=None,original_receipt_sha256=bytes.fromhex('4'*64),conflict_fields=['receipt-reference-unavailable'])])
for name,changes in {
 'private':{'source_id':'/Users/private/source'},'private-period':{'period_basis':'/mnt/private/source'},'unsafe-url':{'source_url':'https://example.gov/file?token=private'},
 'unsafe-key':{'receipt_key':'../receipt.json'},'wrong-key-hash':{'content_key':'objects/sha256/55/'+'5'*64},'wrong-receipt-kind':{'receipt_kind':'frozen-index'},
 'wrong-row-scope':{'dataset_id':'other'},'large-integer':{'original_bytes':2**53},'duplicate-urls':{'source_url':None,'source_urls':['https://example.gov/file','https://example.gov/file']},
 'unqualified-time':{'provenance_basis':'provisional'},'overlapping-periods':{'periods':second['periods']},
}.items():put(name,[dict(base,**changes)])
put('duplicate-alias',[base,base])
put('wrong-generation',[base],generation='sha256:'+'b'*64)
for name,kind in [('wrong-type',pa.int64()),('wrong-nullability',None)]:
    current=schema(generation,'fixture','active')
    fields=list(current)
    index=current.get_field_index('original_bytes' if kind else 'alias_id')
    fields[index]=pa.field(fields[index].name,kind or pa.string(),nullable=True)
    current=pa.schema(fields,metadata=current.metadata)
    table=pa.Table.from_pylist([base],schema=current)
    stream=io.BytesIO()
    with pq.ParquetWriter(stream,current,compression='zstd',store_schema=False) as writer:
        writer.add_key_value_metadata(current.metadata);writer.write_table(table)
    output[name]={'body':base64.b64encode(stream.getvalue()).decode(),'rows':1}
print(json.dumps(output))
`],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,env:{...process.env,PYTHONPATH:process.env.SOURCE_CATALOG_PYTHONPATH || '../spicy-regs/src',PYTHONNOUSERSITE:'1'}});
assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
const fixtures=JSON.parse(result.stdout);
function context(name='valid',changes={}){
 const fixture=fixtures[name],body=Buffer.from(fixture.body,'base64');
 return {body,context:{generation,collectionId:'fixture',inventoryKind:'active',part:{path:`generations/${generation.slice(7)}/files-00000.parquet`,format:'parquet',schema:'spicy-source-files/v1',rows:fixture.rows,bytes:body.length,sha256:sha(body)},...changes}};
}
const buffer=body=>body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength);
const decode=(name,changes)=>{const value=context(name,changes);return parseCatalogParquet(buffer(value.body),value.context);};

test('native inventory preserves observations, exact timestamps, nulls and direct archive references',async()=>{
 const page=await decode('valid');
 assert.deepEqual(page.files.map(file=>file.id),['file:'+'1'.repeat(64),'legacy-observation:two']);
 assert.equal(page.files[0].sha256,page.files[1].sha256);
 assert.equal(page.files[0].name,'publisher-name.json');assert.equal(page.files[0].routeId,'publisher-route');
 assert.equal(page.files[0].sourceId,'native-1');assert.equal(page.files[0].sourceVersion,'2024');
 assert.deepEqual(page.files[0].periods,[{kind:'election-cycle',label:'2024',basis:'Native requested scope'}]);
 assert.deepEqual(page.files[1].periods.map(p=>[p.kind,p.label,p.start,p.end]),[
  ['congress','119',undefined,undefined],['issue-date','2026-10-28','2026-10-28','2026-10-28']]);
 assert.deepEqual(page.files[1].metadataConflicts,['capture-time-conflict']);
 assert.equal(page.files[0].metadataConflicts,undefined);
 assert.equal(page.files[0].provenance.capturedAt,'2026-10-28T01:02:03.123456Z');
 assert.equal(page.files[1].provenance.capturedAt,undefined);assert.equal(page.files[1].status,'refused-source');
 assert.equal(page.files[1].provenance.sourceUrls.length,2);
 assert.equal(page.files[0].contentKey,'objects/sha256/22/'+'2'.repeat(64)+'.gz');assert.equal(page.files[0].storedBytes,7);
 assert.equal(page.files[1].provenance.originalReceiptPointer,'/receipt/files/0');
 assert.equal(page.files[1].provenance.receipt.key,'files.jsonl.gz');
});
test('known receipt fingerprints survive an unavailable archive location without an invented key',async()=>{
 const file=(await decode('unavailable')).files[0];
 assert.equal(file.provenance.receipt.sha256,'sha256:'+'3'.repeat(64));assert.equal(file.provenance.receipt.key,null);
 assert.equal(file.provenance.originalReceiptSha256,'sha256:'+'4'.repeat(64));assert.equal(file.provenance.originalReceiptKey,null);
});
test('optional native text preserves schema-valid blanks without rejecting a file page',async()=>{
 const file=(await decode('empty-native-text')).files[0];
 assert.equal(file.sourceId,'');assert.equal(file.sourceVersion,' ');
 assert.equal(file.periods[0].basis,'');
});
for(const name of Object.keys(fixtures).filter(name=>!['valid','unavailable','empty-native-text','register-date','register-context-date'].includes(name))) test(`native inventory refuses ${name}`,async()=>{
 await assert.rejects(decode(name));
});
test('native catalog dates feed the automatic source-period summary',async()=>{
 const page=await decode('register-date'),collector=registerSourcePeriods();
 collector.addPage('family:federal-register','active',page.files);
 assert.deepEqual(collector.result(generation).months,['2026-09']);
 assert.equal(collector.result(generation).latestIndexedDate,'2026-09-23');
});
test('trusted publication-context export survives native decoding into the automatic date coverage',async()=>{
 const page=await decode('register-context-date'),collector=registerSourcePeriods();
 assert.equal(page.files[0].periods[0].basis,'Observed in pinned publication context');
 collector.addPage('family:federal-register','active',page.files);
 const result=collector.result(generation);
 assert.deepEqual(result.months,['2025-07']);
 assert.deepEqual(result.dateCoverage,{files:1,datedFiles:1,undatedFiles:0});
 assert.equal(result.latestIndexedDate,'2025-07-11');
});
test('pinned size, fingerprint, generation, collection and inventory are checked before display',async()=>{
 const value=context();
 await assert.rejects(parseCatalogParquet(buffer(Buffer.from('bad')),value.context),/bounds/);
 await assert.rejects(parseCatalogParquet(buffer(value.body),{...value.context,part:{...value.context.part,sha256:'sha256:'+'0'.repeat(64)}}),/fingerprint/);
 for(const changes of [{generation:'sha256:'+'b'.repeat(64)},{collectionId:'other'},{inventoryKind:'attention'}]) await assert.rejects(decode('valid',changes),/scope|identity/);
 await assert.rejects(parseCatalogParquet(buffer(value.body),{...value.context,part:{...value.context.part,rows:5001}}),/bounds/);
});
async function catalogFixture(t){
 const root=await mkdtemp(join(tmpdir(),'catalog-parquet-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {body,context:scope}=context();const part=scope.part;
 const collection={id:'fixture',title:'Fixture',statuses:['held'],families:[],tables:[],routeCount:0,holdings:{aliases:2,objects:1,decodedBytes:10,missing:0},periodSummary:{count:0},detailPath:`generations/${generation.slice(7)}/collection.json`};
 const manifest={format:'spicy-source-catalog',version:3,generation,generatedAt:'2026-10-28T00:00:00Z',collections:[collection],totals:{collections:1}};
 const detail={format:'spicy-source-collection',version:3,generation,collection:{...collection,periods:[]},routes:[],tables:[],files:{total:2,pages:[part]},planned:[],observations:[],relationships:[]};
 for(const [path,bytes]of[['manifest.json',Buffer.from(JSON.stringify(manifest))],[collection.detailPath,Buffer.from(JSON.stringify(detail))],[part.path,body]]){
  await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),bytes);
 }
 return {root,manifest,detail,part,body};
}
test('v3 reads only the chosen pinned shard and fails oversized streams',async t=>{
 const fixture=await catalogFixture(t),seen=[];
 parseCatalogManifest(fixture.manifest);parseCatalogDetail(fixture.detail,generation,'fixture',false,3);
 const reader=new SourceCatalogReader('https://catalog.example/manifest.json',false,async url=>{seen.push(url);return new Response(fixture.body);});
 assert.equal((await reader.files(fixture.manifest,fixture.detail,0)).files.length,2);
 assert.deepEqual(seen,['https://catalog.example/'+fixture.part.path]);
 const oversized=new SourceCatalogReader('https://catalog.example/manifest.json',false,async()=>new Response(Buffer.alloc(fixture.part.bytes+1)));
 await assert.rejects(oversized.files(fixture.manifest,fixture.detail,0),/byte limit/);
});
test('inspection and staging apply the same native decoder and preserve exact bytes',async t=>{
 const fixture=await catalogFixture(t),pages=[],selected=await inspectCatalog(fixture.root,{onFilePage:(id,kind,files)=>pages.push({id,kind,files})});
 assert.equal(pages.length,1);assert.equal(pages[0].id,'fixture');assert.equal(pages[0].kind,'active');assert.equal(pages[0].files.length,2);
 const selection=join(fixture.root,'..',fixture.root.split('/').at(-1)+'.selection.json');t.after(()=>rm(selection,{force:true}));
 const raw=Buffer.from(JSON.stringify(selected));await writeFile(selection,raw);
 const output=fixture.root+'-stage';t.after(()=>rm(output,{recursive:true,force:true}));
 await stageCatalog({source:fixture.root,selection,selectionSha256:sha(raw),output});
 assert.deepEqual(await readFile(join(output,fixture.part.path)),fixture.body);
 const derived=await validatePublicDirectory(output,{collectSourcePeriods:true});
 assert.equal(derived.generation,generation);assert.deepEqual(derived.months,[]);
 const bad=context('private');fixture.detail.files.pages[0]={...bad.context.part,path:fixture.part.path};fixture.detail.files.total=1;
 await writeFile(join(fixture.root,fixture.part.path),bad.body);await writeFile(join(fixture.root,fixture.manifest.collections[0].detailPath),JSON.stringify(fixture.detail));
 await assert.rejects(inspectCatalog(fixture.root),/private|Local/);await assert.rejects(validatePublicDirectory(fixture.root,{collectSourcePeriods:true}),/private|Local/);
});
