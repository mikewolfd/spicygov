import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { registerSourcePeriods } from '../scripts/register-source-periods.mjs';

const {outputFiles} = await build({entryPoints:['lib/register-source-periods.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {parseRegisterSourcePeriods} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const generation = 'sha256:' + 'a'.repeat(64);
const date = label => ({kind:'publication-date', label, basis:'Observed in source content'});
const file = periods => ({status:'held', sha256:'sha256:'+'b'.repeat(64), provenance:{availability:'local'}, periods});

test('builds periods only from locally held, content-observed dates', () => {
  const build = registerSourcePeriods();
  build.addPage('family:federal-register','active',[
    file([date('2024-01-31'),date('2024-03-01'),date('2024-03-01'),date('2024-02-30')]),
    file([{kind:'requested-publication-range',label:'2024-04-01',basis:'Requested'}]),
    {...file([date('2025-01-01')]),status:'missing-bytes'},
    {...file([date('2025-02-01')]),provenance:{availability:'external'}},
  ]);
  build.addPage('family:other','active',[file([date('2025-03-01')])]);
  build.addPage('family:federal-register','attention',[file([date('2025-04-01')])]);
  const result = build.result(generation);
  assert.deepEqual(result.months,['2024-01','2024-03']);
  assert.equal(result.latestIndexedDate,'2024-03-01');
  assert.deepEqual(parseRegisterSourcePeriods(result,generation),{generation,months:result.months,latestIndexedDate:result.latestIndexedDate,dateCoverage:{files:1,datedFiles:1,undatedFiles:0}});
  assert.equal(parseRegisterSourcePeriods(result,'sha256:'+'c'.repeat(64)),undefined);
});

test('empty, malformed, or stale summaries do not claim source coverage', () => {
  const empty = registerSourcePeriods().result(generation);
  assert.deepEqual(parseRegisterSourcePeriods(empty,generation),{generation,months:[],dateCoverage:{files:0,datedFiles:0,undatedFiles:0}});
  for (const invalid of [
    {...empty,months:['2024-13'],latestIndexedDate:'2024-13-01'},
    {...empty,months:['2024-02'],latestIndexedDate:'2024-02-30'},
    {...empty,months:['2024-01'],latestIndexedDate:'2024-02-01'},
    {...empty,months:['2024-01']},
  ]) assert.equal(parseRegisterSourcePeriods(invalid,generation),undefined);
});

test('date coverage counts originals once across aliases and preserves undated files',()=>{
  const collector=registerSourcePeriods();
  collector.addPage('family:federal-register','active',[file([date('2026-09-30')]),file([]),
    {...file([]),sha256:'sha256:'+'c'.repeat(64)}]);
  const result=collector.result(generation);
  assert.deepEqual(result.dateCoverage,{files:2,datedFiles:1,undatedFiles:1});
  assert.deepEqual(parseRegisterSourcePeriods(result,generation).dateCoverage,result.dateCoverage);
  assert.equal(parseRegisterSourcePeriods({...result,dateCoverage:{files:2,datedFiles:2,undatedFiles:1}},generation),undefined);
});

test('verified issue metadata dates before 1994 remain source dates',()=>{
  const collector=registerSourcePeriods();
  // FR-1936-12-31_mods.xml: the source reader checks FR collection, issue ID,
  // and literal originInfo/dateIssued agreement. This does not assert body coverage.
  collector.addPage('family:federal-register','active',[
    {...file([date('1936-12-31')]),sha256:'sha256:a6be5b0dc77b878eb728819ea12828678baca0ade7073cd7bd7a8dd5368a6c56'},
    file([date('2026-10-09')]),
  ]);
  const result=collector.result(generation);
  assert.deepEqual(result.months,['1936-12','2026-10']);
  assert.deepEqual(result.dateCoverage,{files:2,datedFiles:2,undatedFiles:0});
  assert.equal(parseRegisterSourcePeriods(result,generation).latestIndexedDate,'2026-10-09');
});

test('qualified publication context contributes dates while receipt and unsupported bases remain undated',()=>{
  const collector=registerSourcePeriods();
  const context=label=>({...date(label),basis:'Observed in pinned publication context'});
  collector.addPage('family:federal-register','active',[
    file([context('2024-07-15')]),
    {...file([context('2025-07-11')]),sha256:'sha256:'+'c'.repeat(64)},
    {...file([{...context('2030-01-01'),basis:'record.period; declared scope; completeness unknown; Observed in pinned publication context'}]),sha256:'sha256:'+'d'.repeat(64)},
    {...file([{...context('2031-01-01'),basis:'Independent pinned publication_date'}]),sha256:'sha256:'+'e'.repeat(64)},
    {...file([{...context('2032-01-01'),kind:'requested-publication-range'}]),sha256:'sha256:'+'f'.repeat(64)},
  ]);
  const result=collector.result(generation);
  assert.deepEqual(result.months,['2024-07','2025-07']);
  assert.equal(result.latestIndexedDate,'2025-07-11');
  assert.deepEqual(result.dateCoverage,{files:5,datedFiles:2,undatedFiles:3});
});
