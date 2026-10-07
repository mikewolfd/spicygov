// Bounded T04 comparison. Preregister the decision before running this harness.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
import {resolve,join} from 'node:path';
const [input,out]=process.argv.slice(2);if(!input||!out)throw new Error('Usage: node scripts/compare-bill-lookup.mjs retained-congress-bills.parquet output-directory');
const output=resolve(out);await mkdir(output,{recursive:true});
const registration=JSON.parse(await readFile(join(output,'bill-lookup-preregistered.json'),'utf8'));
const publicationResponse=await fetch('https://data.spicygov.ai/publication.v2.json');if(!publicationResponse.ok)throw new Error('Current publication unavailable');
const publicationText=await publicationResponse.text(),publication=JSON.parse(publicationText),family=publication.families['bill-family'],published=family.tables['congress_bills.parquet'];
const bytes=await readFile(input),digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
if(published.members||published.sha256!==digest||published.byteSize!==bytes.length||published.rows>registration.bounds.keyRows)throw new Error('Retained bytes do not match the current bounded single-member publication. Rebind before running.');
await writeFile(join(output,'bill-lookup-publication.json'),publicationText);
let requests=0,requestedBytes=0;
const etag='"'+createHash('md5').update(bytes).digest('hex')+'"';
const server=createServer((req,res)=>{
 if(req.headers['if-match']!==etag){res.writeHead(412).end();return;}
 const m=/bytes=(\d+)-(\d+)/.exec(req.headers.range??'');if(!m){res.writeHead(400).end();return;}
 const start=+m[1],end=+m[2];requests++;requestedBytes+=end-start+1;
 res.writeHead(206,{'ETag':etag,'Content-Range':`bytes ${start}-${end}/${bytes.length}`});res.end(bytes.subarray(start,end+1));
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const table={id:'congress_bills',rows:published.rows,columns:published.columns.map(([name,type])=>({name,type})),artifactDigest:family.artifactDigest,recordIdentity:{columns:['bill_id'],basis:'declared_main_key',uniqueness:'unknown'},members:[{url:`http://127.0.0.1:${server.address().port}/bills`,rows:published.rows,byteSize:bytes.length,sha256:digest,etag}]};
async function module(path){const {outputFiles}=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);}
const reader=await module('lib/reader.ts'),locator=await module('lib/subject-key-cache.ts');
let heapPeak=process.memoryUsage().heapUsed;const heapStart=heapPeak;
function memory(){heapPeak=Math.max(heapPeak,process.memoryUsage().heapUsed);if(heapPeak-heapStart>registration.bounds.keyMemoryMiB*1024*1024)throw new Error('Measured key memory exceeds the preregistered bound.');}
const results={task:'T04',input:{path:resolve(input),sha256:digest,byteSize:bytes.length,rows:published.rows,sourceUrl:`https://data.spicygov.ai/${family.prefix}/congress_bills.parquet`,artifactDigest:family.artifactDigest},registration,arms:{},failures:[]};
async function measured(fn){requests=0;requestedBytes=0;const start=performance.now();const result=await fn();memory();return {result,milliseconds:performance.now()-start,requests,bytes:requestedBytes};}
try {
 const referenceHash=createHash('sha256'),samples=new Map();let referenceRows=0;
 const audit=await measured(()=>reader.readColumnBatches(table,['bill_id'],registration.bounds.keyRows,rows=>{for(const row of rows){const key=row.bill_id;if(typeof key!=='string'||!key)throw new Error('Missing reference identity');referenceHash.update(key+'\0'+referenceRows+'\n');if([0,Math.floor(table.rows/2),table.rows-1].includes(referenceRows))samples.set(key,referenceRows);referenceRows++;}memory();}));
 if(!audit.result.complete||referenceRows!==table.rows)throw new Error('Full reference population is not complete and unique.');
 results.reference={...audit,result:undefined,keys:referenceRows};
 const cacheBuild=await measured(()=>locator.billKeyCache(table,memory)),cache=cacheBuild.result;
 const expectedDigest=referenceHash.digest('hex'),cacheHash=createHash('sha256');if(cache)for(const [key,position] of cache.positions)cacheHash.update(key+'\0'+position+'\n');if(!cache||cache.positions.size!==referenceRows||cacheHash.digest('hex')!==expectedDigest)throw new Error('A cached position differs from the maintained reader.');
 results.arms.cache={build:{...cacheBuild,result:undefined},estimatedBytes:cache.estimatedBytes,checkedPositions:referenceRows,keyPositionSha256:expectedDigest};
 const sortedBuild=await measured(()=>[...cache.positions].sort(([a],[b])=>a<b?-1:a>b?1:0)),sorted=sortedBuild.result;
 const encoded=JSON.stringify(sorted);results.arms.sorted={build:{...sortedBuild,result:undefined},retainedBytes:Buffer.byteLength(encoded)};
 await writeFile(join(output,'bill-subject-locator.experimental.json'),encoded);
 function binary(key){let lo=0,hi=sorted.length;while(lo<hi){const mid=(lo+hi)>>>1;if(sorted[mid][0]<key)lo=mid+1;else hi=mid;}return sorted[lo]?.[0]===key?sorted[lo][1]:undefined;}
 if([...cache.positions].some(([key,position])=>binary(key)!==position))throw new Error('A sorted locator position differs from the maintained reader.');
 results.arms.sorted.checkedPositions=referenceRows;
 const cases=[...samples.keys(),'not-a-retained-bill'];
 for(const [name,fn] of Object.entries({scan:async key=>{const result=await reader.readPage({table,columns:['bill_id'],filters:[{column:'bill_id',value:key}],cursor:0,limit:2});if(!result.done&&result.rows.length<2)throw new Error('Incomplete baseline');return result.positions;},cache:async key=>{const position=cache.positions.get(key);return position===undefined?[]:[position];},sorted:async key=>{const position=binary(key);return position===undefined?[]:[position];}})) {
  results.arms[name]??={};results.arms[name].trials=[];
  for(let repeat=0;repeat<3;repeat++)for(const key of cases){const trial=await measured(()=>fn(key));const expected=samples.get(key)??-1;if(JSON.stringify(trial.result)!==JSON.stringify(expected<0?[]:[expected]))throw new Error(`${name} disagrees for ${key}`);results.arms[name].trials.push({key,repeat,...trial});}
 }
 results.heap={startBytes:heapStart,peakBytes:heapPeak,increaseBytes:heapPeak-heapStart};
 const median=trials=>trials.map(t=>t.milliseconds).sort((a,b)=>a-b)[Math.floor(trials.length/2)];
 const scan=results.arms.scan.trials,cacheTrials=results.arms.cache.trials;
 results.decision=cacheTrials.reduce((n,t)=>n+t.bytes,0)<scan.reduce((n,t)=>n+t.bytes,0)&&median(cacheTrials)<median(scan)?'adopt bounded generation-scoped cache; keep sorted locator experimental':'no adoption';
 results.medianMilliseconds=Object.fromEntries(Object.entries(results.arms).map(([name,arm])=>[name,median(arm.trials)]));
 results.limitations=['Loopback latency is reader cost, not Internet latency.','Cache build is cold cost; each worker lifetime retains at most one locator.','No subject sidecar was publicly published.','Synthetic refusal tests remain separate from actual population equivalence.'];
} catch(error){results.failures.push(String(error));results.decision='no adoption';process.exitCode=1;}
finally {await writeFile(join(output,'bill-lookup-results.json'),JSON.stringify(results,null,2)+'\n');server.close();server.closeAllConnections();}
console.log(JSON.stringify({decision:results.decision,failures:results.failures,medianMilliseconds:results.medianMilliseconds,heap:results.heap}));
