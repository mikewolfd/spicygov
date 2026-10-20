import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

async function load(path) {
  const {outputFiles} = await build({entryPoints:[path],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime'],logLevel:'silent'});
  const loaded = {exports:{}};
  new Function('require','module','exports',outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
  return loaded.exports;
}
const {FinancialProfile} = await load('components/financial-profile.tsx');
const {defaultColumns} = await load('lib/catalog.ts');
const {readLocation} = await load('lib/explorer-location.ts');
const table = {
  id:'fec_financial_profiles', metadataState:'current',
  columns:['profile_id','entity_kind','entity_id','entity_name','source_cycle','selection_status','coverage_status'].map(name=>({name,type:'VARCHAR'})),
  recordIdentity:{columns:['profile_id'],basis:'declared_main_key',uniqueness:'unknown'},
  publication:{recordUrl:'https://data.spicygov.ai/generations/fec-financial-profiles/abc/artifact.json'},
};
const profile = {
  profile_id:'candidate:H0XX00001:2026', entity_kind:'candidate', entity_id:'H0XX00001', entity_name:'Example candidate',
  source_cycle:2026, selection_status:'selected', selection_reason:'unique equivalent snapshot',
  coverage_status:'reported', coverage_reasons_json:'[]', amount_basis:'source_reported',
  period_start:new Date('2025-01-01T00:00:00Z'), period_end:new Date('2026-06-30T00:00:00Z'),
  period_start_raw:'01/01/2025', period_end_raw:'06/30/2026', period_start_status:'exact', period_end_status:'exact',
  captured_at:'2026-09-12T10:00:00Z', source_collection_id:'candidate-summary-2026',
  source_sha256:'sha256:source', source_table_generation:'sha256:table', witness_count:2,
  source_url:'https://www.fec.gov/files/bulk-downloads/2026/weball26.zip',
  publisher_profile_url:'https://www.fec.gov/data/candidate/H0XX00001/?cycle=2026',
  receipts:'9007199254740993.01', receipts_status:'exact', receipts_native_field:'total_receipts',
  disbursements:'0.00', disbursements_status:'exact', disbursements_native_field:'total_disbursements',
  cash_on_hand:'-12.3400', cash_on_hand_status:'exact', cash_on_hand_native_field:'cash_on_hand_end_period',
  debts_owed:null, debts_owed_status:'not_supplied', debts_owed_native_field:null,
};
const render = (row=profile, dataset=table) => renderToStaticMarkup(createElement(FinancialProfile,{table:dataset,row}));

test('reported amounts retain decimal text beyond JS precision, zero, negatives and missing status',()=>{
  const html=render();
  assert.match(html,/USD 9007199254740993\.01/);
  assert.match(html,/USD 0\.00/);
  assert.match(html,/USD -12\.3400/);
  assert.match(html,/<dt>Debt at reported period end<\/dt><dd>Not available<\/dd><small>Status: not_supplied<\/small>/);
  assert.match(html,/Reported receipts/);
  assert.match(html,/Reported disbursements/);
  assert.doesNotMatch(html,/Current balance|Current total/);
  for(const amount of [9007199254740992,'1e12','NaN']) {
    const invalid=render({...profile,receipts:amount});
    assert.match(invalid,/<dt>Reported receipts<\/dt><dd>Exact amount unavailable<\/dd>/);
  }
});

test('ambiguous decisions keep witnesses visible and do not choose figures from retained competing values',()=>{
  const html=render({...profile,selection_status:'ambiguous',selection_reason:'competing source snapshots',coverage_status:'ambiguous',coverage_reasons_json:'["unresolved tie"]',witness_count:3});
  assert.match(html,/No single source snapshot is selected/);
  assert.equal((html.match(/<dd>Not selected<\/dd>/g)??[]).length,4);
  assert.doesNotMatch(html,/USD /);
  assert.match(html,/competing source snapshots/);
  assert.match(html,/unresolved tie/);
  assert.match(html,/<dt>Recorded witnesses<\/dt><dd>3<\/dd>/);
});

test('reported amounts and period qualification remain separate, including missing and invalid dates',()=>{
  const html=render({...profile,entity_kind:'committee',entity_id:'C00000001',coverage_status:'unqualified',
    coverage_reasons_json:'["reported end follows capture date","reported start precedes source cycle"]',
    period_start:null,period_start_raw:'not-a-date',period_start_status:'invalid_date',
    period_end:new Date('2026-12-31T00:00:00Z'),period_end_raw:'12/31/2026'});
  assert.match(html,/committee C00000001/);
  assert.match(html,/Source cycle: 2026/);
  assert.match(html,/Reported period: Not available → 2026-12-31/);
  assert.match(html,/Period start status: invalid_date/);
  assert.match(html,/Source date text: not-a-date → 12\/31\/2026/);
  assert.match(html,/Snapshot captured: 2026-09-12T10:00:00Z/);
  assert.match(html,/reported end follows capture date/);
  assert.match(html,/USD 9007199254740993\.01/);
  assert.match(html,/Coverage: unqualified/);
  const missing=render({...profile,period_start:null,period_end:null,period_start_raw:null,period_end_raw:null,period_start_status:'source_null',period_end_status:'source_empty'});
  assert.match(missing,/Reported period: Not available → Not available/);
  assert.match(missing,/Period start status: source_null · Period end status: source_empty/);
});

test('profile links use the declared exact identity and retain source versus publication evidence',()=>{
  const html=render();
  assert.match(html,/Publisher source \(may change\)/);
  assert.match(html,/Publisher entity page \(may show a different snapshot\)/);
  assert.match(html,/Selected publication evidence/);
  assert.match(html,/sha256:source/);
  assert.match(html,/sha256:table/);
  const href=/href="([^"]+)">Link to this profile/.exec(html)?.[1].replaceAll('&amp;','&');
  assert.ok(href);
  const location=readLocation(new URL(href,'https://spicygov.ai').search);
  assert.equal(location.id,'fec_financial_profiles');
  assert.equal(location.detail,true);
  assert.deepEqual(location.filters,[{column:'profile_id',value:profile.profile_id}]);
  assert.doesNotMatch(render(profile,{...table,recordIdentity:undefined}),/Link to this profile/);
  assert.doesNotMatch(render({...profile,source_url:'javascript:alert(1)',publisher_profile_url:'data:text/html,bad'}),/href="(?:javascript|data):/);
});

test('unknown definitions or unreadable limitations never look like qualified profiles',()=>{
  for(const metadataState of ['missing','older-publication','incompatible','unavailable']) {
    const html=render(profile,{...table,metadataState});
    assert.match(html,/profile definition is unavailable/);
    assert.doesNotMatch(html,/USD /);
  }
  assert.match(render({...profile,amount_basis:'transaction_derived'}),/profile definition is unavailable/);
  for(const coverage_reasons_json of [null,'not json','{"reason":"unknown"}']) {
    assert.match(render({...profile,coverage_reasons_json}),/Coverage reasons are unavailable/);
  }
  assert.equal(render(profile,{...table,id:'fec_reported_financial_summaries'}),'');
  assert.match(render({...profile,entity_name:'<script>bad</script>'}),/&lt;script&gt;bad&lt;\/script&gt;/);
});

test('profile browse columns identify entity, cycle and decision without implying current totals',()=>{
  assert.deepEqual(defaultColumns(table),['entity_kind','entity_id','entity_name','source_cycle','selection_status','coverage_status']);
});
