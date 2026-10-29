// A regional DEM is not a surveyed playing surface. Correct only greens, tees and fairways whose
// *typical* measured slope is implausibly steep, rather than blurring all terrain.
// Each corrected area gets a best-fit plane: its overall tilt is kept (and clamped for greens/
// tees), local relief around that plane is compressed. The correction holds at full strength
// for a 6 ft buffer beyond the boundary, then blends out over a collar so no cliff forms there.
const inside=(x,z,p)=>{let hit=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const a=p[i],b=p[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;};
const edgeDistance=(x,z,p)=>{let d=Infinity;for(let i=0,j=p.length-1;i<p.length;j=i++){const a=p[j],b=p[i],dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz||1)));d=Math.min(d,Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz));}return d;};
const median=a=>a.slice().sort((a,b)=>a-b)[Math.floor(a.length/2)];
export const BUFFER=1.83; // 6 ft at full correction outside the boundary
// trigger: median slope that marks the DEM as implausible; plane: max overall tilt kept;
// relief: max slope allowed for bumps around the plane; collar: blend distance after the buffer.
export const SURFACE_RULES={
 green:  {trigger:.07,plane:.02, relief:.025,collar:7},
 tee:    {trigger:.06,plane:.015,relief:.02, collar:7},
 fairway:{trigger:.2, plane:.2,  relief:.1,  collar:10},
};
export function greenTerrain(features,raw){
 const patches=[];
 for(const f of features.filter(f=>SURFACE_RULES[f.kind]&&f.closed)){
  const rule=SURFACE_RULES[f.kind],b=f.bounds,step=Math.max(.75,Math.sqrt((b.maxX-b.minX)*(b.maxZ-b.minZ)/1600)),S=[];
  for(let z=b.minZ+step*.5;z<b.maxZ;z+=step)for(let x=b.minX+step*.5;x<b.maxX;x+=step){if(!inside(x,z,f.points))continue;const h=raw(x,z),gx=(raw(x+.25,z)-raw(x-.25,z))/.5,gz=(raw(x,z+.25)-raw(x,z-.25))/.5;if(Number.isFinite(h)&&Number.isFinite(gx)&&Number.isFinite(gz))S.push({x,z,h,gx,gz});}
  if(S.length<9)continue;
  const typical=median(S.map(s=>Math.hypot(s.gx,s.gz)));if(typical<=rule.trigger)continue;
  // least-squares plane about the centroid
  const n=S.length,cx=S.reduce((a,s)=>a+s.x,0)/n,cz=S.reduce((a,s)=>a+s.z,0)/n,ch=median(S.map(s=>s.h));
  let sxx=0,szz=0,sxz=0,sxh=0,szh=0;for(const s of S){const dx=s.x-cx,dz=s.z-cz,dh=s.h-ch;sxx+=dx*dx;szz+=dz*dz;sxz+=dx*dz;sxh+=dx*dh;szh+=dz*dh}
  const det=sxx*szz-sxz*sxz||1;let pb=(sxh*szz-szh*sxz)/det,pc=(szh*sxx-sxh*sxz)/det;
  const g=Math.hypot(pb,pc),kb=g>rule.plane?rule.plane/g:1;
  const residual=Math.max(...S.map(s=>Math.hypot(s.gx-pb,s.gz-pc))),scale=Math.min(1,rule.relief/Math.max(1e-6,residual));
  patches.push({id:f.id,kind:f.kind,points:f.points,bounds:b,anchor:ch,cx,cz,pb,pc,tb:pb*kb,tc:pc*kb,scale,sourceSlope:typical,estimated:true,buffer:BUFFER,collar:rule.collar});
 }
 const elevation=(x,z)=>{const h=raw(x,z);let correction=0,total=0,strongest=0;
  for(const p of patches){const b=p.bounds,r=p.buffer+p.collar;if(x<b.minX-r||x>b.maxX+r||z<b.minZ-r||z>b.maxZ+r)continue;const d=inside(x,z,p.points)?0:edgeDistance(x,z,p.points);if(d>=r)continue;
   const t=Math.max(0,d-p.buffer)/p.collar,w=1-t*t*(3-2*t),dx=x-p.cx,dz=z-p.cz,plane=p.anchor+p.pb*dx+p.pc*dz,target=p.anchor+p.tb*dx+p.tc*dz+(h-plane)*p.scale;
   correction+=(target-h)*w;total+=w;strongest=Math.max(strongest,w);}
  return total?h+correction/total*strongest:h;};
 return {elevation,patches};
}
