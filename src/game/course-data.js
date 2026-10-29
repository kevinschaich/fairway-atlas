import {withEstimatedPar} from './par-estimate.js';
import {requestProviders,facilityBounds} from './data-sources.js';
import {pointIn} from './engine.js';
export const diagnostics=[];
export function record(stage,message,start){(window.__tl??=[]).push([Math.round(performance.now()),stage+": "+message]);const row={time:new Date().toISOString().slice(11,19),stage,message,ms:start===undefined?undefined:Math.round(performance.now()-start)};diagnostics.push(row);if(diagnostics.length>100)diagnostics.shift();document.dispatchEvent(new CustomEvent('data-progress',{detail:row}));return row}
export const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function searchIndex(index,query,limit=35){const terms=normalize(query).split(' ').filter(Boolean);if(!terms.length)return index.slice(0,limit);return index.filter(c=>terms.every(t=>c.search.includes(t))).sort((a,b)=>(normalize(b.name).startsWith(terms[0])?1:0)-(normalize(a.name).startsWith(terms[0])?1:0)).slice(0,limit)}
export async function readIndex(){const start=performance.now();const r=await fetch('./data/course-index.json');if(!r.ok)throw Error(`Course index HTTP ${r.status}`);const d=await r.json();const index=d.courses.map(c=>({...c,live:true,source:{type:c.id.split('/')[0],id:Number(c.id.split('/')[1])},facility:c.name,search:normalize(c.name+' '+(c.aliases||'')+' '+c.location)}));record('index',`${index.length.toLocaleString()} course entries indexed · ${d.date}`,start);return index}
export function joinRings(e){if(e.geometry)return[e.geometry.map(p=>[p.lon,p.lat])];const parts=(e.members||[]).filter(m=>m.role==='outer'&&m.geometry).map(m=>m.geometry.map(p=>[p.lon,p.lat]));const rings=[];while(parts.length){const r=parts.shift();let changed=true;while(changed){changed=false;for(let i=0;i<parts.length;i++){let p=parts[i],last=r.at(-1);if(last[0]===p.at(-1)[0]&&last[1]===p.at(-1)[1])p=p.slice().reverse();if(last[0]===p[0][0]&&last[1]===p[0][1]){r.push(...p.slice(1));parts.splice(i,1);changed=true;break}}}if(r.length>=4&&r[0][0]===r.at(-1)[0]&&r[0][1]===r.at(-1)[1])rings.push(r)}return rings}
export function featuresFrom(elements){
 const result=[];for(const e of elements){const t=e.tags||{};if(e.type==='node'&&t.natural==='tree'&&Number.isFinite(e.lon)&&Number.isFinite(e.lat)){result.push({id:'node/'+e.id,kind:'tree',coords:[[e.lon,e.lat]],closed:false,source:'OpenStreetMap',evidence:'observed',tags:t});continue}
 if(t.golf==='hole'||t.leisure==='golf_course'||!(t.golf||t.building||['water','wood','scrub','bare_rock','sand','coastline'].includes(t.natural)||['forest','grass'].includes(t.landuse)))continue;
 const rings=e.geometry?[e.geometry]:joinRings(e).map(r=>r.map(([lon,lat])=>({lon,lat})));
 const inner=e.geometry?[]:joinRings({...e,members:(e.members||[]).filter(m=>m.role==='inner').map(m=>({...m,role:'outer'}))});
 rings.forEach((g,i)=>{if(g.length<2)return;const first=g[0],last=g.at(-1);result.push({id:e.type+'/'+e.id+(rings.length>1?'/'+i:''),kind:t.building?'building':t.natural==='water'||['water_hazard','lateral_water_hazard'].includes(t.golf)?'water':t.golf||t.natural||(t.landuse==='forest'?'wood':'rough'),coords:g.map(p=>[p.lon,p.lat]),holes:inner.filter(r=>pointIn(r[0],g.map(p=>[p.lon,p.lat]))),closed:g.length>=4&&first.lon===last.lon&&first.lat===last.lat,source:'OpenStreetMap',evidence:'observed',tags:t})});
 }return result;
}
export function parseRouting(item,data){const facility=data.elements.find(x=>x.id===item.source.id&&x.type===item.source.type),boundary=joinRings(facility||{});if(!boundary.length)throw Error('MISSING_BOUNDARY: this OSM facility has no closed course boundary. Geometry has not been invented.');let raw=data.elements.filter(x=>x.tags?.golf==='hole'&&x.geometry?.length>1&&(boundary.some(r=>pointIn([x.geometry[0].lon,x.geometry[0].lat],r))||x.geometry.filter(p=>boundary.some(r=>pointIn([p.lon,p.lat],r))).length>x.geometry.length/2));
 if(!raw.length)throw Error('MISSING_ROUTING: no mapped hole lines lie within this course boundary.');
 let routingNote='',routingName=item.name;
 // Some facilities explicitly distinguish their courses as hole/total (1/18,
 // 1/9). Select the largest complete numbered set; never merge duplicate holes.
 const numbered=raw.map(x=>/^(\d+)\/(\d+)$/.exec(x.tags.ref||''));
 if(numbered.every(Boolean)){
  const groups=new Map();raw.forEach((x,i)=>{const total=+numbered[i][2];if(!groups.has(total))groups.set(total,[]);groups.get(total).push({...x,tags:{...x.tags,original_ref:x.tags.ref,ref:numbered[i][1]}})});
  const complete=[...groups].filter(([total,holes])=>total>0&&total<=72&&holes.length===total&&new Set(holes.map(h=>+h.tags.ref)).size===total&&holes.every(h=>+h.tags.ref>=1&&+h.tags.ref<=total)).sort((a,b)=>b[0]-a[0]);
  if(!complete.length)throw Error('AMBIGUOUS_ROUTING: hole/total labels exist, but no complete uniquely numbered course was found.');
  const [total,selected]=complete[0];raw=selected;routingName=item.name+' · '+total+'-hole course';routingNote='Using the complete '+total+'-hole routing.'+(groups.size>1?' Other mapped routings: '+[...groups.keys()].filter(n=>n!==total).sort((a,b)=>b-a).join(', ')+' holes.':'');
 }
 const refs=raw.map(x=>x.tags.ref);if(new Set(refs).size!==refs.length||refs.some(r=>!/^\d+$/.test(r||'')))throw Error('AMBIGUOUS_ROUTING: duplicate or unsupported hole numbers ('+[...new Set(refs)].slice(0,12).join(', ')+'). Select a specific course boundary.');
 const holes=raw.map(x=>({id:x.id,number:+x.tags.ref,par:['3','4','5','6'].includes(x.tags.par)?+x.tags.par:null,route:x.geometry.map(p=>[p.lon,p.lat]),tags:x.tags})).map(withEstimatedPar).sort((a,b)=>a.number-b.number);
 return {id:item.id,name:routingName,facility:item.facility,routing:routingName,routingNote,location:item.location,center:item.center,boundary,features:featuresFrom(data.elements),holes,sourceId:item.id,date:data.osm3s?.timestamp_osm_base?.slice(0,10)||new Date().toISOString().slice(0,10),terrain:null,stage:'routing'};
}
function attemptLog(row){record(row.stage,`${row.name} · ${row.status} · ${row.ms} ms · ${row.message}${row.httpStatus?' · response HTTP '+row.httpStatus:''}${row.url?'\n'+row.url:''}`)}
export async function requestBoundary(item,signal){const start=performance.now();record('boundary',`${item.name}: requesting its course boundary directly…`);const data=await requestProviders(item,'boundary',{signal,onAttempt:attemptLog,validateResult:data=>{facilityBounds(data,item);if(!joinRings(data.elements.find(e=>e.type===item.source.type&&e.id===item.source.id)||{}).length)throw Error('No closed course boundary')}});record('boundary ready',data.diagnostics.provider,start);return{data,bbox:facilityBounds(data,item)}}
export async function requestStage(item,stage,signal,{bbox,facility}={}){const start=performance.now();record(stage,`${item.name}: browser requesting ${stage==='routing'?'holes and golf surfaces':'surrounding scenery'}…`);try{
 const merged=data=>{const elements=new Map(data.elements.map(e=>[e.type+'/'+e.id,e]));for(const e of facility?.elements||[])elements.set(e.type+'/'+e.id,e);return{...data,elements:[...elements.values()]}};
 const data=await requestProviders(item,stage,{bbox,signal,onAttempt:attemptLog,validationData:{facility},validateResult:data=>parseRouting(item,merged(data))});record(stage,`${data.elements.length} source elements · browser → ${data.diagnostics.provider}`,start);return merged(data);
 }catch(e){if(!signal?.aborted)record(stage,e.message,start);throw e}}

// Supplementary scenery must not require hole routing or a facility relation in
// the same response. Some providers return only the requested surrounding tags.
export async function requestScenery(item,bbox,signal){
 const start=performance.now();record('scenery',`${item.name}: requesting surrounding trees and buildings directly…`);
 const validateResult=d=>{if(!Array.isArray(d.elements))throw Error('Scenery response has no element list')};validateResult.scenery=true;
 const data=await requestProviders(item,'features',{bbox,signal,onAttempt:attemptLog,validateResult});
 record('scenery',`${data.elements.length} source elements · browser → ${data.diagnostics.provider}`,start);return data;
}
