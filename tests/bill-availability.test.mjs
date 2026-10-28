import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const {outputFiles}=await build({entryPoints:['lib/coverage-map.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {billAvailability,parseCoverageMaps}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const hash='sha256:'+'a'.repeat(64), changed='sha256:'+'b'.repeat(64);
const source={family:'bill-family',fingerprint:JSON.stringify([[hash,4,100]]),rows:4,inputsFingerprint:'[]',artifactDigest:hash,schema:[['bill_id','VARCHAR']]};
const bills={id:'congress_bills',family:'bill-family',rows:4,artifactDigest:hash,columns:[{name:'bill_id',type:'VARCHAR'}],members:[{rows:4,byteSize:100,sha256:hash}]};
const subjects={...bills,id:'bill_subjects',family:'bill-subjects'};
const dimension={id:'bill-subject-availability',status:'measured',label:'Bill availability',meaning:'Bills with nonblank values.',granularity:'snapshot',rows:4,placedRows:4,unplacedRows:0,buckets:{},billCoverage:{total:4,policyAreas:2,subjects:1,byCongress:{118:{total:2,policyAreas:2,subjects:1},119:{total:2,policyAreas:0,subjects:0}},comparison:source}};
const document=()=>({format:'spicygov-coverage-maps',version:1,partial:false,generatedAt:'2026-10-28T00:00:00Z',censusDigest:hash,tables:{bill_subjects:{...source,family:'bill-subjects',status:'measured',classification:'holdings',note:'',measuredAt:'2026-10-28T00:00:00Z',definitionDigest:hash,dimensions:[structuredClone(dimension)]}}});
test('bill percentages require both the subject and bill inventory releases to match',()=>{
 const maps=parseCoverageMaps(document());
 assert.equal(billAvailability(subjects,[subjects,bills],maps).policyAreas,2);
 assert.equal(billAvailability(subjects,[subjects],maps),undefined);
 for(const change of [{artifactDigest:changed},{rows:5},{members:[{rows:4,byteSize:100,sha256:changed}]},{columns:[{name:'bill_id',type:'BIGINT'}]}]) {
  assert.equal(billAvailability(subjects,[subjects,{...bills,...change}],maps),undefined);
  assert.equal(billAvailability({...subjects,...change},[subjects,bills],maps),undefined);
 }
});
test('invalid percentages and Congress breakdowns are rejected instead of shown',()=>{
 for(const mutate of [v=>v.policyAreas=5,v=>v.subjects=-1,v=>v.total=3,v=>v.byCongress[118].policyAreas=1,v=>v.byCongress[119].subjects=3,v=>v.comparison.rows=3]){
  const raw=document();mutate(raw.tables.bill_subjects.dimensions[0].billCoverage);
  assert.throws(()=>parseCoverageMaps(raw),/bill availability/);
 }
 const raw=document();const v=raw.tables.bill_subjects.dimensions[0].billCoverage;
 v.total=0;v.policyAreas=0;v.subjects=0;v.byCongress={};
 assert.doesNotThrow(()=>parseCoverageMaps(raw));
});
