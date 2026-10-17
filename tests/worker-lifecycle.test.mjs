import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the actual effect/cancel bodies with controlled Worker replies.
// This exercises ownership without a browser, publisher traffic or duplicated lifecycle code.
const source=readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const effects=[];let cancel;
function visit(node){
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect')effects.push(node);
  if(ts.isFunctionDeclaration(node)&&node.name?.text==='cancel')cancel=node;
  ts.forEachChild(node,visit);
}
visit(ast);
const list=effects.find(n=>n.arguments[0].getText(ast).includes('setProgress(location.sort'));
const unmount=effects.find(n=>n.arguments[0].getText(ast).includes('worker.current=null;listRunning.current=false;'));
function harness(){
  const workers=[],changes=[];
  const values={worker:{current:null},listRunning:{current:false},recordWorker:{current:null},lookupWorker:{current:null},
    table:{id:'fixture',columns:[],members:[],rows:3},catalog:[],publicationsPending:false,
    location:{cursor:0,filters:[]},activeColumns:['id'],navigation:[],URL,
    Worker:class {constructor(){this.terminations=0;workers.push(this);}postMessage(value){this.request=value;}terminate(){this.terminations++;}},
  };
  for(const name of ['setBusy','setRows','setError','setProgress','setDone','setPositions','setNext'])values[name]=v=>changes.push([name,v]);
  function execute(text){return new Function(...Object.keys(values),`return (${text.replaceAll('import.meta.url',"'file:///fixture/app/page.tsx'")})()`)(...Object.values(values));}
  return {values,workers,changes,run:()=>execute(list.arguments[0].getText(ast)),cancel:()=>execute(cancel.getText(ast)),unmount:()=>execute(unmount.arguments[0].getText(ast))()};
}
await test('completed list workers survive page changes; active replacement ignores obsolete replies',()=>{
  const h=harness(),firstCleanup=h.run(),worker=h.workers[0];
  worker.onmessage({data:{type:'result',rows:[{id:'first'}],positions:[0],cursor:1,done:false}});
  assert.equal(h.values.listRunning.current,false);firstCleanup();assert.equal(worker.terminations,0);assert.equal(worker.onmessage,null);
  const secondCleanup=h.run();assert.equal(h.workers.length,1);const obsolete=worker.onmessage;
  secondCleanup();assert.equal(worker.terminations,1);assert.equal(h.values.worker.current,null);
  const before=h.changes.length;obsolete({data:{type:'result',rows:[{id:'obsolete'}]}});assert.equal(h.changes.length,before);
  h.run();assert.equal(h.workers.length,2);
});
await test('Stop, worker errors, and unmount release worker ownership',()=>{
  for(const outcome of ['cancel','error','onerror','unmount']){
    const h=harness();h.run();const worker=h.workers[0],message=worker.onmessage,error=worker.onerror;
    if(outcome==='error')worker.onmessage({data:{type:'error',message:'fixture failure'}});
    else if(outcome==='onerror')worker.onerror();else h[outcome]();
    assert.equal(worker.terminations,1);assert.equal(h.values.worker.current,null);assert.equal(h.values.listRunning.current,false);
    const before=h.changes.length;message({data:{type:'progress',scanned:999}});message({data:{type:'result',rows:[{id:'obsolete'}]}});message({data:{type:'error',message:'obsolete'}});error();assert.equal(h.changes.length,before);
  }
});
await test('list and exact-lookup lifecycles depend on semantic table identity',()=>{
  assert.match(list.arguments[1].getText(ast),/subjectBinding\(table\)/);
  assert.doesNotMatch(list.arguments[1].getText(ast),/recordIdentity/);
  const exact=effects.find(n=>n.arguments[0].getText(ast).includes('findRecord()'));
  assert.match(exact.arguments[1].getText(ast),/subjectBinding\(table\)/);
  assert.match(exact.arguments[1].getText(ast),/recordIdentity/);
});
