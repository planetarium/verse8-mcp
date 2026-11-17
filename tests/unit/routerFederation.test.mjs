import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { invokeRouter, routerOrigin, clearRouterTokenCache } from '../../dist/a2a/router.js';
import { runIpAssets } from '../../dist/tools/ipAssets.js';
const originalFetch = globalThis.fetch;
const previous = { origin: process.env.VERSE8_ROUTER_URL, source: process.env.VERSE8_ACCESS_TOKEN };
let dir;
beforeEach(async () => { clearRouterTokenCache(); process.env.VERSE8_ROUTER_URL = 'https://router.example'; process.env.VERSE8_ACCESS_TOKEN = 'source-secret'; dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v8-router-')); });
afterEach(async () => { globalThis.fetch = originalFetch; for (const [key, value] of [['VERSE8_ROUTER_URL', previous.origin], ['VERSE8_ACCESS_TOKEN', previous.source]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await fs.rm(dir, { recursive: true, force: true }); });
function token(scope, expires = 300) { return Response.json({ access_token: 'vicoop-v8-opaque', token_type: 'Bearer', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', expires_in: expires, scope }); }
function mock(taskResult, options = {}) {
 const calls = [];
 globalThis.fetch = async (url, init) => {
  calls.push({url, init}); assert.equal(init.redirect, 'error');
  if (url.endsWith('/api/verse8/token')) { const form = new URLSearchParams(init.body); assert.equal(form.get('subject_token'), 'source-secret'); return token(form.get('scope'), options.expires ?? 300); }
  assert.equal(init.headers.authorization, 'Bearer vicoop-v8-opaque'); assert.ok(!init.body.includes('source-secret'));
  const request = JSON.parse(init.body); return Response.json({ jsonrpc: '2.0', id: request.id, result: taskResult });
 };
 return calls;
}
const task = { kind: 'task', id: 'task-a', contextId: 'context-a', status: {state: 'completed'}, artifacts: [{ artifactId: 'asset', parts: [{kind: 'file', file: {name: '../private.txt', bytes: Buffer.from('actual asset bytes').toString('base64')}}]}] };
test('trusted origin refuses HTTP, paths, userinfo, query and fragments', () => {
 for (const value of ['http://localhost:9000', 'https://router.example/api', 'https://user:secret@router.example', 'https://router.example?x=1', 'https://router.example#x']) { process.env.VERSE8_ROUTER_URL = value; assert.throws(routerOrigin, /router_not_configured/); }
});
test('exchange sends source only to fixed endpoint, least scope and saves actual inline bytes', async () => {
 const calls = mock(task);
 const result = await runIpAssets({pool: 'maple', method: 'message/send', text: 'asset', projectDir: dir});
 assert.equal(result.ok, true); assert.equal(result.taskId, 'task-a'); assert.equal(result.files.length, 1);
 assert.equal(await fs.readFile(result.files[0].path, 'utf8'), 'actual asset bytes');
 assert.equal(result.files[0].name, 'private.txt'); assert.ok(result.files[0].path.startsWith(path.join(await fs.realpath(dir), '.verse8/ip-assets')));
 assert.equal(new URLSearchParams(calls[0].init.body).get('scope'), 'a2a:message.send');
 assert.equal(new URLSearchParams(calls[0].init.body).get('resource'), 'https://router.example/api/a2a/maple');
 assert.ok(!JSON.stringify(result).includes('source-secret')); assert.ok(!JSON.stringify(result).includes('vicoop-v8-opaque'));
});
test('cache is separated by source identity, pool and operation and renews near expiry', async () => {
 let exchanges = 0;
 globalThis.fetch = async (url, init) => {
  if (url.endsWith('/token')) { exchanges++; return token(new URLSearchParams(init.body).get('scope')); }
  return Response.json({jsonrpc: '2.0', id: JSON.parse(init.body).id, result: task});
 };
 await invokeRouter('maple', 'tasks/get', {id:'t'}, 'a'); await invokeRouter('maple', 'tasks/get', {id:'t'}, 'a'); assert.equal(exchanges, 1);
 await invokeRouter('maple', 'tasks/get', {id:'t'}, 'b'); await invokeRouter('other', 'tasks/get', {id:'t'}, 'a'); await invokeRouter('maple', 'tasks/cancel', {id:'t'}, 'a'); assert.equal(exchanges, 4);
 const now = Date.now; Date.now = () => now() + 301000;
 try { await invokeRouter('maple', 'tasks/get', {id:'t'}, 'a'); assert.equal(exchanges, 5); } finally { Date.now = now; }
});
test('URI artifacts are rejected without download or exposing URL', async () => {
 const calls = mock({...task, artifacts:[{artifactId:'uri',parts:[{kind:'file',file:{uri:'https://provider.example/private?secret=x'}}]}]});
 const result = await runIpAssets({pool:'maple',method:'tasks/get',taskId:'task-a',projectDir:dir});
 assert.equal(result.ok,false); assert.equal(result.error,'router_artifact_invalid'); assert.equal(calls.length,2); assert.ok(!JSON.stringify(result).includes('provider.example'));
});
test('symlink output directories cannot write outside project', async () => {
 await fs.symlink(os.tmpdir(), path.join(dir,'.verse8'));
 mock(task); const result = await runIpAssets({pool:'maple',method:'tasks/get',taskId:'task-a',projectDir:dir});
 assert.equal(result.ok,false); assert.equal(result.error,'router_artifact_invalid');
});
test('exchange errors redact upstream tokens and response bodies without resource fallback', async () => {
 let calls=0; globalThis.fetch=async () => {calls++; return new Response('source-secret vicoop-v8-opaque', {status:403});};
 const result=await runIpAssets({pool:'maple',method:'message/send',text:'asset',projectDir:dir});
 assert.equal(result.error,'router_access_denied'); assert.equal(calls,1); assert.ok(!JSON.stringify(result).includes('source-secret'));
});
test('interrupted streaming preserves observed task and never retries dispatch', async () => {
 let calls=0;
 globalThis.fetch=async (url,init) => {
  calls++; if(url.endsWith('/token')) return token(new URLSearchParams(init.body).get('scope'));
  const id=JSON.parse(init.body).id;
  let pull=0; return new Response(new ReadableStream({pull(c){ if(pull++===0)c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({jsonrpc:'2.0',id,result:{kind:'task',id:'task-live',contextId:'ctx',status:{state:'working'}}})}\n\n`)); else c.error(new Error('network source-secret')); }}),{headers:{'content-type':'text/event-stream'}});
 };
 const result=await runIpAssets({pool:'maple',method:'message/stream',text:'asset',projectDir:dir});
 assert.equal(result.error,'router_interrupted'); assert.equal(result.taskId,'task-live'); assert.equal(calls,2); assert.ok(result.messageId); assert.ok(!JSON.stringify(result).includes('source-secret'));
});
test('SSE parses chunked CRLF data and saves completed file artifact', async () => {
 globalThis.fetch=async (url,init) => {
  if(url.endsWith('/token')) return token(new URLSearchParams(init.body).get('scope'));
  const id=JSON.parse(init.body).id;
  const wire=`: keepalive\r\n\r\ndata: ${JSON.stringify({jsonrpc:'2.0',id,result:task})}\r\n\r\n`;
  return new Response(new ReadableStream({start(c){for(let i=0;i<wire.length;i+=7)c.enqueue(new TextEncoder().encode(wire.slice(i,i+7)));c.close();}}),{headers:{'content-type':'text/event-stream'}});
 };
 const result=await runIpAssets({pool:'maple',method:'message/stream',text:'asset',projectDir:dir}); assert.equal(result.ok,true); assert.equal(result.files.length,1);
});
test('invalid scopes, expiry and wrong RPC ids fail closed', async () => {
 for(const response of [{scope:'a2a:task.cancel',expires_in:300},{scope:'a2a:task.read',expires_in:301}]) {
  clearRouterTokenCache(); globalThis.fetch=async()=>token(response.scope,response.expires_in);
  await assert.rejects(invokeRouter('maple','tasks/get',{id:'t'},'source-secret'),/router_invalid_response/);
 }
 globalThis.fetch=async(url,init)=>url.endsWith('/token')?token(new URLSearchParams(init.body).get('scope')):Response.json({jsonrpc:'2.0',id:'wrong',result:task});
 await assert.rejects(invokeRouter('maple','tasks/get',{id:'t'},'source-secret'),/router_invalid_response/);
});
test('MCP dispatcher exposes file paths without source credentials in output or audit', async () => {
 const {createServer} = await import('../../dist/server.js');
 const before = process.env.VERSE8_AUDIT_LOG_PATH;
 const log = path.join(dir,'audit.log'); process.env.VERSE8_AUDIT_LOG_PATH = log;
 try {
  mock(task); const server = createServer();
  const result = await server._requestHandlers.get('tools/call')({method:'tools/call',params:{name:'verse8_ip_assets',arguments:{pool:'maple',method:'message/send',text:'asset',projectDir:dir}}},{});
  assert.equal(result.isError,false); const output = JSON.parse(result.content[0].text);
  assert.equal(output.files.length,1); assert.equal(await fs.readFile(output.files[0].path,'utf8'),'actual asset bytes');
  const logs = await fs.readFile(log,'utf8'); assert.ok(!logs.includes('source-secret')); assert.ok(!logs.includes('vicoop-v8-opaque'));
 } finally { if(before===undefined)delete process.env.VERSE8_AUDIT_LOG_PATH;else process.env.VERSE8_AUDIT_LOG_PATH=before; }
});
test('incomplete streamed artifacts are not written', async () => {
 globalThis.fetch=async(url,init)=> {
  if(url.endsWith('/token'))return token(new URLSearchParams(init.body).get('scope'));
  const id=JSON.parse(init.body).id;
  return new Response(`data: ${JSON.stringify({jsonrpc:'2.0',id,result:{kind:'artifact-update',taskId:'task-a',contextId:'ctx',artifact:task.artifacts[0],lastChunk:false}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
 };
 const result=await runIpAssets({pool:'maple',method:'tasks/resubscribe',taskId:'task-a',projectDir:dir});
 assert.equal(result.ok,true); assert.deepEqual(result.files,[]); assert.deepEqual(result.incompleteArtifacts,['asset']);
});
test('oversized token responses are rejected before resource dispatch', async () => {
 let calls = 0; globalThis.fetch=async()=>{calls++;return new Response('x'.repeat(65537));};
 await assert.rejects(invokeRouter('maple','tasks/get',{id:'t'},'source-secret'),/router_response_too_large/); assert.equal(calls,1);
});
test('resource authentication failure is never retried and clears cached tokens', async () => {
 let exchanges=0, resources=0;
 globalThis.fetch=async(url,init)=>{if(url.endsWith('/token')){exchanges++;return token(new URLSearchParams(init.body).get('scope'));} resources++;return new Response('',{status:401});};
 for(let i=0;i<2;i++)await assert.rejects(invokeRouter('maple','tasks/get',{id:'t'},'source-secret'),/router_access_denied/);
 assert.equal(exchanges,2);assert.equal(resources,2);
});
test('repeated task snapshots reuse content-addressed files without overwriting', async () => {
 mock(task);
 const input={pool:'maple',method:'tasks/get',taskId:'task-a',projectDir:dir};
 const first=await runIpAssets(input);const second=await runIpAssets(input);
 assert.equal(first.files[0].path,second.files[0].path); assert.equal((await fs.readdir(path.dirname(first.files[0].path))).length,1);
 await fs.writeFile(first.files[0].path,'tampered');
 const third=await runIpAssets(input); assert.equal(third.error,'router_artifact_invalid');assert.equal(await fs.readFile(first.files[0].path,'utf8'),'tampered');
});
test('stream append adds parts and writes only after lastChunk', async () => {
 globalThis.fetch=async(url,init)=> {
  if(url.endsWith('/token'))return token(new URLSearchParams(init.body).get('scope'));
  const id=JSON.parse(init.body).id;
  const events=[{kind:'artifact-update',taskId:'t',artifact:{artifactId:'a',parts:[{kind:'file',file:{bytes:'YQ==',name:'a'}}]},lastChunk:false},
   {kind:'artifact-update',taskId:'t',artifact:{artifactId:'a',parts:[{kind:'file',file:{bytes:'Yg==',name:'b'}}]},append:true,lastChunk:true}];
  return new Response(events.map(result=>`data: ${JSON.stringify({jsonrpc:'2.0',id,result})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const result=await runIpAssets({pool:'maple',method:'tasks/resubscribe',taskId:'t',projectDir:dir});
 assert.equal(result.ok,true);assert.equal(result.files.length,2);assert.equal(await fs.readFile(result.files[0].path,'utf8'),'a');assert.equal(await fs.readFile(result.files[1].path,'utf8'),'b');
});
test('resubscribe tail without base artifact is not saved as complete', async () => {
 globalThis.fetch=async(url,init)=> {
  if(url.endsWith('/token'))return token(new URLSearchParams(init.body).get('scope'));
  return new Response(`data: ${JSON.stringify({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{kind:'artifact-update',taskId:'t',artifact:task.artifacts[0],append:true,lastChunk:true}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
 };
 const result=await runIpAssets({pool:'maple',method:'tasks/resubscribe',taskId:'t',projectDir:dir});assert.equal(result.ok,true);assert.deepEqual(result.files,[]);assert.deepEqual(result.incompleteArtifacts,['asset']);
});
test('multi-MiB inline base64 saves actual bytes without regex stack exhaustion', async () => {
 const bytes = Buffer.alloc(6 * 1024 * 1024, 1);
 mock({...task, artifacts:[{artifactId:'large',parts:[{kind:'file',file:{name:'large.bin',bytes:bytes.toString('base64')}}]}]});
 const result=await runIpAssets({pool:'maple',method:'tasks/get',taskId:'task-a',projectDir:dir});
 assert.equal(result.ok,true);assert.equal(result.files[0].sizeBytes,bytes.length);
 assert.deepEqual(await fs.readFile(result.files[0].path),bytes);
});
test('base64 validator rejects invalid alphabet and malformed padding', async () => {
 for(const bytes of ['A===','====','YQ=','YQ===','Y=Q=','=YQ=','YQ==YQ==','YQ==\n','YQ_=', 'YQ-=', 'éQ==']) {
  mock({...task, artifacts:[{artifactId:'invalid',parts:[{kind:'file',file:{bytes}}]}]});
  const result=await runIpAssets({pool:'maple',method:'tasks/get',taskId:'task-a',projectDir:dir});
  assert.equal(result.error,'router_artifact_invalid',JSON.stringify(bytes));
 }
 for(const bytes of ['','YQ==','YWI=','YWJj']) {
  mock({...task, artifacts:[{artifactId:'valid',parts:[{kind:'file',file:{bytes}}]}]});
  const result=await runIpAssets({pool:'maple',method:'tasks/get',taskId:'task-a',projectDir:dir});
  assert.equal(result.ok,true,JSON.stringify(bytes));assert.deepEqual(await fs.readFile(result.files[0].path),Buffer.from(bytes,'base64'));
 }
});
test('provider artifact IDs cannot collide with status messages in either stream order', async () => {
 const artifact={...task.artifacts[0],artifactId:'message-0'};
 const fileEvent={kind:'artifact-update',taskId:'t',contextId:'ctx',artifact,lastChunk:true};
 const statusEvent={kind:'status-update',taskId:'t',contextId:'ctx',final:true,status:{state:'completed',message:{kind:'message',role:'agent',parts:[{kind:'text',text:'Done'}]}}};
 for(const events of [[fileEvent,statusEvent],[statusEvent,fileEvent]]) {
  globalThis.fetch=async(url,init)=> {
   if(url.endsWith('/token'))return token(new URLSearchParams(init.body).get('scope'));
   const id=JSON.parse(init.body).id;
   return new Response(events.map(result=>`data: ${JSON.stringify({jsonrpc:'2.0',id,result})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  };
  const result=await runIpAssets({pool:'maple',method:'tasks/resubscribe',taskId:'t',projectDir:dir});
  assert.equal(result.ok,true);assert.equal(result.files.length,1);assert.equal(result.files[0].artifactId,'message-0');
  assert.equal(await fs.readFile(result.files[0].path,'utf8'),'actual asset bytes');assert.deepEqual(result.messages,['Done']);
 }
});
test('repeated full task snapshots preserve colliding artifact IDs and status text', async () => {
 mock({...task,artifacts:[{...task.artifacts[0],artifactId:'message-0'}],status:{state:'completed',message:{kind:'message',role:'agent',parts:[{kind:'text',text:'Done'}]}}});
 const input={pool:'maple',method:'tasks/get',taskId:'task-a',projectDir:dir};
 const first=await runIpAssets(input);const second=await runIpAssets(input);
 for(const result of [first,second]) {assert.equal(result.ok,true);assert.equal(result.files.length,1);assert.equal(result.files[0].artifactId,'message-0');assert.deepEqual(result.messages,['Done']);}
 assert.equal(first.files[0].path,second.files[0].path);assert.equal(await fs.readFile(second.files[0].path,'utf8'),'actual asset bytes');
});
