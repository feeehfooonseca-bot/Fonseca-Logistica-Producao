import { siteConfig } from './frontend-security.mjs';
const CHOICE_KEY='fonseca_marketing_choice_v1';
let fbq,consented=false,viewed=false,calculatorVisible=false;const sentLeads=new Set();
export function pixelPayload(detail={}){
  const value=Number(detail.price),count=Number(detail.deliveries),payload={};
  if(Number.isFinite(value)&&value>=0){payload.value=value;payload.currency='BRL';}
  if(Number.isSafeInteger(count)&&count>=1&&count<=20)payload.num_items=count;
  return payload;
}
function startPixel(id){
  if(fbq)return;
  if(typeof window.fbq==='function')fbq=window.fbq;
  else{fbq=window.fbq=function(){fbq.callMethod?fbq.callMethod.apply(fbq,arguments):fbq.queue.push(arguments);};window._fbq=fbq;fbq.push=fbq;fbq.loaded=true;fbq.version='2.0';fbq.queue=[];
    const script=document.createElement('script');script.async=true;script.src='https://connect.facebook.net/en_US/fbevents.js';document.head.append(script);}
  fbq('set','autoConfig',false,id);fbq('init',id);fbq('consent','grant');
  if(!viewed){fbq('track','PageView');viewed=true;}
  if(calculatorVisible)fbq('track','ViewContent',{content_name:'Calculadora de entrega'});
}
export function trackPixel(event,detail={}){
  if(!consented||!fbq)return;
  const payload=pixelPayload(detail);
  if(event==='quote_calculated')fbq('trackCustom','QuoteCalculated',payload);
  if(event==='quote_requested'){
    const id=typeof detail.quote_code==='string'?detail.quote_code:null;
    if(!id||sentLeads.has(id))return;sentLeads.add(id);fbq('track','Lead',payload,{eventID:'fonseca-'+id});
  }
}
export async function setupTracking(){
  let config;try{config=await siteConfig();}catch{return;}
  if(!config.pixelEnabled||!/^\d{8,25}$/.test(config.metaPixelId||''))return;
  const readChoice=()=>{try{return localStorage.getItem(CHOICE_KEY);}catch{return null;}};
  const saveChoice=value=>{try{localStorage.setItem(CHOICE_KEY,value);}catch{}};
  const panel=document.createElement('aside');panel.className='privacy-choice';panel.setAttribute('aria-label','Preferências de privacidade');
  panel.innerHTML='<p>Podemos medir suas visitas para melhorar nossos anúncios? A calculadora funciona com qualquer escolha.</p><button type="button" data-accept>Aceitar</button><button type="button" data-decline>Agora não</button>';
  document.body.append(panel);
  const choose=value=>{saveChoice(value);panel.hidden=true;consented=value==='yes';if(consented)startPixel(config.metaPixelId);else if(fbq)fbq('consent','revoke');};
  panel.querySelector('[data-accept]').onclick=()=>choose('yes');panel.querySelector('[data-decline]').onclick=()=>choose('no');
  const preferences=document.createElement('button');preferences.type='button';preferences.className='privacy-preferences';preferences.textContent='Preferências de privacidade';preferences.onclick=()=>{panel.hidden=false;};document.querySelector('footer')?.append(preferences);
  const choice=readChoice();if(choice)choose(choice);
  const calculator=document.getElementById('quoteApp');
  if(calculator){const observer=new IntersectionObserver(entries=>{if(calculatorVisible||!entries.some(e=>e.isIntersecting))return;calculatorVisible=true;observer.disconnect();if(consented&&fbq)fbq('track','ViewContent',{content_name:'Calculadora de entrega'});},{threshold:.1});observer.observe(calculator);}
}
