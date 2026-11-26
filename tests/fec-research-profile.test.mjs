import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

async function load(path) {
  const {outputFiles} = await build({entryPoints:[path],bundle:true,
    platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime'],logLevel:'silent'});
  const loaded = {exports:{}};
  new Function('require','module','exports',outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
  return loaded.exports;
}
const {FecResearchProfile} = await load('components/fec-research-profile.tsx');
const {applyMetadata} = await load('lib/catalog.ts');
const {parseMetadata} = await load('lib/metadata.ts');
const fixtures = JSON.parse(await readFile('tests/fixtures/fec-research-profiles.json','utf8'));
const publication = JSON.parse(await readFile('tests/fixtures/fec-research-publication.json','utf8'));
const bundle = parseMetadata(publication.metadata);
// Use the retained publication's exact family identity and physical schema. The
// ordinary catalog boundary decides whether metadata matches; the panel must
// consume that result rather than granting itself a current definition.
const tables = Object.entries(publication.publication.families).flatMap(([family, entry]) =>
  Object.entries(entry.tables).map(([key, value]) => ({id:key.replace(/\.parquet$/,''),family,
    artifactDigest:entry.artifactDigest,columns:value.columns.map(([name,type])=>({name,type,description:''})),
    label:key.replace(/\.parquet$/,''),metadataState:'loading',connectionNotes:[],members:[],sources:[],inputs:[]})));
const current = Object.fromEntries(applyMetadata(tables,bundle).tables.map(t=>[t.id,t]));
const render = (id, change={}, table=current[id]) => renderToStaticMarkup(createElement(FecResearchProfile,
  {table,row:{...fixtures[id],...change}}));

test('actual disclosed sponsor and unresolved affiliation retain their distinct meanings',()=>{
  const html=render('fec_committee_relationship_profiles');
  assert.match(html,/S6MT00295/);assert.match(html,/ALME/);assert.match(html,/identity unresolved/);
  assert.match(html,/does not establish candidate authorization/);
});
test('source-reconciled individual amounts remain exact and explain itemization',()=>{
  const html=render('fec_contribution_profiles');
  assert.match(html,/\$80,188\.58 USD/);assert.match(html,/\$500\.00 USD/);
  assert.match(html,/69 memo records excluded/);assert.match(html,/not employer donations/);
  assert.match(html,/S6AL00484/);
});
test('outside spending explains cycle scope and source filer counts',()=>{
  const html=render('fec_outside_spending_profiles');
  assert.match(html,/\$115,071,914\.82 USD/);assert.match(html,/opposing/);
  assert.match(html,/election-specific totals are unavailable/);assert.match(html,/24\/48-hour notices/);
});
test('ranked-choice source zero remains a zero and round stays visible',()=>{
  const html=render('fec_election_results');
  assert.match(html,/<strong>0<\/strong> votes/);assert.match(html,/rcv_3/);assert.match(html,/column AC/);
});
test('sector comparison preserves separate measure, cutoff, policy version and unknown denominators',()=>{
  const html=render('sector_financial_comparisons');
  assert.match(html,/\$20,000\.00 USD/);assert.match(html,/lda/);assert.match(html,/income/);
  assert.match(html,/fec-lda-sector-comparison\/1/);assert.match(html,/cutoff 2026-11-13T00:00:00\+00:00/);
  assert.match(html,/unclassified/);assert.match(html,/not complete annual totals/);
});
test('uncertain GE identity is evidence only',()=>{
  const html=render('sector_classification_evidence');
  assert.match(html,/unresolved_identity/);assert.match(html,/not_used_for_money/);
  assert.match(html,/do not establish a same-organization link/);
});
test('multi-issue amounts are explicitly unallocated and overlapping',()=>{
  const html=render('lobbying_issue_financial_observations');
  assert.match(html,/Issue-filtered views overlap/);assert.match(html,/Do not add across issues/);
});
test('malformed relationship evidence remains an explicit failure',()=>{
  assert.match(render('fec_committee_relationship_profiles',{relationships_json:'broken'}),/could not be read/);
});

const interpreted = Object.keys(current).filter(id=>id!=='fec_election_workbook_rows');
test('every interpreted table has a genuine retained known-good row and matching metadata',()=>{
  for(const id of interpreted) {
    assert.equal(current[id].metadataState,'current',id);
    const html=render(id);
    assert.match(html,/<section /,id);
    assert.doesNotMatch(html,/interpretation is unavailable|definition is unavailable/,id);
  }
  const fec=render('sector_financial_comparisons',fixtures.sector_financial_comparisons_fec);
  assert.match(fec,/\$5,982\.59 USD/);
});

test('noncurrent or absent metadata never renders qualified facts or financial assertions',()=>{
  for(const id of interpreted) for(const state of [undefined,'loading','stale','older-publication','missing','incompatible','undocumented','unavailable']) {
    const row=Object.freeze({...fixtures[id]});
    const before=structuredClone(row);
    const html=renderToStaticMarkup(createElement(FecResearchProfile,{table:{...current[id],metadataState:state},row}));
    assert.match(html,/role="status"/,`${id}: ${state}`);
    assert.match(html,/metadata.*publication|publication.*metadata/,`${id}: ${state}`);
    assert.match(html,/raw fields below/,`${id}: ${state}`);
    assert.doesNotMatch(html,/\$|memo records excluded|Leadership PAC sponsor|Official election result/,`${id}: ${state}`);
    assert.deepEqual(row,before,'Unqualified raw evidence must remain intact');
  }
});

const versionFields = {
  fec_committee_relationship_profiles:['policy_version'],
  fec_contribution_profiles:['policy_version','amount_basis'],
  fec_contribution_decisions:['policy_version'],
  fec_outside_spending_profiles:['policy_version','amount_basis','election_basis'],
  fec_outside_spending_spenders:['policy_version','amount_basis','election_basis'],
  fec_election_results:['interpretation_version','reader_version','vote_basis'],
  sector_financial_comparisons:['policy_version','amount_basis','source_family','classification_scheme','mapping_version'],
  sector_classification_evidence:['classification_scheme','mapping_version'],
  lobbying_issue_financial_observations:['amount_basis'],
};
test('missing and future versions or amount bases refuse through the actual renderer',()=>{
  for(const [id,fields] of Object.entries(versionFields)) for(const field of fields) for(const value of [undefined,null,'','unknown-future-policy']) {
    const html=render(id,{[field]:value});
    assert.match(html,/interpretation is unavailable/,`${id}: ${field}=${value}`);
    assert.match(html,/missing or unsupported/,`${id}: ${field}=${value}`);
    assert.doesNotMatch(html,/\$|memo records excluded|Leadership PAC sponsor|Official election result/,`${id}: ${field}=${value}`);
  }
  // Neither source's individually supported basis qualifies the other source.
  for(const change of [{source_family:'fec'},{amount_basis:'publisher_reported_period_flow'}]) {
    assert.match(render('sector_financial_comparisons',change),/interpretation is unavailable/);
  }
});

test('ordinary catalog identity and schema mismatches suppress interpretations while retaining records',()=>{
  for(const mismatch of ['generation','schema','documentation']) {
    const changed=structuredClone(bundle);
    if(mismatch==='generation') for(const family of Object.keys(changed.publication.families)) changed.publication.families[family]='sha256:'+'0'.repeat(64);
    if(mismatch==='schema') for(const value of Object.values(changed.tables)) value.publicationSchema.pop();
    if(mismatch==='documentation') for(const value of Object.values(changed.tables)) value.sourceStatus='unknown';
    const collection=applyMetadata(tables,changed);
    for(const table of collection.tables.filter(t=>interpreted.includes(t.id))) {
      assert.equal(table.metadataState,{generation:'older-publication',schema:'incompatible',documentation:'undocumented'}[mismatch]);
      assert.deepEqual(table.columns.map(c=>[c.name,c.type]),current[table.id].columns.map(c=>[c.name,c.type]));
      assert.match(render(table.id,{},table),/interpretation is unavailable/);
    }
  }
});

test('uninterpreted native workbook and unrelated tables remain raw-only',()=>{
  for(const id of ['fec_election_workbook_rows','unrelated_table','constructor']) {
    assert.equal(renderToStaticMarkup(createElement(FecResearchProfile,{table:{id,metadataState:'current'},row:fixtures.fec_contribution_profiles})), '');
  }
});
