// ESA WorldCover v200: categorical 10 m Sentinel-derived land cover, not a tree survey.
export function canopyTiles(bounds){
 const out=[];for(let lat=Math.floor(bounds[1]/3)*3;lat<bounds[3];lat+=3)for(let lon=Math.floor(bounds[0]/3)*3;lon<bounds[2];lon+=3){
 const name=`${lat<0?'S':'N'}${String(Math.abs(lat)).padStart(2,'0')}${lon<0?'W':'E'}${String(Math.abs(lon)).padStart(3,'0')}`;
 out.push({lon,lat,url:`https://ai4edataeuwest.blob.core.windows.net/esa-worldcover/v200/2021/map/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`});}return out;
}
export function sampleCanopy(data,lon,lat){
 for(const t of data?.tiles||[]){const x=(lon-t.origin[0])/t.resolution[0]-.5,y=(lat-t.origin[1])/t.resolution[1]-.5;if(x<0||y<0||x>t.width-1||y>t.height-1)continue;
 const ix=Math.floor(x),iy=Math.floor(y);let trees=0,shrubs=0,grass=0;
 for(let j=0;j<2;j++)for(let i=0;i<2;i++){const c=t.values[Math.min(t.height-1,iy+j)*t.width+Math.min(t.width-1,ix+i)],weight=(i?x-ix:1-x+ix)*(j?y-iy:1-y+iy);if(c===10)trees+=weight;if(c===20)shrubs+=weight;if(c===30)grass+=weight;}
 return {trees,shrubs,grass};}return null;
}
export function fetchCanopy(boundary,signal){
 const points=boundary.flat(),lat=points[0][1],dy=500/111320,dx=dy/Math.cos(lat*Math.PI/180),bounds=[Math.min(...points.map(p=>p[0]))-dx,Math.min(...points.map(p=>p[1]))-dy,Math.max(...points.map(p=>p[0]))+dx,Math.max(...points.map(p=>p[1]))+dy];
 return new Promise((resolve,reject)=>{signal?.throwIfAborted();const worker=new Worker(new URL('./canopy-worker.js',import.meta.url),{type:'module'});const cleanup=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);worker.terminate();};const abort=()=>{cleanup();reject(signal.reason)};const timeout=setTimeout(()=>{cleanup();reject(Error('Satellite tree cover timed out after 20 seconds; using mapped woodland only.'))},20000);signal?.addEventListener('abort',abort,{once:true});worker.onerror=e=>{cleanup();reject(Error('Satellite tree cover: '+e.message))};worker.onmessage=({data})=>{cleanup();if(data.error)reject(Error(data.error));else resolve(data)};worker.postMessage({bounds});});
}
