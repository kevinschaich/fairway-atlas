// "Export for Unreal": the current hole as Unreal Engine 5 landscape inputs, sampled from exactly what the game draws.
//   heightmap.r16          N×N little-endian uint16, row 0 = smallest game z (Unreal Y), column 0 = smallest x (Unreal X)
//   surfaces_a.png         RGB mask: R fairway, G green, B tee                    (N×N, sampled from world.surface)
//   surfaces_b.png         RGB mask: R bunker/sand, G water, B path/rock; rough = none of the six
//   Alpha is always 255: canvas PNG encoding premultiplies alpha, so data in A would zero the RGB channels.
//   foliage.csv            trees and shrubs (Unreal cm, yaw in degrees, uniform scale, species, layer, height m)
//   fairway_hole.json      everything Unreal needs: landscape resolution, location, XYZ scale, texture extent, hole info
// Axes: game (x east, y up, z south, metres) -> Unreal (X = x, Y = z, Z = y, centimetres). Swapping y/z also swaps
// handedness, so the course is not mirrored.
const SIZES=[127,253,505,1009,2017,4033];
const LAYERS_A=[['fairway'],['green'],['tee']],LAYERS_B=[['bunker','sand'],['water'],['path','bare_rock']];
function region(w,margin=60){const pts=[w.tee,w.pin,...(w.route||[])].filter(Boolean);
 let x0=Math.min(...pts.map(p=>p.x))-margin,x1=Math.max(...pts.map(p=>p.x))+margin,z0=Math.min(...pts.map(p=>p.z))-margin,z1=Math.max(...pts.map(p=>p.z))+margin;
 const ext=Math.max(x1-x0,z1-z0),cx=(x0+x1)/2,cz=(z0+z1)/2;
 let s=.5,N=SIZES.find(n=>(n-1)*s>=ext);if(!N){s=1;N=SIZES.find(n=>(n-1)*s>=ext)||4033;s=Math.max(s,ext/(N-1));}
 const size=(N-1)*s;return{N,s,x0:cx-size/2,z0:cz-size/2,size};}
function png(N,rgba){const c=new OffscreenCanvas(N,N),g=c.getContext('2d');g.putImageData(new ImageData(rgba,N,N),0,0);return c.convertToBlob({type:'image/png'});}
export async function exportUnreal(w,renderer,{onProgress}={}){
 const {N,s,x0,z0,size}=region(w),H=w.__ground||((x,z)=>w.elevation(x,z)),hm=new Float32Array(N*N);
 let lo=Infinity,hi=-Infinity;
 for(let j=0;j<N;j++){for(let i=0;i<N;i++){const h=H(x0+i*s,z0+j*s);hm[j*N+i]=h;if(h<lo)lo=h;if(h>hi)hi=h;}if(j%64===0){onProgress?.(`heights ${Math.round(j/N*100)}%`);await new Promise(r=>setTimeout(r));}}
 // Unreal: height_cm = (v − 32768) · ScaleZ / 128 + LocationZ. Pick the smallest ScaleZ that fits the range (finest steps).
 const mid=(lo+hi)/2,scaleZ=Math.max(1,Math.ceil((hi-lo)/2*100*128/32000*100)/100),r16=new Uint16Array(N*N);
 for(let k=0;k<N*N;k++)r16[k]=Math.max(0,Math.min(65535,Math.round(32768+(hm[k]-mid)*100*128/scaleZ)));
 const A=new Uint8ClampedArray(N*N*4),B=new Uint8ClampedArray(N*N*4),kinds={};
 for(let j=0;j<N;j++){for(let i=0;i<N;i++){const k=w.surface(x0+i*s,z0+j*s)||'rough',o=(j*N+i)*4;kinds[k]=(kinds[k]||0)+1;
  LAYERS_A.forEach((l,c)=>{A[o+c]=l.includes(k)?255:0});LAYERS_B.forEach((l,c)=>{B[o+c]=l.includes(k)?255:0});A[o+3]=B[o+3]=255;}   /* anything unclassified reads as rough */
  if(j%64===0){onProgress?.(`surfaces ${Math.round(j/N*100)}%`);await new Promise(r=>setTimeout(r));}}
 // trees and shrubs actually planted by the game's flora system (cpu layout per instance: x, dy, z, scale, yaw, _, seed, _)
 const rows=['x_cm,y_cm,z_cm,yaw_deg,scale,species,layer,height_m'],inside=(x,z)=>x>=x0&&x<=x0+size&&z>=z0&&z<=z0+size;
 for(const g of renderer?.gpu?.flora?.groups||[]){if(g.layer==='grass'||!g.cpu)continue;let top=0;const P=g.mesh?.near?.pos;if(P)for(let i=1;i<P.length;i+=3)top=Math.max(top,P[i]);
  for(let i=0;i+7<g.cpu.length;i+=8){const x=g.cpu[i],dy=g.cpu[i+1],z=g.cpu[i+2],sc=g.cpu[i+3],yaw=g.cpu[i+4];if(!inside(x,z))continue;
   rows.push([(x*100).toFixed(1),(z*100).toFixed(1),((H(x,z)+dy)*100).toFixed(1),(-yaw*180/Math.PI).toFixed(1),sc.toFixed(3),g.name,g.layer,(top*sc).toFixed(2)].join(','));}}
 const meta={generator:'Fairway Atlas',exported:new Date().toISOString(),course:w.courseName||w.course?.name||null,hole:w.hole?.number??null,par:w.hole?.par??null,
  heightmap:{file:'heightmap.r16',resolution:N,spacing_m:s,min_m:lo,max_m:hi},
  landscape:{location_cm:[x0*100,z0*100,mid*100],scale:[s*100,s*100,scaleZ],note:'Unreal New Landscape > Import from File: heightmap.r16, then set this Location/Scale (the import script also enforces them).'},
  textures:{surfaces_a:'R fairway, G green, B tee',surfaces_b:'R bunker/sand, G water, B path/rock (rough = none)',origin_cm:[x0*100,z0*100],extent_cm:size*100},
  tee_cm:w.tee&&[w.tee.x*100,w.tee.z*100,H(w.tee.x,w.tee.z)*100],pin_cm:w.pin&&[w.pin.x*100,w.pin.z*100,H(w.pin.x,w.pin.z)*100],
  foliage:{file:'foliage.csv',count:rows.length-1},surfaceCounts:kinds};
 return{meta,files:{'heightmap.r16':new Blob([r16.buffer]),'surfaces_a.png':await png(N,A),'surfaces_b.png':await png(N,B),'foliage.csv':new Blob([rows.join('\n')],{type:'text/csv'}),'fairway_hole.json':new Blob([JSON.stringify(meta,null,1)],{type:'application/json'})}};
}
// Chrome/Edge: write straight into a folder the user picks (e.g. fairway-atlas-unreal/export). Elsewhere: downloads.
export async function saveExport({files,meta}){
 if(window.showDirectoryPicker){const dir=await window.showDirectoryPicker({id:'fairway-unreal',mode:'readwrite'});
  const sub=await dir.getDirectoryHandle(`hole-${meta.hole??'x'}`,{create:true});
  for(const [name,blob] of Object.entries(files)){const f=await sub.getFileHandle(name,{create:true}),wr=await f.createWritable();await wr.write(blob);await wr.close();}
  return `${dir.name}/hole-${meta.hole??'x'}`;}
 for(const [name,blob] of Object.entries(files)){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`hole-${meta.hole??'x'}-${name}`;a.click();await new Promise(r=>setTimeout(r,250));}
 return 'Downloads';}
