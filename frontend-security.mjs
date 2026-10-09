// Public configuration contains identifiers only. Secrets never leave the API Worker.
export const API_ORIGIN='https://fonseca-logistica-api.fonsecalogistica047.workers.dev';
export class PublicAccessError extends Error {constructor(message){super(message);this.publicMessage=message;}}
let configPromise,session,pendingSession,turnstilePromise;
export function siteConfig(){
  if(!configPromise)configPromise=fetch('/site-config.json',{cache:'no-store'}).then(async r=>{
    if(!r.ok)throw new PublicAccessError('Não foi possível carregar a configuração do site. Atualize a página.');
    return r.json();
  }).catch(e=>{configPromise=null;throw e;});
  return configPromise;
}
function loadTurnstile(){
  if(window.turnstile)return Promise.resolve(window.turnstile);
  if(!turnstilePromise)turnstilePromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;
    script.onload=()=>window.turnstile?resolve(window.turnstile):reject(new PublicAccessError('Validação indisponível.'));script.onerror=()=>reject(new PublicAccessError('Não foi possível carregar a validação. Confira sua conexão.'));document.head.append(script);
  }).catch(e=>{turnstilePromise=null;throw e;});
  return turnstilePromise;
}
async function challenge(sitekey){
  const turnstile=await loadTurnstile();
  return new Promise((resolve,reject)=>{
    const dialog=document.createElement('dialog');dialog.className='access-dialog';dialog.innerHTML='<h2>Verificando acesso</h2><p>Esta verificação protege a calculadora. Aguarde um instante.</p><div class="access-widget"></div><button type="button">Cancelar</button>';
    document.body.append(dialog);let widget,settled=false;
    const finish=(error,token)=>{if(settled)return;settled=true;clearTimeout(timeout);if(widget!==undefined)turnstile.remove(widget);dialog.close();dialog.remove();error?reject(error):resolve(token);};
    const timeout=setTimeout(()=>finish(new PublicAccessError('A validação demorou. Tente novamente.')),90000);
    dialog.querySelector('button').onclick=()=>finish(new PublicAccessError('Validação cancelada.'));dialog.addEventListener('cancel',()=>finish(new PublicAccessError('Validação cancelada.')));dialog.showModal();
    try{widget=turnstile.render(dialog.querySelector('.access-widget'),{sitekey,action:'fonseca_session',theme:'dark',callback:token=>finish(null,token),'error-callback':()=>{finish(new PublicAccessError('Não foi possível validar o acesso. Tente novamente.'));return true;},'expired-callback':()=>finish(new PublicAccessError('Validação expirada. Tente novamente.'))});}catch{finish(new PublicAccessError('Validação indisponível.'));}
  });
}
async function accessToken(){
  const config=await siteConfig();if(!config.securityEnabled)return null;
  if(session?.expiresAt>Date.now()/1000+15)return session.token;
  if(pendingSession)return pendingSession;
  pendingSession=(async()=>{
    if(!config.turnstileSiteKey)throw new PublicAccessError('Validação de acesso ainda não configurada. Solicite atendimento pelo WhatsApp.');
    const turnstileToken=await challenge(config.turnstileSiteKey);
    const response=await fetch(API_ORIGIN+'/security/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({turnstileToken}),signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if(!response.ok||typeof result.token!=='string'||!Number.isInteger(result.expiresAt))throw new PublicAccessError(result.error||'Não foi possível validar o acesso.');
    session=result;return result.token;
  })().finally(()=>{pendingSession=null;});return pendingSession;
}
export async function ensureAccess(){await accessToken();}
export async function secureFetch(input,init={}){
  if(new URL(input,API_ORIGIN).origin!==API_ORIGIN)throw new PublicAccessError('Serviço inválido.');
  if(init.signal?.aborted)throw new DOMException('Cancelado','AbortError');
  const token=await accessToken();if(init.signal?.aborted)throw new DOMException('Cancelado','AbortError');
  const headers=new Headers(init.headers);if(token)headers.set('X-Fonseca-Session',token);
  const controller=new AbortController();const cancel=()=>controller.abort();init.signal?.addEventListener('abort',cancel,{once:true});const timeout=setTimeout(cancel,20000);
  try{
    const response=await fetch(input,{...init,headers,signal:controller.signal});if(response.status===401)session=null;
    return response; // Never retry quote submission or searches silently.
  }finally{clearTimeout(timeout);init.signal?.removeEventListener('abort',cancel);}
}
