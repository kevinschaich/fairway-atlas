// Fairway Atlas — native WebGPU flora (trees, shrubs, grasses) and fauna (birds).
// Procedural species are built once per locale into two LODs (near: perforated leaf cards; far: lumpy crown hulls),
// then scattered by placeFlora() around the hole with the play corridor kept clear. Rendered by FLORA (flora-shader.js).
import {pointIn,segmentDistance} from '../engine.js';
import {sampleCanopy} from '../canopy-data.js';

// ------------------------------------------------------------------ small math
const add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],mul=(a,s)=>[a[0]*s,a[1]*s,a[2]*s];
const len=a=>Math.hypot(a[0],a[1],a[2]),norm=a=>{const l=len(a)||1;return [a[0]/l,a[1]/l,a[2]/l]};
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const lerp=(a,b,t)=>a+(b-a)*t,mix3=(a,b,t)=>[lerp(a[0],b[0],t),lerp(a[1],b[1],t),lerp(a[2],b[2],t)];
const hex=h=>{const n=parseInt(h.slice(1),16);return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255].map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4)};
export function rng(seed){let a=seed>>>0;return()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const jit=(c,r,a)=>c.map(v=>v*(1+(r()-.5)*a));
const perp=t=>{const u=Math.abs(t[1])<.9?[0,1,0]:[1,0,0];const a=norm(cross(t,u));return [a,cross(t,a)]};

// Leaf-card types (encoded in uv.x as u + 2*type; the fragment shader cuts the silhouette):
// atlas tiles (foliage-atlas.js); each species draws its twig cards from one of these sets
export const LEAF={broad:[0,1],round:[2,3],needle:[4,5],scale:[6,7],azalea:[8,0,1],ceanothus:[9,6,7],gorse:[10,4],blossom:[11,2],sage:[12,13],palmate:[14,15],heather:[8,6,7]};

// ------------------------------------------------------------------ mesh builder (non-indexed, cull none)
class MB{
 constructor(){this.p=[];this.n=[];this.c=[];this.u=[];}
 v(p,n,c,sway,u){this.p.push(p[0],p[1],p[2]);this.n.push(n[0],n[1],n[2]);this.c.push(c[0],c[1],c[2],sway);this.u.push(u?u[0]:-1,u?u[1]:-1);}
 quad(a,b,c,d,na,nb,nc,nd,col,sw,uv){this.v(a,na,col,sw[0],uv&&[uv[0],0]);this.v(b,nb,col,sw[1],uv&&[uv[0]+1,0]);this.v(c,nc,col,sw[2],uv&&[uv[0]+1,1]);
  this.v(a,na,col,sw[0],uv&&[uv[0],0]);this.v(c,nc,col,sw[2],uv&&[uv[0]+1,1]);this.v(d,nd,col,sw[3],uv&&[uv[0],1]);}
 // tube along a polyline; radius per point, optional rib function (theta -> radius factor)
 tube(pts,radii,sides,colFn,swayFn,rib){const rings=[];let prevA=null;
  for(let i=0;i<pts.length;i++){const t=norm(sub(pts[Math.min(i+1,pts.length-1)],pts[Math.max(i-1,0)]));let [a,b]=perp(t);
   if(prevA){a=norm(sub(prevA,mul(t,prevA[0]*t[0]+prevA[1]*t[1]+prevA[2]*t[2])));b=cross(t,a);}prevA=a;
   const ring=[];for(let s=0;s<=sides;s++){const th=s/sides*Math.PI*2,rf=rib?rib(th):1,d=add(mul(a,Math.cos(th)),mul(b,Math.sin(th)));ring.push({p:add(pts[i],mul(d,radii[i]*rf)),n:d});}
   rings.push(ring);}
  for(let i=0;i<pts.length-1;i++)for(let s=0;s<sides;s++){const A=rings[i][s],B=rings[i][s+1],C=rings[i+1][s+1],D=rings[i+1][s];
   const c0=colFn(i/(pts.length-1),s/sides),c1=colFn((i+1)/(pts.length-1),s/sides);const s0=swayFn(pts[i]),s1=swayFn(pts[i+1]);
   this.v(A.p,A.n,c0,s0);this.v(B.p,B.n,c0,s0);this.v(C.p,C.n,c1,s1);this.v(A.p,A.n,c0,s0);this.v(C.p,C.n,c1,s1);this.v(D.p,D.n,c1,s1);}}
 // lumpy hull (icosphere, subdivided, noise-displaced), used for far crowns and inner crown fill
 hull(center,radii,subdiv,amp,colFn,swayFn,seed){const {v,f}=ico(subdiv);const r=rng(seed);const ph=[r()*9,r()*9,r()*9];
  const P=v.map(d=>{const nz=Math.sin(d[0]*3.1+ph[0])*Math.sin(d[1]*2.7+ph[1])*Math.sin(d[2]*3.3+ph[2])+.5*Math.sin(d[0]*7.3+d[2]*6.1+ph[1]);const k=1+amp*nz;
   return add(center,[d[0]*radii[0]*k,d[1]*radii[1]*k,d[2]*radii[2]*k]);});
  for(const [a,b,c] of f)for(const i of [a,b,c]){const d=v[i];this.v(P[i],d,colFn(d,P[i]),swayFn(P[i]));}}
 // a leaf card: square quad at p, facing roughly `face`, lit with `nrm` (crown-radial for soft foliage shading)
 card(p,out,nrm,size,roll,col,sway,tile){const t=norm(out);const [a0,b0]=perp(t);const side=add(mul(a0,Math.cos(roll)),mul(b0,Math.sin(roll)));const h=size*.5;
  const base=sub(p,mul(t,h)),tip=add(p,mul(t,h)),sd=mul(side,h);   // twig base (tile bottom) toward the branch, tip outward
  this.quad(sub(base,sd),add(base,sd),add(tip,sd),sub(tip,sd),nrm,nrm,nrm,nrm,col,[sway*.85,sway*.85,sway,sway],[tile*2,0]);}
 // flat tapered ribbon (grass blade, frond, spike). pts centre line, w widths, side vector per point
 ribbon(pts,widths,sides,colFn,swayFn,nrmFn){const B=[-1,-2];for(let i=0;i<pts.length-1;i++){const s0=mul(sides[i],widths[i]*.5),s1=mul(sides[i+1],widths[i+1]*.5);
  const a=sub(pts[i],s0),b=add(pts[i],s0),c=add(pts[i+1],s1),d=sub(pts[i+1],s1);const n0=nrmFn(i),n1=nrmFn(i+1);const c0=colFn(i/(pts.length-1)),c1=colFn((i+1)/(pts.length-1));
  this.v(a,n0,c0,swayFn(pts[i]),B);this.v(b,n0,c0,swayFn(pts[i]),B);this.v(c,n1,c1,swayFn(pts[i+1]),B);this.v(a,n0,c0,swayFn(pts[i]),B);this.v(c,n1,c1,swayFn(pts[i+1]),B);this.v(d,n1,c1,swayFn(pts[i+1]),B);}}
 finish(){return{pos:new Float32Array(this.p),nrm:new Float32Array(this.n),col:new Float32Array(this.c),uv:new Float32Array(this.u),count:this.p.length/3};}
}
const icoCache={};
function ico(sub){if(icoCache[sub])return icoCache[sub];const t=(1+Math.sqrt(5))/2;let v=[[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]].map(norm);
 let f=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
 for(let s=0;s<sub;s++){const mid=new Map(),m=(a,b)=>{const k=a<b?a+'_'+b:b+'_'+a;if(!mid.has(k)){v.push(norm(mul(add(v[a],v[b]),.5)));mid.set(k,v.length-1);}return mid.get(k)};
  const nf=[];for(const [a,b,c] of f){const ab=m(a,b),bc=m(b,c),ca=m(c,a);nf.push([a,ab,ca],[b,bc,ab],[c,ca,bc],[ab,bc,ca]);}f=nf;}
 return icoCache[sub]={v,f};}

// ------------------------------------------------------------------ species
// Every builder returns {near, far, h, r} in metres (h: nominal height, r: crown radius used for placement clearance).
function crownTree(seed,P){
 const r=rng(seed),near=new MB(),far=new MB();const h=lerp(P.h[0],P.h[1],r());const bark=hex(P.bark),leaf=hex(P.leaf),leaf2=hex(P.leaf2||P.leaf);
 const sway=p=>Math.pow(Math.max(p[1],0)/h,1.6)*P.flex;
 // trunk (optionally several stems)
 const stems=P.stems?Math.floor(lerp(P.stems[0],P.stems[1]+.99,r())):1;const tops=[];
 for(let s=0;s<stems;s++){const az=r()*6.283+s*2.1,lean=(stems>1?.35:.08)*(P.lean??1)+r()*.06;const th=h*lerp(P.trunk[0],P.trunk[1],r());const pts=[],rad=[];
  for(let i=0;i<=5;i++){const t=i/5;const off=lean*th*Math.pow(t,1.3);pts.push([Math.cos(az)*off+Math.sin(t*3+s)*.08,th*t,Math.sin(az)*off]);rad.push(P.tr*(stems>1?.7:1)*(1-t*.55)*(i===0?1.35:1));}
  const bc=(t,u)=>mul(bark,(.75+.3*Math.sin(u*37+t*11))*(P.barkTop&&t>.5?1:1));
  const bcol=P.barkTop?(t,u)=>mix3(bc(t,u),hex(P.barkTop),Math.max(0,t*1.6-.6)):bc;
  near.tube(pts,rad,7,bcol,sway);far.tube(pts,rad,5,bcol,sway);tops.push({p:pts[5],az,r:rad[5]});}
 // branches -> cluster centres
 const clusters=[];const crownC=[0,h*P.cc,0];
 for(const top of tops){const nb=Math.floor(lerp(P.branches[0],P.branches[1]+.99,r()));
  for(let b=0;b<nb;b++){const az=top.az+b/nb*6.283+r()*.8,el=lerp(P.elev[0],P.elev[1],r());const L=P.cr*lerp(.55,1.05,r());
   const dir=[Math.cos(az)*Math.cos(el),Math.sin(el),Math.sin(az)*Math.cos(el)];const start=add(top.p,[0,-r()*h*.08,0]);const mid=add(start,add(mul(dir,L*.5),[0,L*.12,0])),end=add(start,mul(dir,L));
   near.tube([start,mid,end],[top.r*.7,top.r*.45,top.r*.22],5,()=>mul(bark,.85),sway);far.tube([start,end],[top.r*.6,top.r*.2],3,()=>mul(bark,.85),sway);
   clusters.push({c:add(end,[0,P.cr*.12,0]),s:P.cr*lerp(.45,.7,r())*P.clusterScale});
   if(r()<.5)clusters.push({c:add(mid,[0,P.cr*.25,0]),s:P.cr*lerp(.35,.5,r())*P.clusterScale});}
  clusters.push({c:add(top.p,[0,P.cr*.35*P.squash,0]),s:P.cr*.6*P.clusterScale});}
 const leafCol=(pos,outer)=>{const y=Math.min(1,Math.max(0,pos[1]/h));const c=mix3(leaf,leaf2,r()*.6);return mul(c,(.68+.32*outer)*(.8+.3*y)*(.9+r()*.2));};
 for(const cl of clusters){const rad=[cl.s,cl.s*P.squash,cl.s];
  const n=Math.round(P.cards*1.8*cl.s*cl.s/(P.cr*P.cr*.35));
  for(let k=0;k<n;k++){const d=norm([r()*2-1,r()*2-1,r()*2-1]);const rr=Math.cbrt(.25+.75*r());const p=add(cl.c,[d[0]*rad[0]*rr,d[1]*rad[1]*rr,d[2]*rad[2]*rr]);
   const radial=norm(mix3(d,norm(sub(p,crownC)),.5));const outer=Math.min(1,rr*.8+Math.max(0,radial[1])*.3);
   const out=norm(add(d,[(r()-.5)*.6,.35+r()*.4,(r()-.5)*.6]));const tl=P.leafType[Math.floor(r()*P.leafType.length)];const col=leafCol(p,outer);
   near.card(p,out,radial,P.card*lerp(.8,1.2,r()),r()*6.28,col,sway(p)+.05,tl);
   if(k%5===0)far.card(p,out,radial,P.card*2.1*lerp(.85,1.15,r()),r()*6.28,col,sway(p)+.05,tl);}}
 return{near:near.finish(),far:far.finish(),h,r:P.cr*1.1};}

function conifer(seed,P){const r=rng(seed),near=new MB(),far=new MB();const h=lerp(P.h[0],P.h[1],r());const bark=hex(P.bark),leaf=hex(P.leaf),leaf2=hex(P.leaf2||P.leaf);
 const sway=p=>Math.pow(Math.max(p[1],0)/h,1.4)*P.flex;const base=h*P.bare;
 const trunk=[[0,0,0],[0,h*.5,0],[0,h,0]];near.tube(trunk,[P.tr,P.tr*.55,P.tr*.1],6,t=>mul(bark,.8+.2*t),sway);far.tube(trunk,[P.tr,P.tr*.5,.02],4,()=>bark,sway);
 const R=y=>P.cr*Math.pow(Math.max(0,1-(y-base)/(h-base)),P.shape)*(1+.12*Math.sin(y*2.3+seed));
 // near: whorls of drooping branches carrying needle sprays
 for(let y=base;y<h-.3;y+=P.whorl*lerp(.8,1.2,r())){const rr=R(y);const nb=Math.max(4,Math.round(rr*4.2));
  for(let b=0;b<nb;b++){const az=b/nb*6.283+r()*.7+y;const dir=[Math.cos(az),0,Math.sin(az)];const tip=add([0,y,0],add(mul(dir,rr),[0,-rr*P.droop+rr*.15,0]));const mid=add([0,y,0],add(mul(dir,rr*.5),[0,rr*.05,0]));
   near.tube([[0,y,0],mid,tip],[P.tr*.28*(1-y/h)+.015,.02,.008],3,()=>mul(bark,.7),sway);
   const nc=Math.max(3,Math.round(rr*P.density*1.6));for(let k=0;k<nc;k++){const t=.25+.75*(k+r()*.5)/nc;const p=add(mix3([0,y,0],tip,t),[(r()-.5)*.25,(r()-.3)*.2,(r()-.5)*.25]);
    const outer=.35+.65*t;const radial=norm(add(mul(dir,1),[0,.9,0]));const c=mul(mix3(leaf,leaf2,r()),(.68+.32*outer)*(.75+.35*y/h));
    const tiles=P.leafType??LEAF.needle;const tl=tiles[Math.floor(r()*tiles.length)];const out=norm(add(sub(tip,[0,y,0]),[(r()-.5)*rr*.6,rr*(.2+r()*.5),(r()-.5)*rr*.6]));
    near.card(p,out,radial,P.card*(.75+.5*t),r()*6.28,c,sway(p)+.04,tl);if(k%3===0)far.card(p,out,radial,P.card*1.9*(.75+.5*t),r()*6.28,c,sway(p)+.04,tl);}}}
 // top spire
 for(let k=0;k<8;k++){const p=[(r()-.5)*.3,h-.4+r()*.5,(r()-.5)*.3];const tiles=P.leafType??LEAF.needle;near.card(p,[r()-.5,1,r()-.5],[0,1,0],P.card*.7,r()*6.28,mul(leaf,.9),sway(p),tiles[k%tiles.length]);}
 return{near:near.finish(),far:far.finish(),h,r:P.cr};}

function palm(seed,P){const r=rng(seed),near=new MB(),far=new MB();const h=lerp(P.h[0],P.h[1],r());const bark=hex(P.bark),leaf=hex(P.leaf),leaf2=hex(P.leaf2);
 const az=r()*6.28,bend=lerp(.08,.2,r())*h;const sway=p=>Math.pow(Math.max(p[1],0)/h,1.5)*P.flex;const pts=[],rad=[];
 for(let i=0;i<=8;i++){const t=i/8;pts.push([Math.cos(az)*bend*t*t,h*t,Math.sin(az)*bend*t*t]);rad.push(P.tr*(1.25-t*.35)*(i===0?1.3:1));}
 const ringCol=(t,u)=>mul(bark,.75+.3*Math.abs(Math.sin(t*h*9)));near.tube(pts,rad,8,ringCol,sway);far.tube(pts,rad,5,ringCol,sway);const top=pts[8];
 const nf=Math.floor(lerp(P.fronds[0],P.fronds[1],r()));
 for(let f=0;f<nf;f++){const fa=f/nf*6.283+r()*.4,up=lerp(-.25,.55,(f%3)/2)+r()*.15;const L=lerp(P.fl*.8,P.fl*1.1,r());const dir=[Math.cos(fa),0,Math.sin(fa)];
  const cp=[],N=14;for(let i=0;i<=N;i++){const t=i/N;const lift=Math.sin(up)*t*L-.7*L*t*t*(1-Math.max(0,up)*.5);cp.push(add(top,add(mul(dir,Math.cos(up*.5)*t*L),[0,lift,0])));}
  const side=perp(norm(sub(cp[N],cp[0])))[0];const s2=norm(cross(dir,[0,1,0]));
  // rachis
  near.tube(cp,cp.map((_,i)=>.035*(1-i/N)+.005),3,()=>mul(leaf2,.7),sway);
  // leaflets: pinnate (feather palm) or fan
  for(let i=1;i<N;i++)for(let q=0;q<3;q++){const t=(i+q/3)/N;for(const sgn of [-1,1]){const base=mix3(cp[i],cp[i+1],q/3);const lL=P.leaflet*Math.pow(Math.sin(Math.min(1,t*1.1)*Math.PI),.6)*(.8+r()*.4);const tip=add(base,add(mul(s2,sgn*lL),[0,-lL*.55,0]));
   const midp=mix3(base,tip,.5);const n=norm(cross(sub(tip,base),sub(cp[i+1],cp[i-1])));const c=mul(mix3(leaf,leaf2,t),.7+.3*r());
   near.ribbon([base,midp,tip],[.07,.075,.008],[sub(cp[i+1],cp[i]),sub(cp[i+1],cp[i]),sub(cp[i+1],cp[i])].map(v=>norm(v)),()=>c,sway,()=>n[1]<0?mul(n,-1):n);}}
  far.ribbon(cp,cp.map((_,i)=>P.leaflet*1.6*Math.sin(i/N*Math.PI)+.05),cp.map(()=>s2),t=>mul(mix3(leaf,leaf2,t),.8),sway,()=>[0,1,0]);}
 // coconuts / dead frond skirt
 for(let k=0;k<5;k++)near.hull(add(top,[(r()-.5)*.5,-.3-r()*.3,(r()-.5)*.5]),[.13,.15,.13],1,.1,()=>hex('#4a3a1c'),sway,seed+k);
 return{near:near.finish(),far:far.finish(),h,r:P.fl*.9};}

function saguaro(seed,P){const r=rng(seed),near=new MB(),far=new MB();const h=lerp(P.h[0],P.h[1],r());const skin=hex(P.leaf);const rib=th=>1+.09*Math.cos(th*12);
 const col=(t,u)=>mul(skin,(.75+.25*Math.cos(u*6.283*12))*(.85+.2*t));const sway=()=>0;const body=[],br=[];
 for(let i=0;i<=8;i++){const t=i/8;body.push([0,h*t,0]);br.push(P.tr*(i===8?.55:i===7?.9:1));}body.push([0,h+.05,0]);br.push(.05);
 near.tube(body,br,14,col,sway,rib);far.tube(body,br,8,col,sway);
 const arms=Math.floor(r()*(P.arms+1));for(let a=0;a<arms;a++){const az=r()*6.28,y0=h*lerp(.35,.6,r()),out=lerp(.5,.8,r()),up=h*lerp(.2,.4,r());const d=[Math.cos(az),0,Math.sin(az)];
  const pts=[[0,y0,0],add([0,y0+.05,0],mul(d,out*.6)),add([0,y0+.35,0],mul(d,out)),add([0,y0+up*.6,0],mul(d,out)),add([0,y0+up,0],mul(d,out)),add([0,y0+up+.05,0],mul(d,out))];
  const rr=[P.tr*.7,P.tr*.68,P.tr*.66,P.tr*.66,P.tr*.5,.04];near.tube(pts,rr,12,col,sway,rib);far.tube(pts,rr,6,col,sway);}
 return{near:near.finish(),far:far.finish(),h,r:1.2};}

function spikyTree(seed,P){// joshua tree / dragon-ish: forking limbs with spiky rosettes
 const r=rng(seed),near=new MB(),far=new MB();const h=lerp(P.h[0],P.h[1],r());const bark=hex(P.bark),leaf=hex(P.leaf);const sway=p=>Math.max(0,p[1]/h)*P.flex;
 const grow=(p,dir,L,rad,depth)=>{const end=add(p,mul(dir,L));const mid=add(mix3(p,end,.5),[(r()-.5)*.2,0,(r()-.5)*.2]);near.tube([p,mid,end],[rad,rad*.85,rad*.7],6,()=>mul(bark,.8+.3*r()),sway);far.tube([p,end],[rad,rad*.7],4,()=>bark,sway);
  if(depth<=0){rosette(near,end,P.spike,26,leaf,sway,r);rosette(far,end,P.spike,10,leaf,sway,r);return;}
  const n=2+(r()<.3?1:0);for(let i=0;i<n;i++){const az=r()*6.28;grow(end,norm([Math.cos(az)*.8,.8+r()*.5,Math.sin(az)*.8]),L*lerp(.55,.8,r()),rad*.7,depth-1);}};
 grow([0,0,0],[0,1,0],h*.42,P.tr,P.depth);return{near:near.finish(),far:far.finish(),h,r:h*.45};}
function rosette(mb,c,L,n,col,sway,r){for(let i=0;i<n;i++){const d=norm([r()*2-1,r()*1.6-.4,r()*2-1]);const tip=add(c,mul(d,L*(.7+.5*r())));const s=perp(d)[0];
 const cc=mul(col,.6+.5*r());mb.v(add(c,mul(s,.04)),norm(add(d,[0,.5,0])),cc,sway(c));mb.v(sub(c,mul(s,.04)),norm(add(d,[0,.5,0])),cc,sway(c));mb.v(tip,d,mul(cc,1.2),sway(tip));}}

function tuft(seed,P){// grasses: arcing blades, optional seed heads
 const r=rng(seed),near=new MB(),far=new MB();const h=lerp(P.h[0],P.h[1],r());const base=hex(P.leaf),tip=hex(P.tip||P.leaf);
 for(const [mb,count,segs] of [[near,P.blades,4],[far,Math.ceil(P.blades/3),2]])for(let b=0;b<count;b++){const az=r()*6.283,lean=lerp(.1,P.spread,r()),L=h*lerp(.55,1.05,r());const d=[Math.cos(az),0,Math.sin(az)];
  const o=[(r()-.5)*P.w,0,(r()-.5)*P.w];const pts=[],wd=[],sd=[];const side=norm(cross(d,[0,1,0]));
  for(let i=0;i<=segs;i++){const t=i/segs;pts.push(add(o,add(mul(d,Math.sin(lean)*L*t*t*1.2),[0,L*t*(1-lean*t*.45),0])));wd.push(P.bw*(1-t*.85)*(mb===far?2:1));sd.push(side);}
  const c=mix3(base,tip,r()*.3);mb.ribbon(pts,wd,sd,t=>mul(mix3(c,tip,t*t),.55+.5*t),p=>Math.pow(p[1]/h,1.2)*P.flex,()=>norm(add(d,[0,1.5,0])));
  if(P.heads&&mb===near&&r()<P.heads){const top=pts[segs];near.ribbon([top,add(top,[d[0]*.05,.14,d[2]*.05])],[.035,.01],[side,side],()=>hex(P.headCol||'#b5a06a'),()=>P.flex,()=>[0,1,0]);}}
 return{near:near.finish(),far:far.finish(),h,r:.5};}

function rosettePlant(seed,P){// agave / yucca: thick fleshy spikes
 const r=rng(seed),near=new MB(),far=new MB();const h=lerp(P.h[0],P.h[1],r());const leaf=hex(P.leaf),tip=hex(P.tip||P.leaf);
 for(const [mb,count] of [[near,P.blades],[far,Math.ceil(P.blades/2)]])for(let i=0;i<count;i++){const az=i*2.39996+r()*.3;const up=lerp(.25,1.35,(i%7)/6);const L=h*lerp(.7,1.1,r())*(1-up*.15);
  const d=[Math.cos(az)*Math.cos(up),Math.sin(up),Math.sin(az)*Math.cos(up)];const side=norm(cross(d,[0,1,0]));const pts=[[0,.02,0],mul(d,L*.5),add(mul(d,L),[0,-L*.08*(1-up),0])];
  mb.ribbon(pts,[P.bw,P.bw*.8,.01],[side,side,side],t=>mul(mix3(leaf,tip,t*t),.65+.4*t),()=>0,()=>norm(add(cross(side,d),[0,.3,0])));}
 return{near:near.finish(),far:far.finish(),h,r:h*.8};}

function bush(seed,P){// low crowns of cards (shrubs, heather, gorse, sage)
 const r=rng(seed),near=new MB(),far=new MB();const h=lerp(P.h[0],P.h[1],r());const leaf=hex(P.leaf),leaf2=hex(P.leaf2||P.leaf);const W=h*P.wide;
 const sway=p=>Math.max(0,p[1]/h)*P.flex;const lobes=Math.floor(lerp(P.lobes[0],P.lobes[1]+.99,r()));const C=[0,h*.5,0];
 for(let l=0;l<lobes;l++){const a=r()*6.28,dd=W*.35*r();const c=[Math.cos(a)*dd,h*lerp(.4,.6,r()),Math.sin(a)*dd];const s=[W*lerp(.4,.6,r()),h*.5,W*lerp(.4,.6,r())];
  const n=Math.round(P.cards*2.2*s[0]*s[2]/(W*W*.2));for(let k=0;k<n;k++){const d=norm([r()*2-1,r()*1.6-.4,r()*2-1]);const rr=Math.cbrt(.3+.7*r());const p=[c[0]+d[0]*s[0]*rr,Math.max(.05,c[1]+d[1]*s[1]*rr),c[2]+d[2]*s[2]*rr];
   const radial=norm(mix3(d,norm(sub(p,C)),.5));const out=norm(add(d,[(r()-.5)*.5,.45+r()*.4,(r()-.5)*.5]));const tl=P.leafType[Math.floor(r()*P.leafType.length)];const col=mul(mix3(leaf,leaf2,r()),(.68+.32*rr)*(.8+.3*p[1]/h));
   near.card(p,out,radial,P.card*lerp(.8,1.2,r()),r()*6.28,col,sway(p),tl);if(k%4===0)far.card(p,out,radial,P.card*2*lerp(.85,1.15,r()),r()*6.28,col,sway(p),tl);}}
 if(P.stems){const bark=hex(P.bark||'#4b3b2a');for(let s=0;s<P.stems;s++){const a=r()*6.28;near.tube([[0,0,0],[Math.cos(a)*W*.15,h*.4,Math.sin(a)*W*.15]],[.05,.025],4,()=>bark,sway);}}
 return{near:near.finish(),far:far.finish(),h,r:W*.6};}

function fern(seed,P){const r=rng(seed),near=new MB(),far=new MB();const h=lerp(P.h[0],P.h[1],r());const leaf=hex(P.leaf),leaf2=hex(P.leaf2||P.leaf);
 for(const [mb,nf,ls] of [[near,P.fronds,1],[far,Math.ceil(P.fronds/2),0]])for(let f=0;f<nf;f++){const az=f/nf*6.283+r()*.5,up=lerp(.6,1.1,r()),L=h*lerp(1,1.5,r());const d=[Math.cos(az),0,Math.sin(az)];const N=6,cp=[];
  for(let i=0;i<=N;i++){const t=i/N;cp.push(add(mul(d,Math.cos(up*.6)*t*L),[0,Math.sin(up)*t*L*.9-t*t*L*.55,0]));}const s2=norm(cross(d,[0,1,0]));
  if(ls)for(let i=1;i<N;i++){const t=i/N;for(const sg of [-1,1]){const b=cp[i],lL=P.leaflet*Math.sin(t*Math.PI+.3);const tip=add(b,add(mul(s2,sg*lL),[0,-lL*.2,0]));const dv=norm(sub(cp[i+1],cp[i]));
   mb.ribbon([b,mix3(b,tip,.5),tip],[.07,.06,.01],[dv,dv,dv],()=>mul(mix3(leaf,leaf2,t),.6+.3*r()),p=>p[1]/h*P.flex,()=>[0,1,0]);}}
  else mb.ribbon(cp,cp.map((_,i)=>P.leaflet*1.6*Math.sin(i/N*Math.PI)+.04),cp.map(()=>s2),t=>mul(leaf,.7),p=>p[1]/h*P.flex,()=>[0,1,0]);}
 return{near:near.finish(),far:far.finish(),h,r:h};}

// fauna: a bird with flapping wings (uv.x encodes signed span position for the flap in the vertex shader)
function bird(P){const mb=new MB();const body=hex(P.body),wing=hex(P.wing),tipc=hex(P.tip||P.wing);const S=P.span*.5;
 const B=[[0,0,-.28*P.len],[0,.02,0],[0,0,.22*P.len],[0,-.01,.34*P.len]];mb.tube(B,[.02,.07*P.len,.05*P.len,.01],5,()=>body,()=>0);
 for(const sg of [-1,1]){const root0=[0,0,-.06],root1=[0,0,.1],mid0=[sg*S*.5,0,-.02],mid1=[sg*S*.5,0,.13],tip=[sg*S,0,.18];
  const up=[0,1,0];const u=a=>[Math.abs(a[0])/S,-1];
  mb.v(root0,up,wing,0,u(root0));mb.v(root1,up,wing,0,u(root1));mb.v(mid1,up,wing,0,u(mid1));mb.v(root0,up,wing,0,u(root0));mb.v(mid1,up,wing,0,u(mid1));mb.v(mid0,up,wing,0,u(mid0));
  mb.v(mid0,up,wing,0,u(mid0));mb.v(mid1,up,wing,0,u(mid1));mb.v(tip,up,tipc,0,u(tip));}
 // tail
 mb.v([0,0,.3*P.len],[0,1,0],body,0);mb.v([-.07,0,.45*P.len],[0,1,0],body,0);mb.v([.07,0,.45*P.len],[0,1,0],body,0);
 return mb.finish();}

// ------------------------------------------------------------------ locales
const SP={
 oak:s=>crownTree(s,{h:[10,15],trunk:[.3,.42],tr:.38,branches:[4,6],elev:[.25,.75],cr:5.2,cc:.62,squash:.72,clusterScale:1,cards:190,card:1.05,leaf:'#3f5a24',leaf2:'#58702c',bark:'#4a3f33',flex:.6,leafType:LEAF.broad}),
 liveOak:s=>crownTree(s,{h:[9,13],trunk:[.34,.44],tr:.42,stems:[1,2],lean:1.4,branches:[5,7],elev:[.15,.5],cr:6,cc:.62,squash:.55,clusterScale:.72,cards:200,card:.9,leaf:'#2c4219',leaf2:'#3d5323',bark:'#3e362d',flex:.45,leafType:LEAF.broad}),
 maple:s=>crownTree(s,{h:[11,16],trunk:[.35,.45],tr:.33,branches:[4,6],elev:[.5,1.1],cr:4.6,cc:.66,squash:.95,clusterScale:1,cards:200,card:1.1,leaf:'#41621f',leaf2:'#6b7a2a',bark:'#50473d',flex:.7,leafType:LEAF.palmate}),
 birch:s=>crownTree(s,{h:[11,17],trunk:[.55,.7],tr:.17,branches:[5,7],elev:[.7,1.25],cr:2.6,cc:.72,squash:1.3,clusterScale:.9,cards:120,card:.7,leaf:'#5c7a2c',leaf2:'#8a9a3a',bark:'#d8d4c8',flex:1.1,leafType:LEAF.round}),
 aspen:s=>crownTree(s,{h:[10,16],trunk:[.55,.7],tr:.16,branches:[4,6],elev:[.8,1.3],cr:2.3,cc:.74,squash:1.4,clusterScale:.9,cards:110,card:.65,leaf:'#6d8a2e',leaf2:'#a6a23a',bark:'#cfcbbf',flex:1.2,leafType:LEAF.round}),
 cypress:s=>crownTree(s,{h:[8,13],trunk:[.35,.5],tr:.4,stems:[1,3],lean:2.2,branches:[3,5],elev:[.05,.35],cr:5.5,cc:.72,squash:.38,clusterScale:1.05,cards:210,card:1.1,leaf:'#233a1f',leaf2:'#31472a',bark:'#4a3b30',flex:.35,leafType:LEAF.scale}),
 stonePine:s=>crownTree(s,{h:[12,18],trunk:[.6,.7],tr:.36,stems:[1,2],lean:.8,branches:[5,7],elev:[.25,.6],cr:5.8,cc:.83,squash:.5,clusterScale:1,cards:180,card:1.1,leaf:'#2d4a22',leaf2:'#415f2a',bark:'#5a3d2a',barkTop:'#8a5534',flex:.4,leafType:LEAF.needle}),
 scotsPine:s=>crownTree(s,{h:[13,20],trunk:[.62,.75],tr:.3,branches:[4,6],elev:[.2,.75],cr:3.8,cc:.82,squash:.55,clusterScale:.95,cards:150,card:1.0,leaf:'#2b4524',leaf2:'#3e5a2d',bark:'#4d3a2c',barkTop:'#a0613a',flex:.5,leafType:LEAF.needle}),
 almond:s=>crownTree(s,{h:[7,11],trunk:[.35,.5],tr:.3,branches:[5,7],elev:[.0,.3],cr:5,cc:.7,squash:.4,clusterScale:1,cards:170,card:1.3,leaf:'#3c6a22',leaf2:'#7a8a2a',bark:'#5a4c3e',flex:.55,leafType:LEAF.broad}),
 paloVerde:s=>crownTree(s,{h:[5,8],trunk:[.18,.3],tr:.18,stems:[2,3],lean:1.8,branches:[4,6],elev:[.3,.8],cr:3.2,cc:.6,squash:.6,clusterScale:.8,cards:70,card:.8,leaf:'#8a9a4a',leaf2:'#b4b25a',bark:'#7d9a52',flex:.7,leafType:LEAF.scale}),
 spruce:s=>conifer(s,{h:[15,24],bare:.12,tr:.32,cr:3.2,shape:.95,whorl:.55,droop:.35,density:5,card:.8,leaf:'#1f3524',leaf2:'#2c4632',bark:'#4a3a30',flex:.4}),
 fir:s=>conifer(s,{h:[12,19],bare:.08,tr:.28,cr:2.4,shape:1.05,whorl:.5,droop:.18,density:5.5,card:.7,leaf:'#243d23',leaf2:'#35532c',bark:'#50463c',flex:.45}),
 juniper:s=>conifer(s,{h:[3,5],bare:.05,tr:.14,cr:1.4,shape:.7,whorl:.35,droop:.05,density:7,card:.55,leaf:'#3d4f34',leaf2:'#556446',bark:'#5c4a3a',flex:.3,leafType:LEAF.scale}),
 palm:s=>palm(s,{h:[8,14],tr:.24,fronds:[16,20],fl:4.6,leaflet:1.05,bark:'#8a7a60',leaf:'#4d7a26',leaf2:'#8a8a3a',flex:.8}),
 saguaro:s=>saguaro(s,{h:[5,11],tr:.3,arms:3,leaf:'#7a8a58'}),
 joshua:s=>spikyTree(s,{h:[5,8],tr:.22,depth:2,spike:.45,bark:'#5e5446',leaf:'#6a7a3a',flex:.2}),
 seaGrapeTree:s=>crownTree(s,{h:[4,6],trunk:[.2,.3],tr:.16,stems:[2,4],lean:2,branches:[3,5],elev:[.2,.7],cr:2.6,cc:.6,squash:.7,clusterScale:1,cards:90,card:1.3,leaf:'#4d7a2c',leaf2:'#7a7a2c',bark:'#6a5a48',flex:.5,leafType:LEAF.round}),
 // shrubs
 shrub:s=>bush(s,{h:[1.1,2.2],wide:1.4,lobes:[3,5],cards:55,card:.55,leaf:'#3b5626',leaf2:'#566f2e',flex:.5,leafType:LEAF.broad}),
 coastalSage:s=>bush(s,{h:[.7,1.4],wide:1.6,lobes:[3,5],cards:55,card:.45,leaf:'#56663f',leaf2:'#707a52',flex:.6,leafType:LEAF.sage}),
 ceanothus:s=>bush(s,{h:[1,2],wide:1.5,lobes:[3,5],cards:60,card:.5,leaf:'#304a22',leaf2:'#3f5a2a',flex:.5,leafType:LEAF.ceanothus}),
 azalea:s=>bush(s,{h:[.9,1.7],wide:1.4,lobes:[3,4],cards:60,card:.5,leaf:'#355425',leaf2:'#44622c',flex:.5,leafType:LEAF.azalea}),
 gorse:s=>bush(s,{h:[1,1.8],wide:1.5,lobes:[3,6],cards:60,card:.5,leaf:'#2c3f1e',leaf2:'#3a4d24',flex:.4,leafType:LEAF.gorse}),
 heather:s=>bush(s,{h:[.35,.6],wide:2.4,lobes:[2,4],cards:45,card:.35,leaf:'#4a4a30',leaf2:'#5a5436',flex:.4,leafType:LEAF.heather}),
 creosote:s=>bush(s,{h:[1,2],wide:1.3,lobes:[3,5],cards:35,card:.4,leaf:'#5e6a3a',leaf2:'#7c7e48',flex:.6,leafType:LEAF.scale,stems:5,bark:'#5a4a3a'}),
 seaGrape:s=>bush(s,{h:[1.2,2.2],wide:1.5,lobes:[3,5],cards:45,card:.75,leaf:'#4e7a2e',leaf2:'#8a8a34',flex:.5,leafType:LEAF.round}),
 fernBrake:s=>fern(s,{h:[.5,.9],fronds:9,leaflet:.28,leaf:'#4a6a26',leaf2:'#6a7e2e',flex:.8}),
 agave:s=>rosettePlant(s,{h:[.7,1.2],blades:22,bw:.14,leaf:'#6a8078',tip:'#8a8a6a'}),
 yucca:s=>rosettePlant(s,{h:[.8,1.3],blades:34,bw:.06,leaf:'#5a6e40',tip:'#a09a60'}),
 // grasses
 tussock:s=>tuft(s,{h:[.45,.8],blades:50,spread:.9,w:.45,bw:.035,leaf:'#4e6526',tip:'#9a9a54',flex:1,heads:.1}),
 fescue:s=>tuft(s,{h:[.55,.95],blades:56,spread:.8,w:.55,bw:.025,leaf:'#6b7a38',tip:'#b8a86a',flex:1.1,heads:.35,headCol:'#b8a270'}),
 marram:s=>tuft(s,{h:[.8,1.3],blades:56,spread:.55,w:.5,bw:.02,leaf:'#7d8a58',tip:'#c7bd8a',flex:1.1}),
 desertGrass:s=>tuft(s,{h:[.35,.6],blades:30,spread:1,w:.2,bw:.02,leaf:'#9a8a5a',tip:'#d0c08a',flex:1,heads:.3,headCol:'#d8c898'}),
 alpineGrass:s=>tuft(s,{h:[.3,.5],blades:30,spread:.9,w:.15,bw:.03,leaf:'#5a6a2c',tip:'#a8a060',flex:.9}),
};
// weights: [species, weight]; tree/shrub/grass densities are per 100 m² of eligible rough; cluster: noise scale of groves (m)
export const LOCALES={
 oceanside:{fescue:0.7,label:'Oceanside (Monterey)',trees:[['cypress',.45],['stonePine',.3],['liveOak',.25]],shrubs:[['coastalSage',.45],['ceanothus',.25],['shrub',.3]],grass:[['fescue',.6],['marram',.4]],
  density:{tree:.5,shrub:1.1,grass:5},cluster:70,birds:[{body:'#e8e6e0',wing:'#b8bcc0',tip:'#2a2a2a',span:1.35,len:.6,flap:3.2,count:[5,9],alt:[18,55],speed:9,glide:.7}]},
 parkland:{fescue:0.35,label:'Parkland forest',trees:[['oak',.3],['maple',.25],['scotsPine',.2],['birch',.25]],shrubs:[['shrub',.5],['azalea',.25],['fernBrake',.25]],grass:[['tussock',.7],['fescue',.3]],
  density:{tree:1.1,shrub:.9,grass:2.5},cluster:90,birds:[{body:'#1a1a1c',wing:'#141416',span:.9,len:.45,flap:5,count:[4,8],alt:[12,35],speed:10,glide:.3}]},
 desert:{fescue:0.5,label:'Desert',trees:[['saguaro',.45],['paloVerde',.35],['joshua',.2]],shrubs:[['creosote',.55],['agave',.25],['yucca',.2]],grass:[['desertGrass',1]],
  density:{tree:.22,shrub:1.1,grass:2},cluster:0,birds:[{body:'#5a4030',wing:'#6a4a34',tip:'#2a2018',span:1.4,len:.55,flap:2.2,count:[1,3],alt:[40,90],speed:7,glide:.9}]},
 mountain:{fescue:0.45,label:'Mountain',trees:[['spruce',.45],['fir',.3],['aspen',.25]],shrubs:[['juniper',.5],['shrub',.3],['fernBrake',.2]],grass:[['alpineGrass',.7],['tussock',.3]],
  density:{tree:1.2,shrub:.8,grass:2.5},cluster:80,birds:[{body:'#161618',wing:'#101012',span:1.2,len:.6,flap:3.5,count:[2,4],alt:[25,70],speed:9,glide:.6}]},
 tropical:{fescue:0.4,label:'Tropical beach',trees:[['palm',.6],['seaGrapeTree',.2],['almond',.2]],shrubs:[['seaGrape',.6],['shrub',.4]],grass:[['marram',.55],['tussock',.45]],
  density:{tree:.7,shrub:.9,grass:2.5},cluster:60,birds:[{body:'#8a8074',wing:'#6e665c',tip:'#3a342e',span:2,len:.9,flap:2.4,count:[3,7],alt:[10,30],speed:8,glide:.8}]},
 heathland:{fescue:0.9,label:'Heathland links',trees:[['scotsPine',.65],['birch',.35]],shrubs:[['gorse',.55],['heather',.45]],grass:[['marram',.5],['fescue',.5]],
  density:{tree:.25,shrub:1.3,grass:3.5},cluster:110,birds:[{body:'#e6e4de',wing:'#a8acb0',tip:'#2a2a2a',span:1.2,len:.55,flap:3.5,count:[4,8],alt:[15,45],speed:9,glide:.6},{body:'#6a5a44',wing:'#5a4a38',span:.35,len:.2,flap:10,count:[2,3],alt:[20,40],speed:6,glide:.1}]},
};

// Locale from location: latitude/longitude, altitude and whether the hole touches the sea.
export function pickLocale(w,waterLevel=0){
 const [lon,lat]=w.toGeo({x:0,z:0});const a=Math.abs(lat);let sum=0,n=0;const pts=[w.tee,w.pin,...(w.route||[])].filter(Boolean);for(const p of pts){sum+=w.elevation(p.x,p.z);n++;}const elev=n?sum/n:0;
 const coast=(w.surfaces||[]).some(f=>String(f.id).startsWith('coast-water'))||(w.features||[]).some(f=>f.kind==='coastline'||f.kind==='beach');
 const arid=(lat>25&&lat<38&&lon>-120&&lon<-103)||(lat>14&&lat<35&&lon>-17&&lon<60)||(lat<-18&&lat>-32&&lon>115&&lon<145);
 if(arid)return 'desert';
 if(a<26)return coast?'tropical':'parkland';
 if(elev>1300)return 'mountain';
 if(a>49&&lon>-11&&lon<3)return coast||elev<60?'heathland':'parkland';
 if(coast)return a>50?'heathland':'oceanside';
 return 'parkland';}

const speciesCache=new Map();
function species(name,variant){const k=name+'#'+variant;if(!speciesCache.has(k)){const m=SP[name](1009+variant*7919+name.length*131);m.lod2=blobLOD(m.far,1009+variant);speciesCache.set(k,m);}return speciesCache.get(k);}
// LOD 2 (distant plants, a few pixels tall): the far mesh's crown collapsed into one lumpy 80-triangle hull in its mean
// leaf colour, on a 4-sided trunk. Same silhouette size and tone, ~1-3% of the vertices. uv (-3,-3) marks it as canopy.
function blobLOD(f,seed){const n=f.count,P=f.pos,C=f.col,U=f.uv;let cards=false;for(let i=0;i<n;i++)if(U[i*2]>=0){cards=true;break;}
 const mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9],lc=[0,0,0],bc=[0,0,0];let kl=0,kb=0,sw=0;
 for(let i=0;i<n;i++){const leafy=cards?U[i*2]>=0:true;if(leafy){for(let a=0;a<3;a++){mn[a]=Math.min(mn[a],P[i*3+a]);mx[a]=Math.max(mx[a],P[i*3+a]);lc[a]+=C[i*4+a];}sw+=C[i*4+3];kl++;}else{for(let a=0;a<3;a++)bc[a]+=C[i*4+a];kb++;}}
 const mb=new MB();if(!kl)return mb.finish();const col=lc.map(v=>v/kl*.82),sway=sw/kl,ctr=mn.map((v,a)=>(v+mx[a])/2),rad=mn.map((v,a)=>Math.max(.05,(mx[a]-v)/2*.92));
 mb.hull(ctr,rad,1,.26,()=>col,()=>sway,seed);for(let i=0;i<mb.u.length;i++)mb.u[i]=-3;
 if(cards&&kb&&mn[1]>.4){const bark=bc.map(v=>v/kb),r=Math.max(.06,Math.min(rad[0],rad[2])*.08);mb.tube([[0,0,0],[0,mn[1]+rad[1]*.6,0]],[r,r*.7],4,()=>bark,()=>0);}
 return mb.finish();}
export const VARIANTS=3;

// ------------------------------------------------------------------ placement
const vnoise=(x,z)=>{const h=(i,j)=>{const n=Math.sin(i*127.1+j*311.7)*43758.5453;return n-Math.floor(n)};const xi=Math.floor(x),zi=Math.floor(z),fx=x-xi,fz=z-zi,u=fx*fx*(3-2*fx),v=fz*fz*(3-2*fz);
 return lerp(lerp(h(xi,zi),h(xi+1,zi),u),lerp(h(xi,zi+1),h(xi+1,zi+1),u),v)};
const smoothstep=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t)};
const pick=(list,t)=>{let s=0;for(const [n,w] of list){s+=w;if(t<=s)return n;}return list[list.length-1][0]};

// Shot corridor: every tee->landing->green leg of every hole in the box, widened with plant height (a tall crown overhangs further
// and sits closer to the flight line), plus aprons around tees and greens.
function corridorClear(routes,x,z,r,h){for(const route of routes){for(let i=1;i<route.length;i++){const d=segmentDistance({x,z},route[i-1],route[i]);if(d<(h>3?24:h>1?16:6)+r+h*.4)return false;}
  const t=route[0],g=route[route.length-1];if(Math.hypot(x-t.x,z-t.z)<(h>1?22:8)+r)return false;if(Math.hypot(x-g.x,z-g.z)<(h>3?34:h>1?24:10)+r)return false;}return true;}

export function placeFlora(w,box,localeName,waterLevel=0){
 const L=LOCALES[localeName]||LOCALES.parkland;const routes=(w.courseRoutes||[{route:w.route||[]}]).map(h=>h.route).filter(r=>r&&r.length>1);
 const buildings=(w.features||[]).filter(f=>f.kind==='building'&&f.closed&&f.bounds);const woods=(w.features||[]).filter(f=>f.closed&&(f.kind==='wood'||f.kind==='scrub')&&f.bounds);
 const inPoly=(f,x,z)=>x>=f.bounds.minX&&x<=f.bounds.maxX&&z>=f.bounds.minZ&&z<=f.bounds.maxZ&&pointIn([x,z],f.points);
 const rough=(x,z)=>w.surface(x,z)==='rough'&&w.elevation(x,z)>waterLevel+.5;
 const ringOK=(x,z,r)=>rough(x,z)&&rough(x+r,z)&&rough(x-r,z)&&rough(x,z+r)&&rough(x,z-r)&&!buildings.some(f=>inPoly(f,x,z));
 const focus=w.tee||{x:0,z:0},end=w.pin||focus,mid={x:(focus.x+end.x)/2,z:(focus.z+end.z)/2};const holeLen=Math.hypot(end.x-focus.x,end.z-focus.z);
 const near=(x,z)=>{let d=1e9;for(const r of routes)for(let i=1;i<r.length;i++)d=Math.min(d,segmentDistance({x,z},r[i-1],r[i]));return d;};
 const canopy=(x,z)=>{if(!w.canopy)return null;const g=w.toGeo({x,z});return sampleCanopy(w.canopy,g[0],g[1]);};
 const out=new Map();const put=(name,variant,inst,layer)=>{const k=name+'#'+variant;if(!out.has(k))out.set(k,{name,variant,layer,inst:[]});out.get(k).inst.push(...inst);};
 const R=Math.min(box.size*.5,holeLen*.5+650);let seed=1;const rnd=()=>{const n=Math.sin((seed++)*12.9898+localeName.length*78.233)*43758.5453;return n-Math.floor(n)};
 const layers=[['tree',L.trees,9,L.density.tree*.81*(9*9/100)],['shrub',L.shrubs,4.5,L.density.shrub*(4.5*4.5/100)],['grass',L.grass,.75,0]];
 const counts={tree:0,shrub:0,grass:0},caps={tree:5000,shrub:9000,grass:70000};
 for(const [layer,list,step,dens] of layers){if(!dens)continue;const reach=layer==='grass'?Math.min(R,220):layer==='shrub'?Math.min(R,420):R;
  for(let x=mid.x-reach;x<mid.x+reach;x+=step)for(let z=mid.z-reach;z<mid.z+reach;z+=step){if(counts[layer]>=caps[layer])break;
   const px=x+rnd()*step,pz=z+rnd()*step;if(px<box.x||pz<box.z||px>box.x+box.size||pz>box.z+box.size)continue;
   let gf=0;if(layer==='grass'){gf=vnoise(px/48+3.1,pz/48+7.7)*.65+vnoise(px/15+1.3,pz/15)*.35;if(gf<.56-.1*L.density.grass/5)continue;}
   const dr=near(px,pz);if(layer==='grass'&&dr>reach)continue;
   // groves: clustered noise field (none in the desert: evenly spaced), boosted by mapped woodland and the satellite canopy
   let p=dens;if(L.cluster){const g=vnoise(px/L.cluster+(layer==='shrub'?7.3:0),pz/L.cluster);p*=Math.max(0,(g-.38)*2.6);}
   if(layer==='tree'){const cv=canopy(px,pz);const wd=woods.some(f=>f.kind==='wood'&&inPoly(f,px,pz));if(cv)p*=.4+cv.trees*1.8;if(wd)p=Math.max(p,dens*1.3);}
   if(layer==='shrub'&&['oceanside','heathland','tropical'].includes(localeName)){const e=3;const sl=Math.hypot(w.elevation(px+e,pz)-w.elevation(px-e,pz),w.elevation(px,pz+e)-w.elevation(px,pz-e))/(2*e);
    p=Math.max(p,dens*2.2*smoothstep(.07,.15,sl)*smoothstep(.35,.6,vnoise(px/22+4.4,pz/22+1.9)));}   /* coastal scrub clusters on the banks */
   if(layer==='shrub'){const cv=canopy(px,pz);if(cv)p*=.6+cv.shrubs*1.5;if(woods.some(f=>f.kind==='scrub'&&inPoly(f,px,pz)))p=Math.max(p,dens*1.5);}
   // native grass grows in broad continuous stands: a large-scale patch field (tens of metres) with feathered edges,
   // dense inside, kept off the cut edge of the playing line
   if(layer==='grass'){const cover=L.density.grass/5;p=smoothstep(.56-.1*cover,.62-.1*cover,gf)*smoothstep(9,22,dr)*.97;}
   if(rnd()>p)continue;
   const name=pick(list,rnd()),variant=Math.floor(rnd()*VARIANTS);const sp=species(name,variant);const sc=lerp(.82,1.18,rnd());
   if(!ringOK(px,pz,Math.min(sp.r*sc,layer==='grass'?.3:6)))continue;if(!corridorClear(routes,px,pz,sp.r*sc,sp.h*sc))continue;
   put(name,variant,[px,-.04*sc,pz,sc, rnd()*6.283,rnd(),rnd(),0],layer);counts[layer]++;
   if(layer==='shrub'){const k=Math.floor(rnd()*3);for(let j=0;j<k;j++){const a=rnd()*6.283,rr=sp.r*sc*lerp(1.2,2.4,rnd());const qx=px+Math.cos(a)*rr,qz=pz+Math.sin(a)*rr;const v2=Math.floor(rnd()*VARIANTS),s2=sc*lerp(.7,1.05,rnd());
    if(!rough(qx,qz)||!corridorClear(routes,qx,qz,sp.r*s2,sp.h*s2))continue;put(name,v2,[qx,-.04*s2,qz,s2,rnd()*6.283,rnd(),rnd(),0],layer);counts[layer]++;}}}}
 // fauna: flocks circling the hole
 const flocks=[];for(const b of L.birds){const nFlock=2+Math.floor(rnd()*2);for(let f=0;f<nFlock;f++){const cx=mid.x+(rnd()-.5)*holeLen*1.2,cz=mid.z+(rnd()-.5)*holeLen*1.2,rad=lerp(40,110,rnd());
  const n=Math.floor(lerp(b.count[0],b.count[1]+.99,rnd()));const alt=lerp(b.alt[0],b.alt[1],rnd());const dir=rnd()<.5?-1:1;
  for(let i=0;i<n;i++)flocks.push({b,inst:[cx,alt+(rnd()-.5)*6,cz,rad*(1+(rnd()-.5)*.15), (i*.045+rnd()*.02)*dir+rnd()*.0, dir*b.speed/rad, b.flap,1+b.glide]});}}
 return{groups:[...out.values()].map(g=>({...g,mesh:species(g.name,g.variant)})),birds:L.birds.map(b=>({mesh:bird(b),flap:b.flap,inst:flocks.filter(f=>f.b===b).map(f=>f.inst)})),counts,locale:localeName};}

// Native grass (fescue) stands: broad continuous patches in the rough, kept off the cut edge of every playing line.
// Returned as an NxN coverage grid over the terrain box; the GPU blade system grows kind 8 (fescue) wherever it wins.
export function fescueField(w,box,N=2048,localeName='parkland',unmapped=null){const coastal=['oceanside','heathland','tropical'].includes(localeName);const L=LOCALES[localeName]||LOCALES.parkland;const cover=Math.min(1,(L.fescue??.5));
 const routes=(w.courseRoutes||[{route:w.route||[]}]).map(h=>h.route).filter(r=>r&&r.length>1);
 // distance to the nearest playing line on a coarse grid (smooth field -> bilinear is exact enough), noise at full resolution
 const G=128,gc=box.size/G,dist=new Float32Array((G+1)*(G+1)),slope=new Float32Array((G+1)*(G+1));
 for(let j=0;j<=G;j++)for(let i=0;i<=G;i++){const x=box.x+i*gc,z=box.z+j*gc;let d=1e9;if(coastal){const e=3;const gx=(w.elevation(x+e,z)-w.elevation(x-e,z))/(2*e),gz=(w.elevation(x,z+e)-w.elevation(x,z-e))/(2*e);slope[j*(G+1)+i]=Math.hypot(gx,gz);}for(const r of routes)for(let k=1;k<r.length;k++)d=Math.min(d,segmentDistance({x,z},r[k-1],r[k]));dist[j*(G+1)+i]=d;}
 const out=new Float32Array(N*N);const cell=box.size/N;const lo=.6-.14*cover;
 for(let j=0;j<N;j++){const z=box.z+(j+.5)*cell,gz=(j+.5)/N*G,jz=Math.min(G-1,Math.floor(gz)),fz=gz-jz;
  for(let i=0;i<N;i++){const x=box.x+(i+.5)*cell;const f=vnoise(x/48+3.1,z/48+7.7)*.62+vnoise(x/15+1.3,z/15)*.28+vnoise(x/3.1,z/3.1+5.)*.1;const um=coastal;if(f<lo-.04&&!um)continue;
   const gx=(i+.5)/N*G,ix=Math.min(G-1,Math.floor(gx)),fx=gx-ix;const a=dist[jz*(G+1)+ix],b=dist[jz*(G+1)+ix+1],c=dist[(jz+1)*(G+1)+ix],e=dist[(jz+1)*(G+1)+ix+1];
   const d=lerp(lerp(a,b,fx),lerp(c,e,fx),fz);const off=(um?7:10)+(um?15:22)*vnoise(x/26+9.1,z/26+2.3);let cv=smoothstep(lo-.04,lo+.04,f);
   /* coastal courses: unmapped slopes (bluffs, banks, dune faces outside every mapped polygon) grow native grass, broken up by the same noise */
   if(um){const sl=lerp(lerp(slope[jz*(G+1)+ix],slope[jz*(G+1)+ix+1],fx),lerp(slope[(jz+1)*(G+1)+ix],slope[(jz+1)*(G+1)+ix+1],fx),fz);cv=Math.max(cv,smoothstep(.07,.15,sl)*smoothstep(.3,.44,f+.08*vnoise(x/7,z/7)));}   /* any rolling ground on a coastal course (fairways/tees/greens are never fescue: only rough is converted) */
   out[j*N+i]=cv*smoothstep(off,off+8,d);   /* wandering set-back from the line, never a ruled edge */   /* wandering set-back from the line, never a ruled edge */}}
 return out;}
