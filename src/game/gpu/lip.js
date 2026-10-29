import {FRAME,COMMON} from './shaders-common.js';
import {triangulateShape} from '../core/geometry.js';
// Bunker lip: a real vertical soil wall along every bunker outline, from the turf surface down into the sunken sand.
export const LIP=FRAME+COMMON+/*wgsl*/`
@group(1) @binding(0) var soilTex:texture_2d<f32>;   // photo-derived tileable soil: rgb albedo (sRGB), a = height (dirt/textures/soil.png)
@group(1) @binding(1) var soilSamp:sampler;
struct VI{@location(0) a:vec4f,@location(1) b:vec2f}   // a: x,z,v(0 top/1 bottom),u (m along edge)   b: inward normal xz
struct VO{@builtin(position) pos:vec4f,@location(0) wp:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) top:f32}
@vertex fn vs(i:VI)->VO{var o:VO;let xz=i.a.xy;let g=groundH(xz);
 let topY=g;   /* flush with the turf hole edge */
 let botY=g-select(bunkerSink(xz+i.b*.013),.0508+.02,bunkerNew(xz));   /* new bunkers: 2 in to the sand edge (+2 cm tucked under it) */
 let y=mix(topY,botY,i.a.z);let p=vec3f(xz.x,y,xz.y);
 o.pos=F.viewProj*vec4f(p,1.);o.wp=p;o.n=normalize(vec3f(i.b.x,.12,i.b.y));o.uv=vec2f(i.a.w,(topY-y));o.top=topY;return o;}
@fragment fn fs(v:VO,@builtin(front_facing) ff:bool)->@location(0) vec4f{
 // one uniform layer of dark soil (photo lip faces sit at L* 18-26): no turf mat, roots or sand splash on the face
 let u=v.uv.x;let dz=v.uv.y;
 // real soil: albedo + height from a photographed dirt tile (3.75 cm repeat, de-tiled), lit through its own relief so clods and crumbs cast
 // their shading; calibrated to the photo lip faces (L* 11-23, low chroma) -> black-brown
 let T=.0375;let uv=vec2f(u,dz)/T;let px=1./1024.;
 // break up the repeat: a second read of the tile, rotated ~37 deg and scaled 1.37x, blended in by low-frequency noise
 let R=mat2x2f(.8,.6,-.6,.8);let uv2=R*uv*.73+vec2f(.37,.61);let wB=smoothstep(.35,.65,tn(vec2f(u,dz)*1.7).r);
 let sa=textureSample(soilTex,soilSamp,uv);let sb=textureSample(soilTex,soilSamp,uv2);
 let ha=vec2f(textureSample(soilTex,soilSamp,uv+vec2f(px,0.)).a,textureSample(soilTex,soilSamp,uv+vec2f(0.,px)).a)-sa.a;
 let hb=vec2f(textureSample(soilTex,soilSamp,uv2+R*vec2f(px,0.)).a,textureSample(soilTex,soilSamp,uv2+R*vec2f(0.,px)).a)-sb.a;
 let sm=mix(sa,sb,wB);let hx=mix(ha.x,hb.x,wB);let hy=mix(ha.y,hb.y,wB);
 let damp=.8+.35*tn(vec2f(u,dz)*.9+3.).g;   // patchy damp/dry variation over tens of cm
 let lin=pow(sm.rgb,vec3f(2.2));let alb=lin*vec3f(.335,.295,.255)*damp;
 let nw=normalize(vec3f(v.n.x,0.,v.n.z));let tg=vec3f(-nw.z,0.,nw.x);
 var n=normalize(nw-(tg*hx+vec3f(0.,-1.,0.)*hy)*2.);if(dot(n,F.camPos.xyz-v.wp)<0.){n=-n;}
 let cav=mix(.7,1.05,sm.a);   // crevices between clods stay dark
 let s=F.sunDir.xyz;let sh=objShadowFast(v.wp)*terrainShadowCached(v.wp)*cloudShadow(v.wp);
 let ndl=max(dot(n,s),0.);let sky=ambientSky(n);
 let bounce=vec3f(.85,.76,.6)*F.sunColor.rgb*max(F.sunDir.y,0.)*.3;   // light kicked up off the bright sand floor
 var S:LitSurf;S.p=v.wp;S.n=n;S.alb=alb*cav;S.rough=.95;S.f0=.025;S.canopy=0.;S.trans=0.;S.ao=groundAO(v.wp.xz).x*nearAO(v.wp);S.vis=sh*contactShadow(v.wp,n);
 let c=shade(S)+alb*cav*bounce*S.ao*mix(.25,1.,sh);   // lighting engine + light kicked up off the bright sand floor
 return vec4f(fogApply(c,v.wp),1.);}
`;
// Build the wall strip from bunker polygons (densified, inward normals).
// Inside the hole's detail mask the wall is traced along the exact zero line of the bunker signed-distance field (marching
// squares), so wall, soil band, grass edge and sand sink all share one edge. Elsewhere it falls back to the polygon.
// Edge sampling shared by the wall and the edge strip: bilinear SDF and its central-difference gradient are functions of the
// point only, so two marching-squares segments meeting at a point get the identical inward normal (watertight joins).
export const STRIP_MARGIN=.07;   // fraction of the detail box kept clear of the detail->global mask crossfade
function sdfSampler({box,N,sd,mpp}){const P=(i,j)=>sd[Math.min(N-1,Math.max(0,j))*N+Math.min(N-1,Math.max(0,i))];
 const S=(x,z)=>{const fx=(x-box.x)/mpp-.5,fz=(z-box.z)/mpp-.5,i=Math.floor(fx),j=Math.floor(fz),tx=fx-i,tz=fz-j;
  return (P(i,j)*(1-tx)+P(i+1,j)*tx)*(1-tz)+(P(i,j+1)*(1-tx)+P(i+1,j+1)*tx)*tz;};
 const h=mpp*1.5;const G=(x,z)=>{let gx=S(x+h,z)-S(x-h,z),gz=S(x,z+h)-S(x,z-h);const l=Math.hypot(gx,gz)||1;gx/=l;gz/=l;
  // a stray wrong-sign texel next to the edge can flip a short stencil: make sure +n really goes into the sand
  if(S(x+gx*.15,z+gz*.15)<S(x-gx*.15,z-gz*.15)){gx=-gx;gz=-gz;}return [gx,gz];};
 return {S,G};}
function sdfSegments(sdf,fn){const {box,N,sd,mpp}=sdf;const P=(i,j)=>sd[j*N+i];const {G}=sdfSampler(sdf);
 const m=box.size*STRIP_MARGIN,x0=box.x+m,z0=box.z+m,x1=box.x+box.size-m,z1=box.z+box.size-m;
 for(let j=0;j<N-1;j++)for(let i=0;i<N-1;i++){const a=P(i,j),b=P(i+1,j),c=P(i+1,j+1),d=P(i,j+1);
  if((a>0)===(b>0)&&(b>0)===(c>0)&&(c>0)===(d>0))continue;
  const pts=[];const edge=(xa,za,v0,xb,zb,v1)=>{if((v0>0)!==(v1>0)){const t=v0/(v0-v1);pts.push([xa+(xb-xa)*t,za+(zb-za)*t])}};
  edge(i,j,a,i+1,j,b);edge(i+1,j,b,i+1,j+1,c);edge(i+1,j+1,c,i,j+1,d);edge(i,j+1,d,i,j,a);
  for(let k=0;k+1<pts.length;k+=2){const p0=pts[k],p1=pts[k+1];
   const w0=[box.x+(p0[0]+.5)*mpp,box.z+(p0[1]+.5)*mpp],w1=[box.x+(p1[0]+.5)*mpp,box.z+(p1[1]+.5)*mpp];
   if(Math.hypot(w1[0]-w0[0],w1[1]-w0[1])<1e-5)continue;const mx=(w0[0]+w1[0])/2,mz=(w0[1]+w1[1])/2;if(mx<x0||mz<z0||mx>x1||mz>z1)continue;
   fn(w0,w1,G(w0[0],w0[1]),G(w1[0],w1[1]));}}}
function sdfWall(sdf,out){sdfSegments(sdf,(w0,w1,n0,n1)=>{const u0=w0[0]*.7+w0[1]*.7,u1=w1[0]*.7+w1[1]*.7;
 const V=(w,v,uu,n)=>out.push(w[0],w[1],v,uu,n[0],n[1]);
 V(w0,0,u0,n0);V(w1,0,u1,n1);V(w0,1,u0,n0);V(w0,1,u0,n0);V(w1,0,u1,n1);V(w1,1,u1,n1);});}
// Edge strip: turf and sand surfaces laid out in rows parallel to the exact edge (signed offsets s, metres, + = into the sand).
// The camera grid hides itself under this band, so the turf edge, the soil wall and the sand edge are one watertight seam.
export const STRIP_TURF=[-.55,-.4,-.25,-.12,-.05,0],STRIP_SAND=[0,.02,.1,.2,.28,.33,.38,.43,.48,.55,.62,.7];
export function edgeStrip(sdf){const P=[],Nn=[],U=[],C=[];if(!sdf)return null;const {S}=sdfSampler(sdf);
 // how far the rows may reach from this edge point before meeting the medial axis of a narrow neck / tongue (where the signed
 // distance stops growing): the rows are scaled to that room so they never cross into the other surface. Per point -> watertight.
 const room=(w,n,dir,max)=>{let s=.01;for(;s<max;s+=.01){if(dir*S(w[0]+n[0]*dir*s,w[1]+n[1]*dir*s)<s*.7)break;}return Math.min(max,Math.max(.02,s-.01));};
 const cache=new Map();const caps=(w,n)=>{const k=w[0].toFixed(4)+','+w[1].toFixed(4);let c=cache.get(k);if(!c){c=[room(w,n,-1,-STRIP_TURF[0]),room(w,n,1,STRIP_SAND[STRIP_SAND.length-1])];cache.set(k,c);}return c;};
 sdfSegments(sdf,(w0,w1,n0,n1)=>{const u0=w0[0]*.7+w0[1]*.7,u1=w1[0]*.7+w1[1]*.7;const c0=caps(w0,n0),c1=caps(w1,n1);
  const V=(w,n,c,s,uu,sand)=>{const sc=s<0?s/-STRIP_TURF[0]*c[0]:s/STRIP_SAND[STRIP_SAND.length-1]*c[1];const s2=sc;
   P.push(w[0]+n[0]*s2,sand?1:0,w[1]+n[1]*s2);Nn.push(n[0],0,n[1]);U.push(uu,s2);C.push(1,1,1,sand?-3:-2);};
  for(const [rows,sand] of [[STRIP_TURF,0],[STRIP_SAND,1]])for(let r=0;r+1<rows.length;r++){const a=rows[r],b=rows[r+1];
   // winding: same as the grid (cross(p1-p0,p2-p0).y > 0), so front_facing is true from above and the normal isn't flipped
   const ex=w1[0]-w0[0],ez=w1[1]-w0[1],cy=ez*n0[0]-ex*n0[1];
   if(cy>0){V(w0,n0,c0,a,u0,sand);V(w1,n1,c1,a,u1,sand);V(w0,n0,c0,b,u0,sand);V(w0,n0,c0,b,u0,sand);V(w1,n1,c1,a,u1,sand);V(w1,n1,c1,b,u1,sand);}
   else{V(w0,n0,c0,a,u0,sand);V(w0,n0,c0,b,u0,sand);V(w1,n1,c1,a,u1,sand);V(w0,n0,c0,b,u0,sand);V(w1,n1,c1,b,u1,sand);V(w1,n1,c1,a,u1,sand);}}});
 return {pos:new Float32Array(P),nrm:new Float32Array(Nn),uv:new Float32Array(U),col:new Float32Array(C),count:P.length/3};}
export function lipGeometry(world,sdf=null){const out=[];   // inside the detail box the new-engine ribbon (bunkerGeometry) replaces these walls
 const mB=sdf?sdf.box.size*STRIP_MARGIN:0;const inBox=(x,z)=>sdf&&x>sdf.box.x+mB&&z>sdf.box.z+mB&&x<sdf.box.x+sdf.box.size-mB&&z<sdf.box.z+sdf.box.size-mB;
 const inside=(pts,x,z)=>{let c=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const [xi,zi]=pts[i],[xj,zj]=pts[j];if((zi>z)!==(zj>z)&&x<(xj-xi)*(z-zi)/(zj-zi)+xi)c=!c;}return c;};
 for(const f of world.features.filter(f=>(f.kind==='bunker'||f.kind==='sand')&&f.closed)){
  // Chaikin-smooth each ring (2 passes) so the wall follows the same rounded line as the filtered mask instead of zig-zagging on raw OSM vertices
  const chaikin=r=>{let p=r;for(let it=0;it<2;it++){const q=[];for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length];q.push([a[0]*.75+b[0]*.25,a[1]*.75+b[1]*.25],[a[0]*.25+b[0]*.75,a[1]*.25+b[1]*.75]);}p=q;}return p;};
  const rings=[f.points,...(f.innerPoints||[])].map(chaikin);
  for(const ring of rings){if(ring.length<3)continue;let u=0;
   for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];const dx=b[0]-a[0],dz=b[1]-a[1],L=Math.hypot(dx,dz);if(L<1e-4)continue;
    let nx=-dz/L,nz=dx/L;const mx=(a[0]+b[0])/2,mz=(a[1]+b[1])/2;
    const inS=inside(f.points,mx+nx*.05,mz+nz*.05)&&!(f.innerPoints||[]).some(r=>inside(r,mx+nx*.05,mz+nz*.05));if(!inS){nx=-nx;nz=-nz;}
    if(inBox(mx,mz)){u+=L;continue;}
    const n=Math.max(1,Math.ceil(L/.15));
    for(let k=0;k<n;k++){const t0=k/n,t1=(k+1)/n;const x0=a[0]+dx*t0+nx*.02,z0=a[1]+dz*t0+nz*.02,x1=a[0]+dx*t1+nx*.02,z1=a[1]+dz*t1+nz*.02;const u0=u+L*t0,u1=u+L*t1;
     const V=(x,z,v,uu)=>out.push(x,z,v,uu,nx,nz);
     V(x0,z0,0,u0);V(x1,z1,0,u1);V(x0,z0,1,u0);V(x0,z0,1,u0);V(x1,z1,0,u1);V(x1,z1,1,u1);}
    u+=L;}}}
 return new Float32Array(out);}

// ============================================================================================================================
// Bunkers (new engine). Inside the hole's detail box every bunker is real geometry built from its OSM outline:
//  1. the terrain is one surface: turf and trap share the same elevation (no shader sink under the sand)
//  2-3. the OSM ring is smoothed (smoothRings, also used for the mask's signed distance so the hole in the turf matches)
//  4-5. the sand is a separate mesh: its edge sits exactly on the smoothed ring, 2 in (5 cm) below the turf, and it rounds
//       down into a bowl toward the middle
//  6. a 2 in ribbon of dirt closes the gap between the turf edge (top) and the sand edge (bottom)
// The turf discards itself inside the ring (shader: bunkerHole), so nothing sits over the sand.
export const BUNKER={lip:.0508,bowl:.28,round:1.6,seg:.3,tri:1.};
export function smoothRings(f){const ch=r=>{let q=r;for(let it=0;it<3;it++){const o=[];for(let i=0;i<q.length;i++){const a=q[i],b=q[(i+1)%q.length];o.push([a[0]*.75+b[0]*.25,a[1]*.75+b[1]*.25],[a[0]*.25+b[0]*.75,a[1]*.25+b[1]*.75]);}q=o;}return q;};
 return [f.points,...(f.innerPoints||[])].filter(r=>r&&r.length>2).map(ch);}
// resample a closed ring so no chord is longer than seg (same rule for sand edge and ribbon -> identical vertices)
function resample(r,seg){const o=[];for(let i=0;i<r.length;i++){const a=r[i],b=r[(i+1)%r.length],L=Math.hypot(b[0]-a[0],b[1]-a[1]),n=Math.max(1,Math.ceil(L/seg));for(let k=0;k<n;k++)o.push([a[0]+(b[0]-a[0])*k/n,a[1]+(b[1]-a[1])*k/n]);}return o;}
const area=r=>{let s=0;for(let i=0,j=r.length-1;i<r.length;j=i++)s+=(r[j][0]-r[i][0])*(r[j][1]+r[i][1]);return s/2;};
export function bunkersInBox(world,box,margin=.07){const m=box.size*margin,x0=box.x+m,z0=box.z+m,x1=box.x+box.size-m,z1=box.z+box.size-m;
 return world.features.filter(f=>(f.kind==='bunker'||f.kind==='sand')&&f.closed&&f.points.every(p=>p[0]>x0&&p[0]<x1&&p[1]>z0&&p[1]<z1));}
export function bunkerGeometry(world,box){const S=[],N=[],U=[],C=[],W=[];const B=BUNKER;
 for(const f of bunkersInBox(world,box)){const rings=smoothRings(f).map(r=>resample(r,B.seg));if(!rings.length)continue;
  // outer CCW, holes CW (in x/z) for the triangulator
  let [outer,...holes]=rings;if(area(outer)<0)outer=outer.slice().reverse();holes=holes.map(h=>area(h)>0?h.slice().reverse():h);
  const pts=[outer,...holes].flat();let tris;try{tris=triangulateShape(outer.map(p=>[p[0],p[1]]),holes.map(h=>h.map(p=>[p[0],p[1]])));}catch{continue}
  // refine: split any triangle edge longer than B.tri that is NOT on the ring (ring edges stay exactly the ribbon's chords)
  const V=pts.map(p=>[p[0],p[1]]),onRing=new Set();let base=0;for(const r of [outer,...holes]){for(let i=0;i<r.length;i++)onRing.add(Math.min(base+i,base+(i+1)%r.length)+','+Math.max(base+i,base+(i+1)%r.length));base+=r.length;}
  const mid=new Map(),M=(a,b)=>{const k=a<b?a+','+b:b+','+a;let i=mid.get(k);if(i==null){i=V.length;V.push([(V[a][0]+V[b][0])/2,(V[a][1]+V[b][1])/2]);mid.set(k,i);}return i;};
  const len=(a,b)=>Math.hypot(V[a][0]-V[b][0],V[a][1]-V[b][1]);let T=tris.map(t=>t.slice());
  for(let pass=0;pass<8;pass++){let any=false;const out=[];for(const [a,b,c] of T){const e=[[a,b],[b,c],[c,a]].map(([x,y])=>len(x,y));const k=e.indexOf(Math.max(...e));const [x,y]=[[a,b],[b,c],[c,a]][k];const z=[c,a,b][k];
    if(e[k]>B.tri&&!onRing.has(Math.min(x,y)+','+Math.max(x,y))){const m=M(x,y);out.push([x,m,z],[m,y,z]);any=true;}else out.push([a,b,c]);}T=out;if(!any)break;}
  // conform: a split interior edge must also be split in its neighbour (else T-junction cracks)
  for(let pass=0;pass<8;pass++){let any=false;const out=[];for(const t of T){let done=false;for(let k=0;k<3&&!done;k++){const x=t[k],y=t[(k+1)%3],z=t[(k+2)%3];const key=x<y?x+','+y:y+','+x;const m=mid.get(key);if(m!=null){out.push([x,m,z],[m,y,z]);done=true;any=true;}}if(!done)out.push(t);}T=out;if(!any)break;}
  // distance from each vertex to the ring (bowl profile) + direction into the bunker, via a bucket grid of ring segments
  const segs=[];for(const r of [outer,...holes])for(let i=0;i<r.length;i++)segs.push([r[i],r[(i+1)%r.length]]);const G=1,buck=new Map(),kb=(i,j)=>i+','+j;
  for(const sg of segs){const x0=Math.floor(Math.min(sg[0][0],sg[1][0])/G),x1=Math.floor(Math.max(sg[0][0],sg[1][0])/G),z0=Math.floor(Math.min(sg[0][1],sg[1][1])/G),z1=Math.floor(Math.max(sg[0][1],sg[1][1])/G);for(let i=x0;i<=x1;i++)for(let j=z0;j<=z1;j++){const k=kb(i,j);(buck.get(k)||buck.set(k,[]).get(k)).push(sg);}}
  const R=Math.ceil(B.round/G)+1;const dist=p=>{let best=B.round+1,dx=0,dz=0;const ci=Math.floor(p[0]/G),cj=Math.floor(p[1]/G);for(let i=ci-R;i<=ci+R;i++)for(let j=cj-R;j<=cj+R;j++){const L=buck.get(kb(i,j));if(!L)continue;for(const [a,b] of L){const ex=b[0]-a[0],ez=b[1]-a[1],l2=ex*ex+ez*ez||1e-12;let t=((p[0]-a[0])*ex+(p[1]-a[1])*ez)/l2;t=t<0?0:t>1?1:t;const qx=a[0]+ex*t,qz=a[1]+ez*t,d=Math.hypot(p[0]-qx,p[1]-qz);if(d<best){best=d;dx=p[0]-qx;dz=p[1]-qz;}}}const l=Math.hypot(dx,dz)||1;return [Math.min(best,B.round),dx/l,dz/l];};
  const D=V.map((p,i)=>i<pts.length?null:dist(p));{let o=0;for(const r of [outer,...holes]){const n=r.length;for(let i=0;i<n;i++){const a=r[(i+n-1)%n],b=r[(i+1)%n];let nx=-(b[1]-a[1]),nz=b[0]-a[0];const l=Math.hypot(nx,nz)||1;D[o+i]=[0,nx/l,nz/l];}o+=n;}}
  // ring vertices: inward direction = toward the sand (use neighbour points on the ring)
  for(const [a,b,c] of T){const ab=[V[b][0]-V[a][0],V[b][1]-V[a][1]],ac=[V[c][0]-V[a][0],V[c][1]-V[a][1]];const up=ab[1]*ac[0]-ab[0]*ac[1]<0;   // same winding as the ground grid
   for(const i of up?[a,b,c]:[a,c,b]){S.push(V[i][0],1,V[i][1]);N.push(D[i][1],0,D[i][2]);U.push(0,D[i][0]);C.push(1,1,1,-3);}}
  // ribbon: vertical dirt face on every ring chord (inward normal from the chord), top = turf edge, bottom = sand edge (+2 cm hidden)
  for(const r of [outer,...holes]){let arc=0;for(let i=0;i<r.length;i++){const a=r[i],b=r[(i+1)%r.length];const ex=b[0]-a[0],ez=b[1]-a[1],l=Math.hypot(ex,ez)||1;const nx=-ez/l,nz=ex/l;   // outer is CCW, holes CW: the left normal always points into the sand
    const u0=arc,u1=arc+l;arc=u1;const P=(q,v,u)=>W.push(q[0],q[1],v,u,nx,nz);   /* u = arc length (m): the soil texture keeps its scale on any edge direction */P(a,0,u0);P(b,0,u1);P(a,1,u0);P(a,1,u0);P(b,0,u1);P(b,1,u1);}}}
 return {sand:{pos:new Float32Array(S),nrm:new Float32Array(N),uv:new Float32Array(U),col:new Float32Array(C),count:S.length/3},ribbon:new Float32Array(W)};}
// CPU twin of the drawn sand: the very triangles bunkerGeometry builds, with each vertex's height evaluated as the MESH
// vertex shader does (ground under the vertex minus the lip/bowl drop at its distance from the ring), interpolated across the
// triangle exactly as the rasterizer interpolates it. Returns the absolute sand height at (x,z), or null outside the sand.
export function sandSurfaceFn(world,box,ground){const g=bunkerGeometry(world,box),P=g.sand.pos,U=g.sand.uv,n=g.sand.count;if(!n)return null;
 const B=BUNKER,H=new Float32Array(n);for(let i=0;i<n;i++){const x=Math.min(U[i*2+1]/B.round,1);H[i]=ground(P[i*3],P[i*3+2])-B.lip-B.bowl*(1-(1-x)*(1-x));}
 const G=1,buck=new Map(),kb=(i,j)=>i+','+j;
 for(let t=0;t<n;t+=3){const xs=[P[t*3],P[t*3+3],P[t*3+6]],zs=[P[t*3+2],P[t*3+5],P[t*3+8]];for(let i=Math.floor(Math.min(...xs)/G);i<=Math.floor(Math.max(...xs)/G);i++)for(let j=Math.floor(Math.min(...zs)/G);j<=Math.floor(Math.max(...zs)/G);j++){const k=kb(i,j);(buck.get(k)||buck.set(k,[]).get(k)).push(t);}}
 return (x,z)=>{const L=buck.get(kb(Math.floor(x/G),Math.floor(z/G)));if(!L)return null;
  for(const t of L){const ax=P[t*3],az=P[t*3+2],bx=P[t*3+3],bz=P[t*3+5],cx=P[t*3+6],cz=P[t*3+8];const d=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz);if(Math.abs(d)<1e-12)continue;
   const w1=((bz-cz)*(x-cx)+(cx-bx)*(z-cz))/d,w2=((cz-az)*(x-cx)+(ax-cx)*(z-cz))/d,w3=1-w1-w2;if(w1<-1e-6||w2<-1e-6||w3<-1e-6)continue;
   return H[t]*w1+H[t+1]*w2+H[t+2]*w3;}
  return null;};}
