import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

await test('bill comparison harness uses canonical composite keys for both digest and experimental positions',async()=>{
  const output=await mkdtemp(join(tmpdir(),'spicy-bill-harness-'));
  try {
    const input=resolve('tests/fixtures/bill-keys-unique.parquet'),bytes=await readFile(input),sha256='sha256:'+createHash('sha256').update(bytes).digest('hex');
    const publication={families:{'bill-family':{prefix:'constructed',artifactDigest:sha256,tables:{'congress_bills.parquet':{rows:3,byteSize:bytes.length,sha256,columns:[['bill_id','VARCHAR'],['title','VARCHAR']]}}}}};
    await writeFile(join(output,'bill-lookup-preregistered.json'),JSON.stringify({bounds:{keyRows:500000,keyMemoryMiB:128}}));
    const bootstrap=`const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{
      const url=String(input);if(url==='https://data.spicygov.ai/publication.v2.json')return new Response(${JSON.stringify(JSON.stringify(publication))});
      if(new URL(url).hostname!=='127.0.0.1')throw new Error('Unexpected external request');return original(input,init);
    };process.argv=['node','compare-bill-lookup',${JSON.stringify(input)},${JSON.stringify(output)}];await import(${JSON.stringify(new URL('../scripts/compare-bill-lookup.mjs',import.meta.url).href)});`;
    await promisify(execFile)(process.execPath,['--input-type=module','-e',bootstrap],{cwd:process.cwd(),timeout:30000});
    const result=JSON.parse(await readFile(join(output,'bill-lookup-results.json'),'utf8'));
    assert.deepEqual(result.failures,[]);
    const rows=[['119-hr-1',0],['119-s-2',1],['118-s-3',2]].map(([key,position])=>[JSON.stringify(['string:'+key]),position]);
    const digest=createHash('sha256');for(const [key,position] of rows)digest.update(key+'\0'+position+'\n');
    assert.equal(result.arms.cache.keyPositionSha256,digest.digest('hex'));
    assert.deepEqual(JSON.parse(await readFile(join(output,'bill-subject-locator.experimental.json'),'utf8')),rows.toSorted(([a],[b])=>a<b?-1:a>b?1:0));
    assert.ok(result.arms.cache.trials.every(t=>t.requests===1));
  } finally {await rm(output,{recursive:true,force:true});}
});
