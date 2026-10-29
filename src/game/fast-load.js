import {MOBILE} from './gpu/budget.js';
// Fast dev loop: client-only course cache (IndexedDB), "use cache" start-on-tee mode with a
// progress bar of what we are really waiting on, and hot reload of the WebGPU engine modules.
// Nothing here talks to a server beyond the static files the page already loads.
const DB='fairway-course-cache',STORE='courses',VERSION_KEY='v1',FLAG='fa-use-cache';
let dbp=null;
const db=()=>dbp??=new Promise((res,rej)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}).catch(()=>null);
const tx=async(mode,fn)=>{const d=await db();if(!d)return null;return new Promise(res=>{try{const t=d.transaction(STORE,mode),q=fn(t.objectStore(STORE));t.oncomplete=()=>res(q?.result??null);t.onerror=t.onabort=()=>res(null)}catch{res(null)}})};

export const fastLoad={
 enabled(){try{const v=localStorage.getItem(FLAG);return v==null?MOBILE:v==='1'}catch{return MOBILE}},   /* mobile default: on (skip the build) */
 setEnabled(v){try{localStorage.setItem(FLAG,v?'1':'0')}catch{}},
 async getCourse(id){const t=performance.now();const v=await tx('readonly',s=>s.get(VERSION_KEY+':'+id));if(v)mark('Course data (cache)',t);return v},
 async putCourse(d){if(!d?.id||d.stage!=='complete')return;try{await tx('readwrite',s=>s.put(structuredClone(d),VERSION_KEY+':'+d.id))}catch(e){console.warn('course cache write failed',e)}},
 async clear(){await tx('readwrite',s=>s.clear())},
 // derived data that is expensive to rebuild on the CPU (noise tiles, per-course rasters), keyed by a content hash of its
 // inputs and the code that makes it: a code or data change is a new key, so entries never go stale, only unused
 async getDerived(key){if(!this.enabled())return null;const t=performance.now();const v=await tx('readonly',s=>s.get('derived:'+key));if(v)mark('cache hit: '+key.split(':')[0],t);return v},
 async putDerived(key,v){if(!this.enabled())return;try{await tx('readwrite',s=>s.put(v,'derived:'+key))}catch(e){console.warn('derived cache write failed',e)}},
 async hash(text){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(b)].slice(0,12).map(x=>x.toString(16).padStart(2,'0')).join('')},
 track,mark,
 hotReload:globalThis.__FA_DEV__!==false?hotReload:null,   // dev only: re-fetches the unbundled dist/gpu sources
};
// ---- timeline marks (also visible as window.__tl) ----
function mark(label,since){(window.__tl??=[]).push([Math.round(performance.now()),label+(since!=null?` (${Math.round(performance.now()-since)} ms)`:'')])}

// ---- progress bar: steps = [{label, done:()=>bool}] ; resolves when all done ----
let barEl=null;
function track(steps){
 barEl?.remove();const el=barEl=document.createElement('div');el.id='fastBar';
 el.innerHTML='<div class="fb-title">Loading from cache</div><div class="fb-track"><i></i></div><ul></ul>';document.body.append(el);
 const ul=el.querySelector('ul'),fill=el.querySelector('i'),t0=performance.now();
 const rows=steps.map(s=>{const li=document.createElement('li');li.textContent=s.label;ul.append(li);return {...s,li,at:0}});
 return new Promise(resolve=>{const tick=()=>{if(barEl!==el)return resolve();let n=0;for(const r of rows){let ok=false;try{ok=!!r.done()}catch{}if(ok&&!r.at){r.at=performance.now();r.li.classList.add('ok');r.li.dataset.ms=Math.round(r.at-t0)+' ms';mark('ready: '+r.label,t0)}if(r.at)n++}
  const cur=rows.find(r=>!r.at);ul.querySelectorAll('li').forEach(li=>li.classList.remove('now'));cur?.li.classList.add('now');
  fill.style.width=(n/rows.length*100)+'%';
  if(n===rows.length){mark('playable',t0);el.classList.add('done');setTimeout(()=>el.remove(),700);return resolve(performance.now()-t0)}
  requestAnimationFrame(tick)};tick()});
}

// ---- hot reload of dist/gpu/*: re-fetch sources, rewrite relative imports to fresh blob URLs ----
async function hotReload(renderer){
 const t0=performance.now();const base=new URL('./gpu/',import.meta.url),stamp='?t='+Date.now(),urls=new Map();
 const load=async name=>{if(urls.has(name))return urls.get(name);const p=(async()=>{let src=await (await fetch(new URL(name,base)+stamp,{cache:'no-store'})).text();
  const deps=[...new Set([...src.matchAll(/from\s*['"]\.\/([\w.-]+\.js)['"]/g)].map(m=>m[1]))];const map={};for(const dname of deps)map[dname]=await load(dname);
  src=src.replace(/from\s*(['"])\.\/([\w.-]+\.js)\1/g,(m,q,dname)=>`from ${q}${map[dname]}${q}`).replace(/from\s*(['"])\.\.\/([\w./-]+\.js)\1/g,(m,q,p)=>`from ${q}${new URL('../'+p,base).href}${q}`)   /* engine core (dist/core) stays the page's shared module instance */.replace(/import\.meta\.url/g,JSON.stringify(new URL(name,base).href));
  return URL.createObjectURL(new Blob([src],{type:'text/javascript'}))})();urls.set(name,p);return p};
 const m=await import(await load('backend.js'));
 const old=renderer.gpu;const g=new m.GpuBackend(renderer);await g.init();
 if(old){for(const k of ['skip','debugPose','debugGrass','debugPost'])if(old[k]!==undefined)g[k]=old[k];try{if(old.canvas!==renderer.canvas)old.canvas?.remove();old.dev?.destroy()}catch{}}
 renderer.gpu=g;renderer.applyGpuEffects?.();g.shadowDirty=true;renderer.invalidateShadows?.();
 const errs=g.errors?.length?g.errors.slice(0,3).join('\n'):'';const ms=Math.round(performance.now()-t0);mark('hot reload',t0);
 return {ms,errors:errs};
}
