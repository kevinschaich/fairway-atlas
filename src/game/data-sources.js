// All runtime geodata requests originate in the player's browser. No server proxy.
export const PROVIDERS={editing:{name:'Editing API',url:'https://api.openstreetmap.org/api/0.6'},postpass:{name:'Postpass',url:'https://postpass.geofabrik.de/api/0.2/interpreter'},overpass:{name:'Overpass',url:'https://overpass-api.de/api/interpreter'}};
export const PROVIDER_DEADLINE_MS=5000;
export const providerAttempts=[];
const cooldowns=new Map(),defaultOrder=['postpass','editing','overpass'];
export function getProviderOrder(){try{const order=JSON.parse(localStorage.getItem('fairway-provider-order'));if(validOrder(order))return order}catch{}return [...defaultOrder]}
export function mergeProviderCooldowns(entries=[]){for(const [provider,until] of entries)if(PROVIDERS[provider]&&Number.isFinite(until))cooldowns.set(provider,Math.max(cooldowns.get(provider)||0,until))}
function validOrder(order){return Array.isArray(order)&&order.length===3&&new Set(order).size===3&&order.every(k=>PROVIDERS[k])}
export function setProviderOrder(order){if(!validOrder(order))throw Error('Choose each provider exactly once');try{localStorage.setItem('fairway-provider-order',JSON.stringify(order))}catch{}}
function validate(item,stage,bbox){const {type,id}=item.source||{};if(!['way','relation'].includes(type)||!/^\d{1,12}$/.test(String(id)))throw Error('A mapped course polygon is required');if(!['boundary','routing','features'].includes(stage))throw Error('Invalid mapping stage');if(stage!=='boundary'&&(!Array.isArray(bbox)||bbox.length!==4||bbox.some(n=>!Number.isFinite(n))||bbox[0]>=bbox[2]||bbox[1]>=bbox[3]||Math.abs(bbox[0])>180||Math.abs(bbox[2])>180||Math.abs(bbox[1])>85||Math.abs(bbox[3])>85||(bbox[2]-bbox[0])*(bbox[3]-bbox[1])>.04))throw Error('Invalid or oversized course bounds')}
export function overpassQuery(item,stage,bbox){validate(item,stage,bbox);const {type,id}=item.source,facility=`${type}(${id});`;if(stage==='boundary')return `[out:json][timeout:5];${facility}out geom;`;const b=[bbox[1],bbox[0],bbox[3],bbox[2]].map(n=>n.toFixed(7)).join(',');return `[out:json][timeout:5];(${facility}way(${b})["golf"${stage==='routing'?'~"^(hole|green)$"':''}];way(${b})["natural"~"^(water|coastline${stage==='features'?'|wood|scrub|bare_rock|sand':''})$"];${stage==='features'?`way(${b})["landuse"~"^(forest|grass)$"];relation(${b})["natural"~"^(wood|scrub)$"];way(${b})["building"];node(${b})["natural"="tree"];`:''});out geom;`}
export function postpassQuery(item,stage,bbox){validate(item,stage,bbox);const {type,id}=item.source,identity=`osm_type='${type==='way'?'W':'R'}' AND osm_id=${id}`;if(stage==='boundary')return `SELECT osm_id, osm_type, tags, geom FROM postpass_polygon WHERE ${identity}`;const spatial=`geom && ST_MakeEnvelope(${bbox.map(n=>n.toFixed(7)).join(',')},4326)`,tags=stage==='features'?`(tags ? 'golf' OR tags ? 'building' OR tags->>'natural' IN ('water','coastline','wood','scrub','bare_rock','sand','tree') OR tags->>'landuse' IN ('forest','grass'))`:`(tags->>'golf' IN ('hole','green'))`;return `SELECT osm_id, osm_type, tags, geom FROM postpass_pointlinepolygon WHERE ${spatial} AND ${tags}`}
export function normalizeOSM(data){
 if(data.error)throw Error(String(data.error));if(!Array.isArray(data.elements))throw Error('Invalid OSM response');const nodes=new Map(data.elements.filter(e=>e.type==='node').map(e=>[e.id,e]));
 const ways=data.elements.filter(e=>e.type==='way').map(e=>({...e,geometry:e.geometry||(e.nodes?.every(id=>nodes.has(id))?e.nodes.map(id=>({lat:nodes.get(id).lat,lon:nodes.get(id).lon})):undefined)})),byId=new Map(ways.map(e=>[e.id,e]));
 return{...data,elements:[...nodes.values()].filter(n=>n.tags&&Object.keys(n.tags).length).concat(ways,data.elements.filter(e=>e.type==='relation').map(e=>({...e,members:e.members?.map(m=>({...m,geometry:m.geometry||byId.get(m.ref)?.geometry}))})))};
}
function lineChain(parts){const remaining=parts.map(p=>p.slice()),result=remaining.shift()||[];while(remaining.length){const last=result.at(-1),i=remaining.findIndex(p=>[p[0],p.at(-1)].some(q=>q[0]===last[0]&&q[1]===last[1]));if(i<0)throw Error('Postpass returned disconnected line geometry');const next=remaining.splice(i,1)[0];if(next[0][0]!==last[0]||next[0][1]!==last[1])next.reverse();result.push(...next.slice(1))}return result}
export function normalizePostpass(data){
 if(data.error)throw Error(String(data.error));if(!Array.isArray(data.features))throw Error('Invalid Postpass GeoJSON response');const elements=[];
 for(const f of data.features){const p=f.properties||{},type={N:'node',W:'way',R:'relation'}[p.osm_type],id=Number(p.osm_id),g=f.geometry;if(!type||!Number.isSafeInteger(id)||!g)continue;const e={type,id,tags:typeof p.tags==='string'?JSON.parse(p.tags):p.tags||{}},points=coords=>coords.map(([lon,lat])=>({lon,lat}));
  if(g.type==='Point'){e.lon=g.coordinates[0];e.lat=g.coordinates[1]}
  else if(['LineString','MultiLineString'].includes(g.type))e.geometry=points(g.type==='LineString'?g.coordinates:lineChain(g.coordinates));
  else if(['Polygon','MultiPolygon'].includes(g.type)){const polygons=g.type==='Polygon'?[g.coordinates]:g.coordinates;e.members=polygons.flatMap(poly=>poly.map((ring,i)=>({role:i?'inner':'outer',geometry:points(ring)})));if(type==='way'&&polygons.length===1){e.geometry=points(polygons[0][0]);e.closed=true}}
  else continue;elements.push(e);
 }return{elements};
}
export function facilityBounds(data,item){const f=data.elements.find(e=>e.type===item.source.type&&e.id===Number(item.source.id));if(!f)throw Error('Selected course boundary is missing');const points=f.geometry||(f.members||[]).filter(m=>m.role==='outer').flatMap(m=>m.geometry||[]);if(!points.length)throw Error('Selected course has no polygon boundary');const padLat=60/111320,padLon=padLat/Math.cos(points[0].lat*Math.PI/180),bbox=[Math.min(...points.map(p=>p.lon))-padLon,Math.min(...points.map(p=>p.lat))-padLat,Math.max(...points.map(p=>p.lon))+padLon,Math.max(...points.map(p=>p.lat))+padLat];validate(item,'routing',bbox);return bbox}
export function sourceError(e,deadlineMs=PROVIDER_DEADLINE_MS,phase='request'){return e.name==='TimeoutError'?`Timed out after ${deadlineMs.toLocaleString('en-US')} ms while ${phase}`:e instanceof TypeError?`Browser network/CORS failure while ${phase}; the browser did not expose an HTTP response`:e.message}
export async function requestProviders(item,stage,{bbox,signal,order=getProviderOrder(),fetcher=fetch,onAttempt=()=>{},deadlineMs=PROVIDER_DEADLINE_MS,validateResult,validationData}={}){
 // Shader compilation must not delay network cancellation. The worker makes
 // these same HTTPS requests directly from the player's browser/IP.
 if(typeof window!=='undefined'&&typeof Worker!=='undefined'&&fetcher===globalThis.fetch)return requestInWorker(item,stage,{bbox,signal,order,onAttempt,deadlineMs,validateResult,validationData});
 validate(item,stage,bbox);if(!validOrder(order))throw Error('Invalid provider order');const errors=[];
 for(const provider of order){signal?.throwIfAborted();const config=PROVIDERS[provider],start=performance.now();let timeout,stop,requestURL,httpStatus,phase='connecting';const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const publish=(status,message)=>{const row={provider,name:config.name,stage,status,ms:Math.round(performance.now()-start),message,url:requestURL,httpStatus,phase,deadlineMs,...((cooldowns.get(provider)||0)>Date.now()?{cooldownUntil:cooldowns.get(provider)}:{})};providerAttempts.push(row);if(providerAttempts.length>90)providerAttempts.shift();onAttempt(row)};
  try{
   if((cooldowns.get(provider)||0)>Date.now())throw Error('provider cooldown after rate limit');
   let url,options={signal:combined,mode:'cors',credentials:'omit',referrerPolicy:'strict-origin-when-cross-origin'};
   if(provider==='editing')url=config.url+(stage==='boundary'?`/${item.source.type}/${item.source.id}/full.json`:'/map.json?'+new URLSearchParams({bbox:bbox.map(n=>n.toFixed(7)).join(',')}));
   else{url=config.url;options={...options,method:'POST',body:new URLSearchParams({data:provider==='postpass'?postpassQuery(item,stage,bbox):overpassQuery(item,stage,bbox)})}}
   requestURL=url;
   // Deadline covers headers, complete body download, and normalization, not just connection setup.
   const expired=new Promise((_,reject)=>{stop=()=>reject(combined.reason);combined.addEventListener('abort',stop,{once:true});timeout=setTimeout(()=>controller.abort(new DOMException('Provider deadline exceeded','TimeoutError')),deadlineMs);if(combined.aborted)stop()});
   const work=(async()=>{const response=await fetcher(url,options);httpStatus=response.status;phase='reading the response';if(!response.ok){if([429,509].includes(response.status)){const retry=response.headers.get('Retry-After'),seconds=Number(retry);cooldowns.set(provider,Math.max(Date.now()+30000,Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(retry)||0))}throw Error(`HTTP ${response.status}${response.statusText?' '+response.statusText:''}${[429,509].includes(response.status)?' — rate limited':''}${response.headers.get('Retry-After')?' · Retry-After: '+response.headers.get('Retry-After'):''}`)}const raw=await response.json();combined.throwIfAborted();if(raw.remark)throw Error(raw.remark.slice(0,160));phase='decoding geometry';const data=provider==='postpass'?normalizePostpass(raw):normalizeOSM(raw);phase='validating mapped holes';validateResult?.(data);if(performance.now()-start>=deadlineMs)throw new DOMException('Provider deadline exceeded','TimeoutError');return data})();
   const data=await Promise.race([work,expired]);publish('ok',`${data.elements.length} elements · browser direct`);return{...data,complete:provider==='editing'&&stage!=='boundary',diagnostics:{provider:config.name,transport:'browser-direct',previousAttempts:errors}};
  }catch(e){if(signal?.aborted)throw signal.reason;const message=sourceError(e,deadlineMs,phase);errors.push(`${config.name}: ${message}`);publish(e.name==='TimeoutError'?'timeout':'error',message)}finally{clearTimeout(timeout);if(stop)combined.removeEventListener('abort',stop);controller.abort()}
 }
 throw Error(`${stage}: ${errors.join(' | ')}`);
}

function requestInWorker(item,stage,{bbox,signal,order,onAttempt,deadlineMs,validateResult,validationData}){
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./provider-worker.js',import.meta.url),{type:'module'});
  const cleanup=()=>{worker.terminate();signal?.removeEventListener('abort',abort)};
  const abort=()=>{cleanup();reject(signal.reason)};
  signal?.addEventListener('abort',abort,{once:true});
  worker.onerror=e=>{cleanup();reject(Error('Browser provider worker: '+e.message))};
  worker.onmessage=e=>{
   const m=e.data;
   if(m.type==='attempt'){if(m.row.cooldownUntil)mergeProviderCooldowns([[m.row.provider,m.row.cooldownUntil]]);providerAttempts.push(m.row);if(providerAttempts.length>90)providerAttempts.shift();onAttempt(m.row);return;}
   cleanup();if(m.type==='result'){try{validateResult?.(m.data);resolve(m.data)}catch(error){reject(error)}}else{const error=Error(m.message);error.name=m.name||'Error';reject(error);}
  };
  worker.postMessage({type:'request',item,stage,bbox,order,deadlineMs,cooldowns:[...cooldowns],validationData,validation:stage==='boundary'?'boundary':validateResult?.scenery?'scenery':'routing'});
 });
}
