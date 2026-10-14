import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

async function load(path) {
  const {outputFiles} = await build({entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false});
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const {connectionCountStatus} = await load('lib/connection-counts.ts');
const {related, isIncomingJoin} = await load('lib/catalog.ts');
const current = {metadataState: 'current'};
const forward = (counts = {}) => ({available: true, measurement: {
  status: 'measured', scope: 'full_selected_inputs', eligible: 19527, matched: 19527, missing: 0, ambiguous: 0, unsupported: 0, ...counts}});
const reverse = (counts = {}) => ({available: true, measurement: {
  status: 'measured', scope: 'all_selected_targets_against_eligible_source_references', matchedTargetRows: 13002, unmatchedTargetRows: 6525, ...counts}});
const status = (direction, capability, extra = {}) => connectionCountStatus({direction, capability, source: current, target: current, ...extra});

test('current scalar and snapshot proofs show forward reference counts, not the legacy join kind', () => {
  const result = status('forward', forward());
  assert.equal(result.state, 'measured');
  assert.equal(result.label, 'Checked');
  assert.equal(result.detail, '19,527 of 19,527 eligible references have a target.');
  assert.doesNotMatch(result.detail, /records/);
});

test('reverse counts describe referenced target records without inventing source-reference counts', () => {
  const result = status('reverse', reverse());
  assert.equal(result.detail, '13,002 of 19,527 target records are referenced · 6,525 not referenced.');
  assert.doesNotMatch(result.detail, /references have|eligible references/);
  assert.equal(status('reverse', reverse({matchedTargetRows: 19527, unmatchedTargetRows: 0})).detail,
    '19,527 of 19,527 target records are referenced.');
});

test('zero eligible references and empty target publications are checked, not unknown', () => {
  const empty = status('forward', forward({eligible: 0, matched: 0}));
  assert.equal(empty.state, 'measured');
  assert.equal(empty.detail, 'No eligible references in this publication.');
  assert.equal(status('reverse', reverse({matchedTargetRows: 0, unmatchedTargetRows: 0})).detail,
    'No target records in this publication.');
});

test('missing, ambiguous and unsupported references remain explicit; ambiguity is a matched subset', () => {
  const result = status('forward', forward({eligible: 10, matched: 8, missing: 2, ambiguous: 3, unsupported: 4}));
  assert.equal(result.label, 'Needs review');
  assert.equal(result.detail, '8 of 10 eligible references have a target · 2 missing · 3 ambiguous · 4 unsupported.');
});

test('unsupported references alone and undocumented copy do not imply a matching problem', () => {
  const result = status('forward', forward({unsupported: 4}), {source: {metadataState: 'undocumented'}, target: {metadataState: 'undocumented'}});
  assert.equal(result.label, 'Checked');
  assert.match(result.detail, /4 unsupported/);
});

test('unknown, invalid and unqualified metadata never produce fabricated counts', () => {
  for (const capability of [undefined, {available: true, measurement: {status: 'unknown', scope: 'unknown'}},
    forward({matched: undefined}), forward({eligible: -1}), forward({matched: 1.5}),
    {...forward(), available: undefined}, forward({matched: 1}), forward({ambiguous: 99999}), forward({scope: 'partial'}),
    reverse({unmatchedTargetRows: undefined})]) {
    const result = status(capability?.measurement?.matchedTargetRows !== undefined ? 'reverse' : 'forward', capability);
    assert.equal(result.state, 'unknown');
    assert.doesNotMatch(result.detail, /19,527|13,002/);
  }
});

test('publication and availability guards take priority over a measured status', () => {
  for (const metadataState of ['loading', 'missing', 'incompatible', 'unavailable']) {
    assert.equal(status('forward', forward(), {source: {metadataState}}).state, 'unavailable');
    assert.equal(status('forward', forward(), {target: {metadataState}}).state, 'unavailable');
  }
  assert.equal(status('forward', {...forward(), available: false}).state, 'unavailable');
  assert.equal(status('forward', forward(), {available: false}).state, 'unavailable');
  assert.equal(status('forward', forward(), {target: undefined}).state, 'unavailable');
  const stale = status('forward', forward(), {target: {metadataState: 'older-publication'}});
  assert.equal(stale.label, 'Counts need updating');
  assert.doesNotMatch(stale.detail, /19,527/);
});

test('external URLs have no internal match denominator; unavailable URLs remain unavailable', () => {
  const result = status('forward', {available: true, measurement: {status: 'unknown', scope: 'unknown'}}, {external: true, target: undefined});
  assert.equal(result.state, 'external');
  assert.equal(result.detail, 'Matching counts do not apply to an external URL.');
  assert.equal(status('forward', {...forward(), available: false}, {external: true, target: undefined}).state, 'unavailable');
});

test('existing self/composite join direction helpers select their own measurement units', () => {
  const join = {child: 'amendments', parent: 'amendments', child_columns: ['congress', 'amended_amendment_id'],
    parent_columns: ['congress', 'amendment_id'], kind: 'unmeasured', directions: {forward: forward(), reverse: reverse()}};
  const links = related('amendments', [join]);
  assert.equal(links.length, 2);
  const details = links.map(link => {
    const direction = isIncomingJoin(link, 'amendments') ? 'reverse' : 'forward';
    return status(direction, link.directions[direction]).detail;
  });
  assert.match(details[0], /eligible references/);
  assert.match(details[1], /target records/);
});
