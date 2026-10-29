import {asset} from './asset.js';
// Client-side 24 h cache for every external data request (satellite, elevation, OSM geometry,
// land cover, map tiles). Installs a fetch wrapper in whichever context imports it (the page and
// each data worker). Uses the browser Cache Storage API; nothing is stored on a server.
// Key = method + URL + Range + body, so POSTed Overpass queries and GeoTIFF byte ranges cache too.
const TTL=24*3600e3,STORE='fairway-net-v1',HOST='https://fairway-cache.invalid/';
const g=globalThis;
if(!g.__fairwayNetCache&&typeof g.fetch==='function'&&g.caches){
 g.__fairwayNetCache=true;const raw=g.fetch.bind(g);let snapPromise=null;const snapshotIndex=()=>snapPromise??=raw(asset('snapshot/index.json')).then(r=>r.ok?r.json():null).catch(()=>null);let store=null;const open=()=>store??=caches.open(STORE).catch(()=>null);
 const hash=async text=>{const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')};
 const origin=g.location?.origin;
 const cacheable=(url,method)=>/^https?:/.test(url)&&!url.startsWith(origin+'/')&&(method==='GET'||method==='POST');
 const bodyText=async(input,init)=>{const b=init?.body??(input instanceof Request&&input.method!=='GET'?await input.clone().text():'');if(b==null)return'';if(typeof b==='string')return b;if(b instanceof URLSearchParams)return b.toString();if(typeof FormData!=='undefined'&&b instanceof FormData)return[...b.entries()].map(([k,v])=>k+'='+v).join('&');if(b instanceof Blob)return await b.text();if(b instanceof ArrayBuffer||ArrayBuffer.isView(b))return[...new Uint8Array(b.buffer??b)].join(',');return null};
 g.fetch=async(input,init={})=>{
  let url,method,headers;try{url=input instanceof Request?input.url:String(input);method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));}catch{return raw(input,init)}
  if(!cacheable(url,method))return raw(input,init);
  const body=await bodyText(input,init);if(body===null)return raw(input,init);
  const keyUrl=/\.blob\.core\.windows\.net\//.test(url)?url.split('?')[0]:url;// SAS tokens rotate; the blob itself doesn't
  const key=HOST+await hash(method+' '+keyUrl+' '+(headers.get('range')||'')+' '+body);const c=await open();
  // Bundled snapshot (published builds): serve recorded responses from files shipped next to the app.
  const snap=await snapshotIndex();const hit0=snap?.[key.slice(HOST.length)];
  if(hit0){try{const r=await raw(asset('snapshot/'+key.slice(HOST.length)));if(r.ok){const h=new Headers();if(hit0.t)h.set('content-type',hit0.t);if(hit0.cr)h.set('content-range',hit0.cr);return new Response(await r.arrayBuffer(),{status:hit0.s||200,headers:h})}}catch{}}
  if(c){try{const hit=await c.match(key);if(hit&&Date.now()-Number(hit.headers.get('x-cached-at')||0)<TTL){const h=new Headers(hit.headers);const status=Number(h.get('x-status')||200);h.delete('x-cached-at');h.delete('x-status');g.__netCacheHits=(g.__netCacheHits||0)+1;return new Response(await hit.arrayBuffer(),{status,headers:h})}}catch{}}
  const res=await raw(input,init);
  if(c&&res.ok){try{const copy=res.clone(),buf=await copy.arrayBuffer(),h=new Headers();for(const k of['content-type','content-range','accept-ranges','last-modified','etag'])if(copy.headers.get(k))h.set(k,copy.headers.get(k));h.set('x-cached-at',String(Date.now()));try{h.set('x-req',btoa(unescape(encodeURIComponent(JSON.stringify({m:method,u:url,r:headers.get('range')||'',b:body})))))}catch{}h.set('x-status',String(res.status));c.put(key,new Response(buf,{status:200,headers:h})).catch(()=>{})}catch{}}
  return res;
 };
 // Drop expired entries once per session so the store never grows without bound.
 setTimeout(async()=>{try{const c=await open();if(!c)return;for(const req of await c.keys()){const r=await c.match(req);if(!r||Date.now()-Number(r.headers.get('x-cached-at')||0)>=TTL)await c.delete(req)}}catch{}},15000);
}
export {};
