// OSM coastlines run with land on their left. In east/south coordinates, water
// is on the mathematical left. Close clipped directed chains along the box's
// positive perimeter. This is an inferred ocean mask, never surveyed bathymetry.
export function coastalWater(features,center){
 const lines=features.filter(f=>f.kind==='coastline'&&!f.closed).map(f=>f.coords.map(p=>[p[0],-p[1]]));
 if(!lines.length||!center)return [];
 const dy=2200/111320,dx=dy/Math.cos(center.lat*Math.PI/180),box=[center.lon-dx,-center.lat-dy,center.lon+dx,-center.lat+dy];
 const same=(a,b)=>Math.abs(a[0]-b[0])<1e-8&&Math.abs(a[1]-b[1])<1e-8;
 // Preserve the source direction while joining contiguous ways.
 let changed=true;while(changed){changed=false;outer:for(let i=0;i<lines.length;i++)for(let j=0;j<lines.length;j++)if(i!==j&&same(lines[i].at(-1),lines[j][0])){lines[i].push(...lines[j].slice(1));lines.splice(j,1);changed=true;break outer}}
 const[x0,z0,x1,z1]=box,w=x1-x0,h=z1-z0,perimeter=2*(w+h),corners=[[x0,z0],[x1,z0],[x1,z1],[x0,z1]],cornerT=[0,w,w+h,2*w+h];
 function clip(a,b){let lo=0,hi=1;const dx=b[0]-a[0],dz=b[1]-a[1];for(const[p,q]of[[-dx,a[0]-x0],[dx,x1-a[0]],[-dz,a[1]-z0],[dz,z1-a[1]]]){if(Math.abs(p)<1e-14){if(q<0)return null}else{const t=q/p;if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);if(lo>hi)return null}}return [[a[0]+lo*dx,a[1]+lo*dz],[a[0]+hi*dx,a[1]+hi*dz]]}
 function boundaryT(p){const eps=1e-8;if(Math.abs(p[1]-z0)<eps)return p[0]-x0;if(Math.abs(p[0]-x1)<eps)return w+p[1]-z0;if(Math.abs(p[1]-z1)<eps)return w+h+x1-p[0];if(Math.abs(p[0]-x0)<eps)return 2*w+h+z1-p[1];return null}
 const parts=[];for(const line of lines){let part=[];for(let i=1;i<line.length;i++){const c=clip(line[i-1],line[i]);if(!c){if(part.length>1)parts.push(part);part=[];continue}if(part.length&&!same(part.at(-1),c[0])){if(part.length>1)parts.push(part);part=[]}if(!part.length)part.push(c[0]);part.push(c[1])}if(part.length>1)parts.push(part)}
 const out=[];for(const part of parts){const start=boundaryT(part[0]),end=boundaryT(part.at(-1));if(start===null||end===null||same(part[0],part.at(-1)))continue;const length=(start-end+perimeter)%perimeter,tail=cornerT.map((t,i)=>({delta:(t-end+perimeter)%perimeter,p:corners[i]})).filter(c=>c.delta>1e-10&&c.delta<length-1e-10).sort((a,b)=>a.delta-b.delta);const ring=[...part,...tail.map(c=>c.p),part[0]];out.push({id:'coast-water-'+out.length,kind:'water',closed:true,coords:ring.map(p=>[p[0],-p[1]]),source:'OpenStreetMap coastline direction',evidence:'inferred',tags:{natural:'water',water:'ocean'}})}return out;
}

// Coastline data often stops short of the loaded terrain square (snapshot or
// query bounds). The elevation model then reports the unmapped sea as a flat
// ~1 m plateau, which rendered as a straight strip of "land" poking through the
// ocean near the horizon. Flood the mapped ocean outward across unmapped cells
// whose elevation is at or below the ocean's own measured level (the model fills sea with that level or 0 m), and paint them as water in the
// surface map (terrain and ocean shaders both read it). Real shoreland rises
// above that level and is never flooded; mapped surfaces are never touched.
export function paintInferredSea(canvas,world,box,palette,inside){
 const coast=world.features.filter(f=>String(f.id).startsWith('coast-water')&&f.closed);if(!coast.length)return 0;
 const N=384,cell=box.size/N,small=document.createElement('canvas');small.width=small.height=N;const g=small.getContext('2d',{willReadFrequently:true});g.drawImage(canvas,0,0,N,N);const px=g.getImageData(0,0,N,N).data;
 const hex=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)),bg=hex(palette.rough),E=new Float32Array(N*N),state=new Uint8Array(N*N);// 1 unmapped, 2 sea
 const levels=[];
 for(let z=0;z<N;z++)for(let x=0;x<N;x++){const i=z*N+x,wx=box.x+(x+.5)*cell,wz=box.z+(z+.5)*cell,e=world.elevation(wx,wz);E[i]=Number.isFinite(e)?e:NaN;const r=px[i*4],gr=px[i*4+1],b=px[i*4+2];
  if(b>gr*1.06&&r<gr*.8&&coast.some(f=>inside(f,wx,wz))){state[i]=2;if(Number.isFinite(E[i]))levels.push(E[i]);}
  else if(Math.abs(r-bg[0])+Math.abs(gr-bg[1])+Math.abs(b-bg[2])<10)state[i]=1;}
 if(levels.length<16)return 0;levels.sort((a,b)=>a-b);const level=levels[levels.length>>1];
 const queue=[];for(let i=0;i<N*N;i++)if(state[i]===2)queue.push(i);let added=0;
 while(queue.length){const i=queue.pop(),x=i%N,z=(i/N)|0;for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,nz=z+dz;if(nx<0||nz<0||nx>=N||nz>=N)continue;const j=nz*N+nx;if(state[j]!==1||!(E[j]<=level+.03))continue;state[j]=3;added++;queue.push(j);}}
 if(!added)return 0;const ctx=canvas.getContext('2d'),s=canvas.width/N;ctx.fillStyle=palette.water;
 for(let i=0;i<N*N;i++)if(state[i]===3){const x=i%N,z=(i/N)|0;ctx.fillRect(x*s-.5,z*s-.5,s+1,s+1);}
 return added;
}
