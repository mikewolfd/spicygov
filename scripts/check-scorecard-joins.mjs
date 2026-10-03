import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
async function compile(path) {
  const { outputFiles } = await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const {loadCatalog} = await compile('lib/catalog.ts');
const {readPage} = await compile('lib/reader.ts');
const catalog = await loadCatalog();
const {joins} = JSON.parse(await readFile('lib/data/table_joins.json','utf8'));
const scorecardJoins = joins.filter(j=>j.child.startsWith('scorecard'));
for (const j of scorecardJoins) {
  const child=catalog.find(t=>t.id===j.child), parent=catalog.find(t=>t.id===j.parent);
  assert.ok(child && parent, `Published endpoints: ${j.child} -> ${j.parent}`);
  assert.equal(j.child_columns.length,j.parent_columns.length);
  for(const [table,cols] of [[child,j.child_columns],[parent,j.parent_columns]])
    assert.ok(cols.every(col=>table.columns.some(c=>c.name===col)),`Live columns: ${table.id}`);
}
for(const [childId,parentId] of [
  ['scorecard_member_ratings','scorecard_members'],
  ['scorecard_member_links','scorecard_members'],
  ['scorecard_member_links','members'],
  ['scorecard_item_links','scorecard_items'],
  ['scorecard_item_links','congress_bills'],
]) {
  const join=scorecardJoins.find(j=>j.child===childId && j.parent===parentId);
  const child=catalog.find(t=>t.id===childId),parent=catalog.find(t=>t.id===parentId);
  const sample=await readPage({table:child,columns:join.child_columns,filters:[],cursor:0,limit:100});
  const row=sample.rows.find(row=>join.child_columns.every(k=>row[k]!=null));
  assert.ok(row,`Non-null sample: ${childId}`);
  const found=await readPage({table:parent,columns:join.parent_columns,filters:join.parent_columns.map((column,i)=>({column,value:String(row[join.child_columns[i]])})),cursor:0,limit:1});
  assert.equal(found.rows.length,1,`Matching record: ${childId} -> ${parentId}`);
  console.log(`PASS ${childId} -> ${parentId} (${join.child_columns.join(' + ')})`);
}
console.log(`Validated ${scorecardJoins.length} scorecard join schemas and five live record traversals.`);
