import './net-cache.js';
import './vendor/geotiff.js';
import {canopyTiles} from './canopy-data.js';
self.onmessage=async({data:{bounds}})=>{try{
 const tiles=canopyTiles(bounds);if(tiles.length>4)throw Error('Satellite coverage extent exceeds four tiles.');
 const auth=await fetch('https://planetarycomputer.microsoft.com/api/sas/v1/token/ai4edataeuwest/esa-worldcover',{credentials:'omit',signal:AbortSignal.timeout(8000)});if(!auth.ok)throw Error('WorldCover access HTTP '+auth.status);const {token}=await auth.json();
 const result=await Promise.all(tiles.map(async tile=>{
 const tiff=await self.GeoTIFF.fromUrl(tile.url+'?'+token,{allowFullFile:false,blockSize:65536,cacheSize:24,maxRanges:1,credentials:'omit'});
 const image=await tiff.getImage(),origin=image.getOrigin(),resolution=image.getResolution();
 const left=Math.max(0,Math.floor((bounds[0]-origin[0])/resolution[0])),right=Math.min(image.getWidth(),Math.ceil((bounds[2]-origin[0])/resolution[0]));
 const top=Math.max(0,Math.floor((bounds[3]-origin[1])/resolution[1])),bottom=Math.min(image.getHeight(),Math.ceil((bounds[1]-origin[1])/resolution[1]));
 if((right-left)*(bottom-top)>2000000)throw Error('Satellite window exceeds the native-pixel budget.');
 const values=await image.readRasters({window:[left,top,right,bottom],samples:[0],interleave:true});
 return {origin:[origin[0]+left*resolution[0],origin[1]+top*resolution[1]],resolution:resolution.slice(0,2),width:right-left,height:bottom-top,values,url:tile.url};
 }));self.postMessage({source:'ESA WorldCover 2021 v200',resolution:10,tiles:result},result.map(t=>t.values.buffer));
 }catch(e){self.postMessage({error:'Satellite tree cover unavailable: '+e.message+' · using mapped woodland only.'})}};
