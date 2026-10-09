// Pages edge gate: internal source, tests and migrations never become public assets.
const PUBLIC_MODULES=new Set(['/calculator.mjs','/frontend-quote.mjs','/frontend-locations.mjs','/frontend-security.mjs','/frontend-tracking.mjs']);
const PRODUCTION_HOSTS=new Set(['fonsecalog.com.br','www.fonsecalog.com.br']);
const INLINE_HASHES = "'sha256-Snzcj9HPJLW1imp6WkxIdF0Lqip1rvtIWTXWfCO0rJA=' 'sha256-eUxYLcG1Qv5KIQz0V4mzTC7btz4q0U4HW6s9tSrlYk8=' 'sha256-UJJCXi8d1GS2UkPCZ/Af3OA85t4AGqw8yyna3W3bYSo=' 'sha256-Plo0ul+pSECEGy/47geCbYifLgUE6dIcffxCTtVGN4U='";
const CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' "+INLINE_HASHES+" https://unpkg.com/leaflet@1.9.4/dist/leaflet.js https://challenges.cloudflare.com https://connect.facebook.net; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob: https://*.tile.openstreetmap.org https://www.facebook.com https://unpkg.com; font-src 'self'; connect-src 'self' https://fonseca-logistica-api.fonsecalogistica047.workers.dev https://challenges.cloudflare.com https://www.facebook.com https://connect.facebook.net; frame-src https://challenges.cloudflare.com; upgrade-insecure-requests";
function headers(hostname){return {
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin',
  'Permissions-Policy':'camera=(), microphone=(), payment=(), geolocation=(self)',
  'Content-Security-Policy':CSP,
  ...(PRODUCTION_HOSTS.has(hostname)?{}:{'X-Robots-Tag':'noindex, nofollow'})
};}
export default {
  async fetch(request,env){
    const url=new URL(request.url),secure=headers(url.hostname);
    if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Método não permitido',{status:405,headers:secure});
    let path;try{path=decodeURIComponent(url.pathname);}catch{return new Response('Não encontrado',{status:404,headers:secure});}
    if(path==='/site-config.json'){
      const id=String(env.META_PIXEL_ID||'');
      const production=PRODUCTION_HOSTS.has(url.hostname);
      const config={securityEnabled:env.SECURITY_ENABLED==='true',turnstileSiteKey:String(env.TURNSTILE_SITE_KEY||''),pixelEnabled:production&&/^\d{8,25}$/.test(id),metaPixelId:production&&/^\d{8,25}$/.test(id)?id:null};
      return new Response(request.method==='HEAD'?null:JSON.stringify(config),{headers:{...secure,'Content-Type':'application/json; charset=UTF-8','Cache-Control':'no-store'}});
    }
    if(path==='/frete/')return Response.redirect(url.origin+'/frete'+url.search,301);
    const isPage=['/','/index.html','/frete'].includes(path);
    const publicAsset=path.startsWith('/assets/')&&!path.includes('..')&&!path.includes('\\')&&/\.(?:png|jpe?g|webp|avif|gif|svg|ico|woff2?|mp4)$/i.test(path);
    if(!isPage&&!PUBLIC_MODULES.has(path)&&!publicAsset&&!['/robots.txt','/sitemap.xml','/favicon.ico'].includes(path))return new Response('Não encontrado',{status:404,headers:{...secure,'Cache-Control':'no-store'}});
    const assetUrl=new URL(request.url);if(isPage)assetUrl.pathname='/index.html';
    const response=await env.ASSETS.fetch(new Request(assetUrl,request));
    const result=new Response(response.body,response);for(const [key,value]of Object.entries(secure))result.headers.set(key,value);
    if(isPage||PUBLIC_MODULES.has(path))result.headers.set('Cache-Control','no-cache');
    return result;
  }
};
