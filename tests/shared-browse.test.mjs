import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function module(path){const {outputFiles}=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)}
const {browseFields,browseTargets,congressContext}=await module('lib/shared-browse.ts');
test('collection checkpoints do not become record targets through shared Congress fields',()=>{
 const fields=[{name:'congress',type:'VARCHAR',description:''}];
 const bill={id:'congress_bills',columns:fields,rows:1,metadataState:'current'};
 const checkpoint={...bill,id:'bill_family_backfills',category:'processing_evidence'};
 assert.deepEqual(browseFields(checkpoint),[]);
 assert.deepEqual(browseTargets([bill,checkpoint],browseFields(bill)[0],'119').map(t=>t.table.id),['congress_bills']);
});
const {readLocation,makeHref}=await module('lib/explorer-location.ts');
const {related,connectionFilters}=await module('lib/catalog.ts');
const {matchesFilters}=await module('lib/filter-values.ts');
const table=(id,columns)=>({id,label:id,rows:10,metadataState:'current',columns:columns.map(name=>({name,type:'VARCHAR',description:name}))});
test('Congress is category navigation with no accidental record identity filters',()=>{
 const bills=table('congress_bills',['bill_id','congress']), amendments=table('amendments',['amendment_id','congress']), unrelated=table('unknown',['congress']);
 const f=browseFields(bills)[0], targets=browseTargets([bills,amendments,unrelated],f,'119');
 assert.deepEqual(targets.map(t=>t.table.id),['congress_bills','amendments']);
 assert.deepEqual(targets[1].filters,[{column:'congress',value:'119'}]);
 assert.equal(browseTargets([amendments],f,{congress:119}).length,0);
});
test('session requires and carries Congress; a release without Congress is excluded',()=>{
 const votes=table('roll_call_votes',['congress','session']), meetings=table('committee_meetings',['congress']);
 const f=browseFields(votes).find(f=>f.axis==='session');
 assert.equal(browseTargets([votes],f,'1').length,0);
 assert.deepEqual(browseTargets([votes,meetings],f,'1','119')[0].filters,[{column:'congress',value:'119'},{column:'session',value:'1'}]);
 assert.equal(congressContext(votes,{congress:'119'},[]),'119');
});
test('source-stated chamber variants match without rewriting records or crossing namespaces',()=>{
 const amendments=table('amendments',['chamber']), votes=table('roll_call_votes',['chamber']);
 const f=browseFields(amendments)[0], targets=browseTargets([amendments,votes],f,'House of Representatives');
 assert.deepEqual(targets[0].filters,[{column:'chamber',value:'House',values:['House','House of Representatives']}]);
 assert.deepEqual(targets[1].filters,[{column:'chamber',value:'house'}]);
 for(const chamber of ['House','House of Representatives'])assert.ok(matchesFilters({chamber},targets[0].filters));
 assert.ok(!matchesFilters({chamber:'Senate'},targets[0].filters));
});
test('Congress literals round-trip through URLs; raw Table III variants remain intact',()=>{
 const t=table('table3_records',['congress']),f=browseFields(t)[0],filters=browseTargets([t],f,'119')[0].filters;
 const state={id:t.id,filters,cursor:0,view:'records'};
 assert.deepEqual(readLocation(makeHref(state).slice(1)).filters,filters);
 assert.ok(matchesFilters({congress:'119th Cong.'},filters));
 assert.ok(!matchesFilters({congress:'118th Cong.'},filters));
 assert.deepEqual(readLocation('?where='+encodeURIComponent(JSON.stringify([{column:'congress',value:'119',values:[]}]))).filters,[]);
});
test('filed and covered Congress, source cycle and election cycle retain distinct fields',()=>{
 assert.deepEqual(browseFields(table('house_activity_reports',['congress','covered_congress'])).map(f=>f.label),['Congress filed','Congress covered']);
 const fec=table('fec_committee_master_observations',['cycle','source_cycle']);
 assert.deepEqual(browseTargets([fec],browseFields(fec)[0],'2024')[0].filters,[{column:'cycle',value:'2024'}]);
 assert.equal(browseFields(table('law_sections',['publisher_id'])).length,0);
 assert.equal(browseFields(table('congress_bills',['fiscal_year'])).length,0);
});
test('self-links expose target and referring records; null, blank and compound keys never route',()=>{
 const j={child:'amendments',child_columns:['amended_amendment_id'],parent:'amendments',parent_columns:['amendment_id']};
 const links=related('amendments',[j]);assert.equal(links.length,2);
 const row={amendment_id:'119-samdt-2',amended_amendment_id:'119-samdt-1'};
 assert.deepEqual(connectionFilters(links[0],'amendments',row),[{column:'amendment_id',value:'119-samdt-1'}]);
 assert.deepEqual(connectionFilters(links[1],'amendments',row),[{column:'amended_amendment_id',value:'119-samdt-2'}]);
 for(const value of [null,'',{},[]])assert.equal(connectionFilters(links[0],'amendments',{amended_amendment_id:value}),null);
});
test('paused, empty and incompatible releases do not advertise usable filter destinations',()=>{
 const t=table('amendments',['congress']);const f=browseFields(t)[0];
 for(const patch of [{recordsAvailable:false},{rows:0},{metadataState:'incompatible'}])assert.equal(browseTargets([{...t,...patch}],f,'119').length,0);
});
test('structured category fields and ambiguous Congress scopes cannot create scalar navigation',()=>{
 const votes=table('roll_call_votes',['congress','session']);
 const structured={...votes,columns:votes.columns.map(c=>c.name==='congress'?{...c,type:'VARCHAR[]'}:c)};
 assert.equal(browseFields(structured).some(f=>f.axis==='congress'),false);
 assert.equal(congressContext(votes,undefined,[{column:'congress',value:'119',values:['118','119']}]),undefined);
 assert.equal(congressContext(votes,undefined,[{column:'congress',value:'119',values:['119','119th Cong.']}]),'119');
 assert.equal(congressContext(votes,{congress:'118'},[{column:'congress',value:'119'}]),'118');
});
