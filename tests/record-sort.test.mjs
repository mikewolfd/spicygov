import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function module(path) {
  const {outputFiles} = await build({entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false});
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const {sortValue, compareEntries} = await module('lib/record-sort.ts');
const {readLocation, makeHref} = await module('lib/explorer-location.ts');
test('dates, numbers, booleans and missing values retain their sort meaning', () => {
  for (const direction of ['asc', 'desc']) {
    const sort = {column: 'field', direction};
    const entries = [null, 10, 2, NaN].map((value, position) => ({value: sortValue(value), position})).sort((a, b) => compareEntries(a, b, sort));
    assert.deepEqual(entries.map(entry => entry.position), direction === 'asc' ? [2, 1, 0, 3] : [1, 2, 0, 3]);
  }
  assert.ok(compareEntries({value: sortValue(new Date('2020-01-01')), position: 0}, {value: sortValue(new Date('2024-01-01')), position: 1}, {column: 'date', direction: 'asc'}) < 0);
  assert.ok(compareEntries({value: false, position: 0}, {value: true, position: 1}, {column: 'flag', direction: 'asc'}) < 0);
  assert.equal(sortValue(new Date('invalid')), null);
});
test('sort, filters and page history survive shared URLs; clearing sort removes its parameters', () => {
  const state = {id: 'records', filters: [{column: 'name', value: 'A & B'}], cursor: 93, view: 'records', sort: {column: 'event date', direction: 'desc'}, trail: [0, 47], from: 'Related records'};
  assert.deepEqual(readLocation(makeHref(state).slice(1)), state);
  const cleared = makeHref({...state, sort: undefined, cursor: 0, trail: []});
  assert.equal(new URLSearchParams(cleared.slice(2)).has('sort'), false);
  assert.equal(new URLSearchParams(cleared.slice(2)).has('order'), false);
  assert.equal(readLocation('?table=records&sort=id').sort.direction, 'asc');
});
