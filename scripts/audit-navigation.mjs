/** Measure the explorer's actual recipes and pinned public files; reuse complete unchanged results. */
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
const compile = async path => {
  const {outputFiles}=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
};
const {loadCollection}=await compile('lib/catalog.ts');
const {readColumnBatches}=await compile('lib/reader.ts');
const {navigationColumns}=await compile('lib/navigation.ts');
const {countNavigation,emptyCounts,targetIdentity,retainedScalarCounts}=await compile('lib/navigation-measurement.ts');
const args=process.argv.slice(2);
function option(name,fallback) { const i=args.indexOf(name); return i<0?fallback:args[i+1]; }
const output=option('--output','/tmp/spicygov-navigation-audit.json');
const sourceLimit=Number(option('--max-source-rows','25000'));
const targetLimit=Number(option('--max-target-rows','100000'));
if (![sourceLimit,targetLimit].every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error('Audit limits must be positive whole numbers.');
const only=option('--tables','')?.split(',').filter(Boolean);
const implementation=createHash('sha256');
for (const path of ['lib/navigation.ts','lib/navigation-measurement.ts','lib/reader.ts','scripts/audit-navigation.mjs']) implementation.update(await readFile(path));
const implementationSha256='sha256:'+implementation.digest('hex');
const collection=await loadCollection();
const tables=new Map(collection.tables.map(table=>[table.id,table]));
const scalarRecipes=collection.joins.map(join=>({
 id:`scalar:${join.child}(${join.child_columns.join(',')})->${join.parent}(${join.parent_columns.join(',')})`,
 source:join.child,fields:[],mode:'row',receiptFields:[],elementPath:[],ruleVersion:'source-navigation/1',available:true,
 meaning:join.reason,targets:[{table:join.parent,columns:join.parent_columns,available:true,guards:[],
 keys:join.child_columns.map(column=>({parts:[{from:'row',path:[column]}],separator:'',pattern:'.+'}))}],
}));
const recipes=[...(collection.navigation??[]),...scalarRecipes].filter(spec=>!only.length||only.includes(spec.source));
const scalarMeasurements=new Map(scalarRecipes.map((spec,i)=>[spec.id,collection.joins[i].measurement]));
let old={results:[]};
try {old=JSON.parse(await readFile(output,'utf8'));} catch(error) {if(error.code!=='ENOENT') throw error;}
const report={format:'spicygov-navigation-measurements',version:1,measuredAt:new Date().toISOString(),implementationSha256,
  semantics:'Counts preserve repeated source occurrences. Multiple target rows are retained observations, not automatically ambiguous identities. Offered URLs do not establish capture or extraction. Unchecked targets and partial scans never count as missing.',results:[]};
const keyPopulations=new Map();
const sourcePopulations=new Map();
const pin=table=>table?{id:table.id,artifactDigest:table.artifactDigest,publicationIdentity:table.publicationIdentity,members:table.members,receipts:table.publication?.nativeReceipts}:null;
const readRows=async(table,columns,limit,onRows)=>{
 const result=await readColumnBatches(table,columns,limit,onRows);
 return result.complete;
};
for (const spec of recipes) {
 const source=tables.get(spec.source);
 const targetPins=spec.targets.map(target=>({table:target.table,columns:target.columns,pin:pin(tables.get(target.table))}));
 const fingerprint='sha256:'+createHash('sha256').update(JSON.stringify({implementationSha256,spec,source:pin(source),targets:targetPins})).digest('hex');
 const previous=old.results.find(result=>result.id===spec.id&&result.fingerprint===fingerprint&&result.status==='complete');
 if(previous) {report.results.push({...previous,reused:true}); continue;}
 const result={id:spec.id,source:spec.source,sourcePin:pin(source),targetPins,fingerprint,status:'unmeasured',counts:null,reused:false};
 try {
  const measurement=scalarMeasurements.get(spec.id);
  const retained=measurement&&retainedScalarCounts(measurement,source,tables.get(spec.targets[0].table));
  if(retained) {
   report.results.push({...result,status:'complete',counts:retained,reused:true,retainedMeasurement:measurement});
   console.log(`${spec.id}: complete (reused full measurement with matching file pins)`);
   continue;
  }
  const columns=[...new Set([...navigationColumns(spec),...(spec.field?[spec.field]:[]),...(source.receiptIdentity??[])])];
  if(!spec.available || columns.some(column=>!source.columns.some(c=>c.name===column)) || spec.candidates&&spec.receiptFields.length&&!spec.field) {
   result.reason='Required references live in receipts or source fields that this scan cannot read. No empty-population claim.';
  } else {
   for(const target of spec.targets) {
    if(target.table.startsWith('@')) continue;
    const identity=JSON.stringify([target.table,target.columns,pin(tables.get(target.table))]);
    if(keyPopulations.has(identity)) continue;
    const table=tables.get(target.table);
    if(!table||!target.available||table.rows>targetLimit) {keyPopulations.set(identity,undefined);continue;}
    const keys=new Map();
    const complete=await readRows(table,target.columns,targetLimit,rows=>rows.forEach(row=>{const key=targetIdentity(row,target.columns);if(key!==undefined) keys.set(key,(keys.get(key)??0)+1);}));
    keyPopulations.set(identity,complete?keys:undefined);
   }
   const counts=emptyCounts();
   if(!sourcePopulations.has(source.id)) {
    const needed=[...new Set(recipes.filter(recipe=>recipe.source===source.id).flatMap(recipe=>[...navigationColumns(recipe),...(recipe.field?[recipe.field]:[]),...(source.receiptIdentity??[])]))].filter(column=>source.columns.some(c=>c.name===column));
    const rows=[];
    const complete=await readRows(source,needed,sourceLimit,batch=>rows.push(...batch));
    sourcePopulations.set(source.id,{rows,complete});
   }
   const population=sourcePopulations.get(source.id);
   countNavigation(spec,population.rows,(target,values)=>{
    const keys=keyPopulations.get(JSON.stringify([target.table,target.columns,pin(tables.get(target.table))]));
    return keys?keys.get(JSON.stringify(values))??0:undefined;
   },counts);
   const complete=population.complete;
   result.counts=counts; result.status=complete&&!counts.unchecked?'complete':'partial';
   if(!complete) result.reason='Source scan reached its explicit row limit; counts cover only the checked prefix.';
   else if(counts.unchecked) result.reason='Some target populations are unavailable, receipt-backed, or above the explicit target limit.';
  }
 } catch(error) {result.status='failed';result.reason=error.message;}
 report.results.push(result);
 await mkdir(dirname(output),{recursive:true}); await writeFile(output+'.tmp',JSON.stringify(report,null,2)+'\n'); await rename(output+'.tmp',output);
 console.log(`${result.id}: ${result.status}${result.counts?` (${result.counts.sourceRows} source rows, ${result.counts.eligible} eligible, ${result.counts.matched} matched, ${result.counts.missing} missing, ${result.counts.unchecked} unchecked)`:''}`);
}
await writeFile(output+'.tmp',JSON.stringify(report,null,2)+'\n'); await rename(output+'.tmp',output);
console.log(JSON.stringify({results:report.results.length,statuses:report.results.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{})}));
