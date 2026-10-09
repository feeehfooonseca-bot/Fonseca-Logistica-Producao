import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pixelPayload} from './frontend-tracking.mjs';
const source=await readFile(new URL('./worker.js',import.meta.url),'utf8');
const worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
const pagesSource=await readFile(new URL('./_worker.js',import.meta.url),'utf8');
const pages=(await import('data:text/javascript;base64,'+Buffer.from(pagesSource).toString('base64'))).default;
const origin='https://app.example.test';
function counterDb(){const counters=new Map();return {counters,prepare(sql){return {bind(...values){this.values=values;return this;},async first(){const [key,bucket,expiry,limit]=this.values;assert.equal(key.length,64);assert(!key.includes('192.0.2'));assert(sql.includes('ON CONFLICT'));const id=key+':'+bucket,n=counters.get(id)||0;if(n>=limit)return null;counters.set(id,n+1);return {requests:n+1};}};}};}
function environment(extra={}){return {SECURITY_ENABLED:'true',ABUSE_SIGNING_SECRET:'test-only-secret-abcdefghijklmnopqrstuvwxyz',TURNSTILE_SECRET_KEY:'test-only-turnstile',QUOTE_DB:counterDb(),ALLOWED_ORIGINS:origin+',https://other.example.test',...extra};}
function request(path,body={},headers={}){return new Request('https://worker.example.test'+path,{method:'POST',headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1','Content-Type':'application/json',...headers},body:JSON.stringify(body)});}
async function withFetch(fake,run){const before=globalThis.fetch;globalThis.fetch=fake;try{await run();}finally{globalThis.fetch=before;}}
async function getSession(env){const r=await worker.fetch(request('/security/session',{turnstileToken:'test-token'}),env);assert.equal(r.status,200);return (await r.json()).token;}
const turnstile=()=>Response.json({success:true,hostname:'app.example.test',action:'fonseca_session'});

test('JSON, limite de corpo e endereços são validados antes de consumir mapas',async()=>{
 await withFetch(()=>{assert.fail('não deve chamar mapa');},async()=>{
  assert.equal((await worker.fetch(request('/locations/search',{text:'x'.repeat(501)}),{ALLOWED_ORIGINS:origin})).status,400);
  assert.equal((await worker.fetch(request('/locations/search',{}, {'Content-Type':'text/plain'}),{ALLOWED_ORIGINS:origin})).status,415);
  assert.equal((await worker.fetch(request('/locations/search',{}, {'Content-Length':'40000'}),{ALLOWED_ORIGINS:origin})).status,413);
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"text":"'+'x'.repeat(40000)+'"}'));c.close();}});
  const r=await worker.fetch(new Request('https://worker.example.test/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:stream,duplex:'half'}),{GEOAPIFY_API_KEY:'fake',BASE_LAT:'-26',BASE_LON:'-49'});assert.equal(r.status,400);
 });
});
test('ativação incompleta falha fechada sem consumir provedores',async()=>{
 await withFetch(()=>assert.fail('não deve consultar provedores'),async()=>{
  assert.equal((await worker.fetch(request('/quote'),environment({QUOTE_DB:null}))).status,503);
  assert.equal((await worker.fetch(request('/quote'),environment({'ABUSE_SIGNING_SECRET':'short'}))).status,503);
  const r=await worker.fetch(new Request('https://worker.example.test/quote',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'},body:'{}'}),environment());assert.equal(r.status,403);
 });
});
test('sessão exige validação externa e hostname/action exatos',async t=>{
 for(const validation of [{success:false},{success:true,hostname:'evil.example',action:'fonseca_session'},{success:true,hostname:'app.example.test',action:'wrong'}])await t.test(JSON.stringify(validation),()=>withFetch(async(url,opts)=>{
  assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');assert.equal(JSON.parse(opts.body).secret,'test-only-turnstile');return Response.json(validation);
 },async()=>{const r=await worker.fetch(request('/security/session',{turnstileToken:'test-token'}),environment());assert.equal(r.status,403);assert(!(await r.text()).includes('test-only-turnstile'));}));
});
test('sessão é assinada e vinculada à origem/IP; token errado não consome mapas',async()=>{
 const env=environment({GEOAPIFY_API_KEY:'fake'});let maps=0;
 await withFetch(async url=>{if(String(url).includes('siteverify'))return turnstile();maps++;return Response.json({results:[]});},async()=>{
  const token=await getSession(env);
  for(const headers of [{'X-Fonseca-Session':token+'0'},{'X-Fonseca-Session':token,'CF-Connecting-IP':'192.0.2.2'},{'X-Fonseca-Session':token,Origin:'https://other.example.test'}])assert.equal((await worker.fetch(request('/locations/search',{text:'São Bento do Sul'},headers),env)).status,401);
  assert.equal(maps,0);
  const r=await worker.fetch(request('/locations/search',{text:'São Bento do Sul'},{'X-Fonseca-Session':token}),env);assert.equal(r.status,200);assert.equal(maps,1);
  const now=Date.now;Date.now=()=>now()+1201*1000;try{assert.equal((await worker.fetch(request('/locations/search',{text:'Cidade'},{'X-Fonseca-Session':token}),env)).status,401);}finally{Date.now=now;}
 });
});
test('limite compartilhado bloqueia excesso antes do Siteverify e responde Retry-After',async()=>{
 const env=environment();let calls=0;
 await withFetch(()=>{calls++;return turnstile();},async()=>{
  for(let i=0;i<6;i++)assert.equal((await worker.fetch(request('/security/session',{turnstileToken:'test-token'}),env)).status,200);
  const r=await worker.fetch(request('/security/session',{turnstileToken:'test-token'}),env);assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'60');assert.equal(calls,6);
 });
});
test('falha D1 retorna erro genérico e não permite bypass de segurança',async()=>{
 const env=environment({QUOTE_DB:{prepare(){throw Error('private SQL secret');}}});const r=await worker.fetch(request('/security/session',{}),env);assert.equal(r.status,503);assert(!(await r.text()).includes('SQL'));
});
test('Pages bloqueia código interno, migrações e HTML de teste e preserva módulos públicos',async()=>{
 const env={ASSETS:{fetch:()=>new Response('asset')},META_PIXEL_ID:'12345678901',TURNSTILE_SECRET_KEY:'never-public',ABUSE_SIGNING_SECRET:'never-public'};
 for(const path of ['/worker.js','/%77orker.js','/worker.test.mjs','/security.test.mjs','/TESTE-LOCAL-CELULAR.html','/migrations/0002_abuse_counters.sql','/FASE-7-SEGURANCA.md','/refresh-csp.mjs','/unknown'])assert.equal((await pages.fetch(new Request('https://fonsecalog.com.br'+path),env)).status,404);
 for(const path of ['/','/frete','/calculator.mjs','/frontend-locations.mjs','/assets/images/logo.png'])assert.equal((await pages.fetch(new Request('https://fonsecalog.com.br'+path),env)).status,200);
 const config=await (await pages.fetch(new Request('https://fonsecalog.com.br/site-config.json'),env)).text();assert(!config.includes('never-public'));assert(config.includes('12345678901'));
 const preview=await pages.fetch(new Request('https://preview.pages.dev/site-config.json'),env);assert.equal((await preview.json()).pixelEnabled,false);assert.equal(preview.headers.get('X-Robots-Tag'),'noindex, nofollow');
});
test('CSP cobre scripts inline e permite GPS e Turnstile sem eval',async()=>{
 const html=await readFile(new URL('./index.html',import.meta.url),'utf8');const r=await pages.fetch(new Request('https://fonsecalog.com.br/'),{ASSETS:{fetch:()=>new Response(html)}});const csp=r.headers.get('Content-Security-Policy');
 for(const [,attrs,code]of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g))if(!attrs.includes('src=')&&!attrs.includes('ld+json'))assert(csp.includes("'sha256-"+createHash('sha256').update(code).digest('base64')+"'"));
 assert(!csp.split('script-src')[1].split(';')[0].includes('unsafe-inline'));assert(!csp.includes('unsafe-eval'));assert(r.headers.get('Permissions-Policy').includes('geolocation=(self)'));assert(csp.includes('frame-src https://challenges.cloudflare.com'));
});
test('anúncios excluem nomes, endereços e tokens',()=>{
 assert.deepEqual(pixelPayload({price:25,deliveries:2,name:'Privado',pickup:'Endereço privado',verificationUrl:'secret-token',quote_code:'FL-TESTE'}),{value:25,currency:'BRL',num_items:2});assert.deepEqual(pixelPayload({price:-1,deliveries:21}),{});
});

test('limite diário bloqueia chamadas extras sem consumir mapas',async()=>{
 const env=environment({GEOAPIFY_API_KEY:'fake',DAILY_SEARCH_LIMIT:'10'});let maps=0;
 await withFetch(async url=>{if(String(url).includes('siteverify'))return turnstile();maps++;return Response.json({results:[]});},async()=>{
  const token=await getSession(env);
  for(let i=0;i<10;i++)assert.equal((await worker.fetch(request('/locations/search',{text:'Cidade'},{'X-Fonseca-Session':token}),env)).status,200);
  const r=await worker.fetch(request('/locations/search',{text:'Cidade'},{'X-Fonseca-Session':token}),env);assert.equal(r.status,429);assert.equal(maps,10);
 });
});

test('pixel dispara PageView e Lead uma vez e nunca envia os detalhes pessoais',async()=>{
 const {setupTracking,trackPixel}=await import('./frontend-tracking.mjs');
 const saved={window:globalThis.window,document:globalThis.document,localStorage:globalThis.localStorage,IntersectionObserver:globalThis.IntersectionObserver,fetch:globalThis.fetch};
 const calls=[];let observer;
 function node(){return {append(){},querySelector(){return {};},setAttribute(){},hidden:false};}
 globalThis.window={fbq:(...args)=>calls.push(args)};
 globalThis.document={createElement:node,body:node(),head:node(),querySelector:()=>node(),getElementById:()=>node()};
 globalThis.localStorage={getItem:()=> 'yes',setItem(){}};
 globalThis.IntersectionObserver=class{constructor(callback){observer=callback;}observe(){}disconnect(){}};
 globalThis.fetch=async()=>Response.json({pixelEnabled:true,metaPixelId:'12345678901',securityEnabled:false});
 try{
  await setupTracking();observer([{isIntersecting:true}]);
  trackPixel('quote_requested',{quote_code:'FL-TESTE',price:15,name:'private-name',pickup:'private-address'});
  trackPixel('quote_requested',{quote_code:'FL-TESTE',price:15});
  assert.equal(calls.filter(x=>x[1]==='PageView').length,1);assert.equal(calls.filter(x=>x[1]==='Lead').length,1);assert.equal(calls.filter(x=>x[1]==='ViewContent').length,1);
  assert(!JSON.stringify(calls).includes('private-'));
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
