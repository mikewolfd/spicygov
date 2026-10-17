import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Constructed adapter fixtures exercise the real reader/lookup algorithms above
// admission thresholds without a corpus download or a large retained file.
const state = { members: new Map(), bySize: new Map(), reads: [], renewals: 0, corrupt: false, short: false };
globalThis.__readerProbe = state;
const mock = `
export const rowIndex = Symbol('rowIndex');
export async function asyncBufferFromUrl(options) {
  return {url:options.url, byteLength:options.byteLength, async slice(start,end=options.byteLength) {
    const response=await options.fetch(options.url,{...options.requestInit,headers:{...options.requestInit.headers,Range:'bytes='+start+'-'+(end-1)}});
    return response.arrayBuffer();
  }};
}
export async function parquetMetadataAsync(file) { return {num_rows:globalThis.__readerProbe.bySize.get(file.byteLength).rows}; }
export async function parquetReadObjects({file,columns,rowStart,rowEnd,includeRowIndex}) {
  const s=globalThis.__readerProbe, member=s.bySize.get(file.byteLength);
  s.reads.push({url:member.url,columns,start:rowStart,end:rowEnd});
  const rows=[];
  for(let i=rowStart;i<rowEnd;i++) {
    const source=member.row(i), row=Object.fromEntries(columns.map(c=>[c,source[c]]));
    if(includeRowIndex)row[rowIndex]=i;
    rows.push(row);
  }
  if(s.corrupt)rows.pop();
  return rows;
}`;
const output = await build({
  stdin: { contents: "export * from './lib/reader.ts'; export * from './lib/record-lookup.ts';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'constructed-parquet', setup(builder) {
    builder.onResolve({ filter: /^hyparquet$/ }, () => ({ path: 'hyparquet', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mock, loader: 'js' }));
  } }],
});
const { readPage, locateRecord } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text+'\n//# sourceURL=constructed-reader-probe.mjs').toString('base64')}`);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.equal(init.cache, 'no-store');
  const member = state.members.get(String(url)), range = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get('range'));
  state.renewals++;
  const start = +range[1], end = +range[2];
  return new Response(new Uint8Array(state.short?0:end - start + 1), { status: 206, headers: {
    ETag: member.etag, 'Content-Range': `bytes ${start}-${end}/${member.byteSize}`,
  } });
};
function fixture(id, rows, row) {
  const url = `https://constructed.test/${id}`;
  const byteSize=100+state.members.size,member={url,rows,row,etag:'"v1"',byteSize};
  state.members.set(url,member);state.bySize.set(byteSize,member);
  return { id, rows, publicationIdentity: id, columns: ['id','sort','group'].map(name => ({name,type:name==='id'?'VARCHAR':'INTEGER'})),
    members: [{ url, rows, byteSize, etag: '"v1"' }], recordIdentity: {columns:['id']} };
}
const decoded = () => state.reads.reduce((n, r) => n + r.end - r.start, 0);
const reset = () => {state.reads.length=0;state.renewals=0;};
try {
  await test('large sorted windows amortize population decodes and preserve ties/nulls over window boundaries', async context => {
    const n=100001, table=fixture('large-sort',n,i=>({id:String(i),sort:i%13===0?null:i%19,group:i%2}));
    for(const direction of ['asc','desc']) {
      const expected=Array.from({length:n},(_,i)=>i).filter(i=>i%2===1).sort((a,b)=>{
        const x=state.members.get(table.members[0].url).row(a).sort,y=state.members.get(table.members[0].url).row(b).sort;
        return x===null&&y!==null?1:y===null&&x!==null?-1:((x<y?-1:x>y?1:0)*(direction==='asc'?1:-1)||a-b);
      });
      const request={table,columns:['id'],filters:[{column:'group',value:'1'}],cursor:0,limit:1000,sort:{column:'sort',direction}};
      reset();let cursor=0;const actual=[];
      for(let page=0;page<9;page++) {
        const result=await readPage({...request,cursor});
        actual.push(...result.positions);cursor=result.cursor;assert.equal(result.done,false);
        if(page===7)assert.equal(state.reads.filter(r=>r.columns.includes('sort')&&r.columns.includes('group')).reduce((n,r)=>n+r.end-r.start,0),n);
      }
      assert.deepEqual(actual,expected.slice(0,9000));
      assert.equal(state.reads.filter(r=>r.columns.includes('sort')&&r.columns.includes('group')).reduce((n,r)=>n+r.end-r.start,0),n*2);
      let done=false,pages=9;
      while(!done){const page=await readPage({...request,cursor});actual.push(...page.positions);cursor=page.cursor;done=page.done;pages++;assert.ok(pages<60);}
      assert.deepEqual(actual,expected);
      const populationRows=state.reads.filter(r=>r.columns.includes('sort')&&r.columns.includes('group')).reduce((n,r)=>n+r.end-r.start,0);
      assert.equal(populationRows,n*Math.ceil(pages/8));
      context.diagnostic(JSON.stringify({case:'constructed-large-sorted-sequence',direction,rows:n,pages,baselinePopulationRows:n*pages,retainedPopulationRows:populationRows,retainedEntriesAtMost:8000}));
      // A new request can change page size and replay a boundary in the retained window.
      const replay=await readPage({...request,cursor:actual[7999]+1,limit:137});
      assert.deepEqual(replay.positions,expected.slice(8000,8137));
      assert.ok(decoded()>=n*2+9000);
      const end=await readPage({...request,cursor:expected.at(-2)+1});
      assert.deepEqual(end.positions,expected.slice(-1));assert.equal(end.done,true);
    }
  });
  await test('full sorted caches bind filter, order, connection recipe, generation and all member versions',async()=>{
    const table=fixture('small-sort',31,i=>({id:String(i),sort:i%5,group:i%2}));
    const request={table,columns:['id'],filters:[],cursor:0,limit:4,sort:{column:'sort',direction:'asc'}};
    const first=await readPage(request);reset();
    await readPage({...request,cursor:first.cursor});assert.ok(!state.reads.some(r=>r.columns.includes('sort')));
    // Declared identity arrives with metadata; it must not discard a completed sort.
    reset();await readPage({...request,cursor:first.cursor,table:{...table,recordIdentity:{columns:['sort']}}});assert.ok(!state.reads.some(r=>r.columns.includes('sort')));
    const source=state.members.get(table.members[0].url);
    source.etag='"v2"';await assert.rejects(readPage({...request,cursor:first.cursor}),/identity could not be checked/);source.etag='"v1"';
    for(const change of [{filters:[{column:'group',value:'1'}]},{sort:{column:'sort',direction:'desc'}},{table:{...table,publicationIdentity:'other'}}]){
      reset();await readPage({...request,...change});assert.ok(state.reads.some(r=>r.columns.includes('sort')));
    }
    // A filtered-out cursor keeps its actual sort boundary rather than becoming a list offset.
    const filtered={...request,filters:[{column:'group',value:'1'}]};await readPage(filtered);
    const result=await readPage({...filtered,cursor:3});
    const expected=Array.from({length:31},(_,i)=>i).filter(i=>i%2&&((i%5)>2||(i%5===2&&i>2))).sort((a,b)=>a%5-b%5||a-b).slice(0,4);
    assert.deepEqual(result.positions,expected);
    const key={parts:[{from:'row',path:['id']}],separator:'',pattern:'.+'};
    const navigation={id:'n',source:table.id,fields:[],mode:'row',targets:[{table:'target',columns:['id'],keys:[key],guards:[]}],receiptFields:[],elementPath:[]};
    const connected={...request,navigation,connection:{id:'n',target:0,values:['3']}};
    assert.deepEqual((await readPage(connected)).positions,[3]);
    assert.deepEqual((await readPage({...connected,connection:{...connected.connection,values:['4']}})).positions,[4]);
    assert.deepEqual((await readPage({...connected,navigation:{...navigation,targets:[{...navigation.targets[0],guards:[{from:'row',path:['id'],values:['4']}]}]}})).positions,[]);
  });
  await test('large exact lookups memoize only witnessed completion and enforce continuation ownership and bounded eviction',async()=>{
    const n=500001,table=fixture('large-key',n,i=>({id:String(i),sort:i,group:0}));
    const filters=[{column:'id',value:'7'}];reset();
    const first=await locateRecord(table,filters);assert.equal(first.status,'incomplete');assert.deepEqual(first.positions,[7]);
    await assert.rejects(locateRecord(table,filters,first.cursor,[]),/continuation no longer matches/);
    let result=await locateRecord(table,filters,first.cursor,first.positions);
    assert.equal(result.status,'incomplete');result=await locateRecord(table,filters,result.cursor,result.positions);
    assert.equal(result.status,'found');assert.equal(result.row.id,'7');
    reset();assert.equal((await locateRecord(table,filters)).status,'found');assert.equal(decoded(),1);assert.equal(state.renewals,1);
    // Each constructed key is ambiguous after two rows: cheap enough to fill the memo without 128 full scans.
    const duplicate=fixture('large-duplicate',n,i=>({id:i===0?'first':'same',sort:i,group:0}));
    await locateRecord(duplicate,[{column:'id',value:'same'}]);
    state.members.get(duplicate.members[0].url).etag='"changed"';
    await assert.rejects(locateRecord(duplicate,[{column:'id',value:'same'}]),/identity could not be checked/);
    state.members.get(duplicate.members[0].url).etag='"v1"';
    // Single generation, 129 distinct witnessed ambiguous queries; literal integer spellings share actual equality.
    const numeric={...duplicate,columns:duplicate.columns.map(c=>c.name==='id'?{...c,type:'INTEGER'}:c)};
    state.members.get(duplicate.members[0].url).row=i=>({id:1,sort:i,group:0});
    for(let i=0;i<129;i++)await locateRecord(numeric,[{column:'id',value:'0'.repeat(i)+'1'}]);
    reset();await locateRecord(numeric,[{column:'id',value:'1'}]);assert.ok(decoded()>1);
  });
  await test('an oversized key population is projected once per binding, then lookups use bounded continuation',async context=>{
    // 64 distinct ~1 MiB identities exceed the 128 MiB key estimate inside the first 50,000-row batch.
    const long='x'.repeat(1024*1024),table=fixture('oversized-key',300000,i=>({id:i<100?long+i:String(i),sort:i,group:0}));
    reset();assert.equal((await locateRecord(table,[{column:'id',value:'299999'}])).status,'incomplete');const first=decoded();
    reset();assert.equal((await locateRecord(table,[{column:'id',value:'299998'}])).status,'incomplete');const second=decoded();
    assert.equal(first,300000);assert.equal(second,250000);
    context.diagnostic(JSON.stringify({case:'oversized-key-population',rows:300000,firstLookupDecodedRows:first,secondLookupDecodedRows:second}));
  });
  await test('corrupt projection lengths and oversized cached values never admit partial sorted state',async()=>{
    const table=fixture('corrupt',31,i=>({id:String(i),sort:i,group:0}));
    const request={table,columns:['id'],filters:[],cursor:0,limit:2,sort:{column:'sort',direction:'asc'}};
    state.corrupt=true;await assert.rejects(readPage(request),/incomplete batch/);state.corrupt=false;
    state.short=true;await assert.rejects(readPage(request),/byte range is incomplete/);state.short=false;
    reset();await readPage(request);assert.ok(decoded()>31);
    // One large shared string keeps the fixture allocation bounded while exceeding retained estimates.
    const long='x'.repeat(1024*1024),wide=fixture('wide-sort',100001,i=>({id:String(i),sort:long,group:0}));
    const wideRequest={...request,table:wide};await readPage(wideRequest);reset();
    await readPage(wideRequest);assert.ok(decoded()>=100001);
  });
} finally {
  globalThis.fetch=originalFetch;delete globalThis.__readerProbe;
}
