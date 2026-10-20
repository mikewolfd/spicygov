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
  source_cycle:2026, selection_status:'selected', selection_reason:'unique_reported_snapshot',
  coverage_status:'reported', coverage_reasons_json:'[]', amount_basis:'source_reported',
  period_start:new Date('2025-01-01T00:00:00Z'), period_end:new Date('2026-06-30T00:00:00Z'),
  period_start_raw:'01/01/2025', period_end_raw:'06/30/2026', period_start_status:'exact', period_end_status:'exact',
  captured_at:'2026-09-12T10:00:00Z', source_collection_id:'candidate-summary-2026',
  source_sha256:'sha256:source', source_table_generation:'sha256:table', witness_count:2,
  source_url:'https://www.fec.gov/files/bulk-downloads/2026/weball26.zip',
  publisher_profile_url:'https://www.fec.gov/data/candidate/H0XX00001/?cycle=2026',
  receipts:'9007199254740993.01', receipts_raw:'9007199254740993.01', receipts_status:'exact', receipts_native_field:'total_receipts',
  disbursements:'0.00', disbursements_status:'exact', disbursements_native_field:'total_disbursements',
  cash_on_hand:'-12.3400', cash_on_hand_status:'exact', cash_on_hand_native_field:'cash_on_hand_end_period',
  debts_owed:null, debts_owed_status:'not_supplied', debts_owed_native_field:null,
};
const render = (row=profile, dataset=table) => renderToStaticMarkup(createElement(FinancialProfile,{table:dataset,row}));

test('reported amounts retain decimal text beyond JS precision, zero, negatives and missing status',()=>{
  const html=render();
  assert.match(html,/\$9,007,199,254,740,993\.01 USD/);
  assert.match(html,/\$0\.00 USD/);
  assert.match(html,/-\$12\.34 USD/);
  assert.match(html,/<dt>Debt at reported period end<\/dt><dd>Not available<\/dd><small>Not supplied by this source<\/small>/);
  assert.match(html,/9007199254740993\.01 \/ 9007199254740993\.01/);
  assert.match(html,/-12\.3400 \/ Not stated \(null\)/);
  assert.match(html,/Reported receipts/);
  assert.match(html,/Reported disbursements/);
  assert.doesNotMatch(html,/Current balance|Current total/);
  for(const amount of [9007199254740992,'1e12','NaN']) {
    const invalid=render({...profile,receipts:amount});
    assert.match(invalid,/<dt>Reported receipts<\/dt><dd>Exact amount unavailable<\/dd>/);
  }
});

test('currency formatting groups text, removes only trailing zeros and never rounds fractional values',()=>{
  for(const [amount,shown] of [
    ['6435.120000000','$6,435.12 USD'],['-24.110000000','-$24.11 USD'],
    ['0001234.5000','$1,234.50 USD'],['0','$0.00 USD'],['-0.000','-$0.00 USD'],
    ['123456789012345678901234567890.123456789','$123,456,789,012,345,678,901,234,567,890.123456789 USD'],
    ['0.000000001','$0.000000001 USD'],['1.239000','$1.239 USD'],
  ]) {
    const row=Object.freeze({...profile,receipts:amount,receipts_raw:amount});
    const html=render(row);
    assert.ok(html.includes(`<dd>${shown}</dd>`),shown);
    assert.ok(html.includes(`<dd>${amount} / ${amount}</dd>`),amount);
    assert.equal(row.receipts,amount);
  }
  for(const [receipts,receipts_status,message] of [
    [null,'source_null','Source field is null'],['','source_empty','Source field is empty'],
    [null,'refused','Value could not be accepted'],[null,'not_supplied','Not supplied by this source'],
  ]) {
    const main=render({...profile,receipts,receipts_status}).split('<details>')[0];
    assert.ok(main.includes(message));
    assert.doesNotMatch(main,/<dt>Reported receipts<\/dt><dd>\$0/);
  }
});

test('ambiguous decisions keep witnesses visible and do not choose figures from retained competing values',()=>{
  const html=render({...profile,selection_status:'ambiguous',selection_reason:'conflicting_reported_snapshots',coverage_status:'ambiguous',coverage_reasons_json:'["conflicting_reported_snapshots"]',witness_count:3});
  assert.match(html,/No single source snapshot is selected/);
  assert.equal((html.match(/<dd>Not selected<\/dd>/g)??[]).length,4);
  assert.doesNotMatch(html,/ USD/);
  assert.match(html,/Source records disagree/);
  assert.match(html,/Coverage: Period unresolved/);
  assert.match(html,/conflicting_reported_snapshots/);
  assert.match(html,/<dt>Recorded witnesses<\/dt><dd>3<\/dd>/);
});

test('reported amounts and period qualification remain separate, including missing and invalid dates',()=>{
  const html=render({...profile,entity_kind:'committee',entity_id:'C00000001',coverage_status:'unqualified',
    coverage_reasons_json:'["period_end_after_capture","period_outside_declared_cycle","period_start:invalid_date"]',
    period_start:null,period_start_raw:'not-a-date',period_start_status:'invalid_date',
    period_end:new Date('2026-12-31T00:00:00Z'),period_end_raw:'12/31/2026'});
  assert.match(html,/committee C00000001/);
  assert.match(html,/Source cycle: 2026/);
  assert.match(html,/Reported period: Not available → 2026-12-31/);
  assert.match(html,/Start: Invalid source date · End: Reported date/);
  assert.match(html,/<dt>Source date text<\/dt><dd>not-a-date → 12\/31\/2026/);
  assert.match(html,/Snapshot captured: 2026-09-12T10:00:00Z/);
  assert.match(html,/reported end follows the snapshot capture date/);
  assert.match(html,/\$9,007,199,254,740,993\.01 USD/);
  assert.match(html,/Coverage: Period not qualified/);
  const missing=render({...profile,period_start:null,period_end:null,period_start_raw:null,period_end_raw:null,period_start_status:'source_null',period_end_status:'source_empty'});
  assert.match(missing,/Reported period: Not available → Not available/);
  assert.match(missing,/Start: Source date is null · End: Source date is empty/);
  assert.match(missing,/<dt>Source date status<\/dt><dd>source_null → source_empty/);
});

test('known decisions use readable labels, unknown codes stay explicit, and raw fields remain in details',()=>{
  const html=render({...profile,selection_reason:'equivalent_witnesses'});
  const [main,details]=html.split('<details>');
  assert.match(main,/Matching source records; figures are shown once, not added together/);
  assert.match(main,/Coverage: Period checks passed/);
  assert.doesNotMatch(main,/equivalent_witnesses|total_receipts|source_null/);
  assert.match(details,/selected \/ equivalent_witnesses/);
  assert.match(details,/total_receipts \/ exact/);
  assert.match(details,/source_reported|Only insignificant decimal zeros/);
  const unknown=render({...profile,selection_status:'future_selection',selection_reason:'future_reason',
    coverage_status:'future_coverage',coverage_reasons_json:'["period_end:future:date","future_reason"]',
    period_end_status:'future:date',receipts_status:'constructor'}).split('<details>')[0];
  for(const code of ['future_selection','future_reason','future_coverage','future:date','constructor'])assert.ok(unknown.includes(`Unknown: ${code}`),code);
  assert.equal((unknown.match(/<dd>Not selected<\/dd>/g)??[]).length,4);
  assert.doesNotMatch(unknown,/Period checks passed|\$9,007/);
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
    assert.doesNotMatch(html,/ USD/);
  }
  assert.match(render({...profile,amount_basis:'transaction_derived'}),/profile definition is unavailable/);
  for(const coverage_reasons_json of [null,'not json','{"reason":"unknown"}']) {
    const html=render({...profile,coverage_reasons_json});
    assert.match(html,/Coverage reasons are unavailable/);
    assert.match(html,/Coverage: Qualification unavailable/);
    assert.doesNotMatch(html,/Period checks passed/);
  }
  assert.equal(render(profile,{...table,id:'fec_reported_financial_summaries'}),'');
  assert.match(render({...profile,entity_name:'<script>bad</script>'}),/&lt;script&gt;bad&lt;\/script&gt;/);
});

test('profile browse columns identify entity, cycle and decision without implying current totals',()=>{
  assert.deepEqual(defaultColumns(table),['entity_kind','entity_id','entity_name','source_cycle','selection_status','coverage_status']);
});
