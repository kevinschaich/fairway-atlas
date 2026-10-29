// Terrarium heights are decoded before interpolation. RGB values are never resized.
export const lonLatToTile=(lon,lat,z)=>[(lon+180)/360*2**z,(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*2**z];
export const tileToLonLat=(x,y,z)=>[x/2**z*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y/2**z)))*180/Math.PI];
export const decodeTerrarium=(r,g,b)=>r*256+g+b/256-32768;
export function sampleTerrain(t,lon,lat,clampToEdge=false){
 let u,v;if(t.pixelOrigin){const p=lonLatToTile(lon,lat,t.zoom);u=p[0]*t.tileSize-t.pixelOrigin[0]-.5;v=p[1]*t.tileSize-t.pixelOrigin[1]-.5}else{const b=t.bounds;u=(lon-b[0])/(b[2]-b[0])*(t.width-1);v=(b[3]-lat)/(b[3]-b[1])*(t.height-1)}
 if(clampToEdge){u=Math.max(0,Math.min(t.width-1,u));v=Math.max(0,Math.min(t.height-1,v));}
 if(u<0||v<0||u>t.width-1||v>t.height-1)return null;
 const i=Math.min(t.width-2,Math.floor(u)),j=Math.min(t.height-2,Math.floor(v)),fx=u-i,fz=v-j,a=t.values[j*t.width+i],b=t.values[j*t.width+i+1],c=t.values[(j+1)*t.width+i],d=t.values[(j+1)*t.width+i+1];
 return (a*(1-fx)+b*fx)*(1-fz)+(c*(1-fx)+d*fx)*fz;
}
export const fetchHoleTerrain=(course,hole,signal,onAttempt)=>fetchTerrain(hole.route,signal,[16,15,14,13,12],onAttempt);
export const fetchCourseTerrain=(boundary,signal)=>fetchTerrain(boundary.flat(),signal);
async function fetchTerrain(pts,signal,zooms=[16,14,12],onAttempt=()=>{}){
 const failures=[];
 const lat=pts[0][1],padLat=125/111320,padLon=padLat/Math.cos(lat*Math.PI/180);
 const bounds=[Math.min(...pts.map(p=>p[0]))-padLon,Math.min(...pts.map(p=>p[1]))-padLat,Math.max(...pts.map(p=>p[0]))+padLon,Math.max(...pts.map(p=>p[1]))+padLat];
 // Native 512px z16 tiles: ~0.96 m/pixel at Pebble Beach. Regional source resolution varies.
 for(const z of zooms){const level=new AbortController(),tileSignal=signal?AbortSignal.any([signal,level.signal]):level.signal;try{
  const a=lonLatToTile(bounds[0],bounds[3],z),b=lonLatToTile(bounds[2],bounds[1],z),x0=Math.floor(a[0]),y0=Math.floor(a[1]),x1=Math.floor(b[0]),y1=Math.floor(b[1]),size=512,width=(x1-x0+1)*size,height=(y1-y0+1)*size;
  if((x1-x0+1)*(y1-y0+1)>12)continue;const values=new Float32Array(width*height),jobs=[];
  for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)jobs.push((async()=>{
   const url=`https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`;const r=await fetch(url,{signal:AbortSignal.any([tileSignal,AbortSignal.timeout(8000)]),mode:'cors',credentials:'omit'});if(!r.ok)throw Error(`Mapterhorn HTTP ${r.status} · z${z} tile ${x}/${y} · ${url}`);
   const bitmap=await createImageBitmap(await r.blob(),{colorSpaceConversion:'none',premultiplyAlpha:'none'});if(bitmap.width!==size||bitmap.height!==size){bitmap.close();throw Error('Unexpected elevation tile dimensions')}
   const canvas=new OffscreenCanvas(size,size),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);bitmap.close();const rgb=ctx.getImageData(0,0,size,size).data;
   for(let py=0;py<size;py++)for(let px=0;px<size;px++){const i=(py*size+px)*4;values[((y-y0)*size+py)*width+(x-x0)*size+px]=decodeTerrarium(rgb[i],rgb[i+1],rgb[i+2])}
  })());await Promise.all(jobs);signal?.throwIfAborted();
  const sw=tileToLonLat(x0,y1+1,z),ne=tileToLonLat(x1+1,y0,z);
  return{bounds:[...sw,...ne],width,height,values,pixelOrigin:[x0*size,y0*size],zoom:z,tileSize:size,spacing:40075016.686*Math.cos(lat*Math.PI/180)/(2**z*size),source:'Mapterhorn',fallback:z!==zooms[0],attempts:failures,version:3,resolution:`Native z${z} elevation samples; source resolution varies`};
 }catch(e){if(signal?.aborted)throw signal.reason;const message=e.name==='TimeoutError'?`Mapterhorn z${z}: tile request timed out after 8 seconds`:e.message;failures.push(message);onAttempt(message+(z!==zooms.at(-1)?' · trying the next available resolution':''));if(z===zooms.at(-1))throw Error('Elevation unavailable: '+failures.join(' | '))}finally{level.abort()}}
 throw Error('Selected terrain extent exceeds the native-tile budget. Retry with a shorter mapped hole.');
}
