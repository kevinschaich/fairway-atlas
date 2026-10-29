// WGSL for the native flora/fauna pass (see flora.js). One module, three entry pairs:
//  vs/fs          lit colour pass (near: perforated leaf cards; far: hull LOD; birds)
//  vsShadow/fsShadow  depth-only shadow caster with the same wind and the same leaf cut-outs
import {FRAME,COMMON} from './shaders-common.js';
export const FLORA=FRAME+COMMON+/*wgsl*/`
@group(1) @binding(0) var<uniform> FL:vec4f;   // x: lod (0 near, 1 far), y: near/far split distance, z: max distance, w: bird pass
struct VI{@location(0) pos:vec3f,@location(1) nrm:vec3f,@location(2) col:vec4f,@location(3) uv:vec2f,@location(4) ia:vec4f,@location(5) ib:vec4f}
struct VO{@builtin(position) @invariant pos:vec4f,@location(0) wp:vec3f,@location(1) n:vec3f,@location(2) col:vec3f,@location(3) uv:vec2f,@location(4) seed:f32,@location(5) fade:f32,@location(6) gy:f32}
fn rotY(p:vec3f,a:f32)->vec3f{let c=cos(a);let s=sin(a);return vec3f(p.x*c-p.z*s,p.y,p.x*s+p.z*c);}
struct Placed{p:vec3f,n:vec3f,keep:f32,fade:f32,gy:f32}
fn place(i:VI)->Placed{var o:Placed;let t=F.camPos.w;
 if(i.ib.w>.5){   // ---- bird: orbit a flock centre, bank into the turn, flap (uv.x = |span| position)
  let ang=i.ib.x+t*i.ib.y;let R=i.ia.w;let c=vec3f(i.ia.x+cos(ang)*R,i.ia.y+sin(t*.23+i.ib.x*9.)*2.,i.ia.z+sin(ang)*R);
  let fw=normalize(vec3f(-sin(ang),0.,cos(ang))*sign(i.ib.y));let yaw=atan2(fw.x,fw.z);
  let glide=smoothstep(.2,.9,sin(t*.4+i.ib.x*13.)*.5+.5)*(i.ib.w-1.);let flap=sin(t*i.ib.z*6.283+i.ib.x*40.)*(1.-glide);
  var p=i.pos*2.2;let span=max(i.uv.x,0.);p.y+=flap*span*span*.9*2.2+select(0.,span*.15,i.uv.x>=0.);
  let bank=-sign(i.ib.y)*.35;p=vec3f(p.x*cos(bank)-p.y*sin(bank),p.x*sin(bank)+p.y*cos(bank),p.z);
  let s=sin(yaw);let co=cos(yaw);o.p=c+vec3f(p.x*co+p.z*s,p.y,-p.x*s+p.z*co);let bn=vec3f(-sin(bank),cos(bank),0.);o.n=vec3f(bn.x*co+bn.z*s,bn.y,-bn.x*s+bn.z*co);o.keep=1.;o.fade=1.;o.gy=-1e4;return o;}   /* bird: its wings' true (banked) normal, lit two-sided like any thin surface */
 // ---- plant: yaw + scale, planted on the drawn ground (relief included), wind bends the upper parts
 let sc=i.ia.w;var p=rotY(i.pos*sc,i.ib.x);var n=rotY(i.nrm,i.ib.x);
 let base=vec3f(i.ia.x,0.,i.ia.z);let g=i.ia.y;   // planted height: the drawn ground under the trunk (+ offset), resolved per instance on the CPU (backend.floraLOD), not per vertex
 let wd=F.wind.xy;let ws=F.wind.z;let ph=dot(base.xz,vec2f(.071,.053))+i.ib.z*6.283;
 let sway=i.col.a;let gust=.55+.45*sin(t*.9+ph*.7)*sin(t*.37+ph);
 var bend=wd*(ws*1.4*gust*sway*(.8+.2*sin(t*1.7+ph)));
 let leafy=select(0.,1.,i.uv.x>=0.&&i.uv.y>=0.);
 bend+=vec2f(sin(t*5.3+i.pos.y*3.+ph),cos(t*4.1+i.pos.x*3.))*.035*sway*leafy*(.4+ws*2.);
 p=vec3f(p.x+bend.x*sc,p.y-dot(bend,bend)*.15*sc,p.z+bend.y*sc);
 o.p=vec3f(base.x,g,base.z)+p;o.n=n;o.gy=g;
 let d=distance(F.camPos.xyz,vec3f(base.x,g,base.z));   // 3-D: an overhead camera is far from every crown
 // LOD split with a dithered overlap band; beyond max distance the instance collapses
 let band=FL.y*.12;o.fade=select(smoothstep(FL.y+band,FL.y,d),smoothstep(FL.y-band,FL.y-band*.6,d)*(1.-smoothstep(FL.z*.85,FL.z,d)),FL.x>.5);   // the solid far LOD is fully in before the near cards thin out over it: no see-through holes in the handover
 o.keep=select(0.,1.,o.fade>.001);return o;}
@vertex fn vs(i:VI)->VO{let q=place(i);var o:VO;o.wp=q.p;o.pos=select(vec4f(0.,0.,-2.,1.),F.viewProj*vec4f(q.p,1.),q.keep>0.);
 o.n=q.n;o.col=i.col.rgb;o.uv=i.uv;o.seed=i.ib.z;o.fade=q.fade;o.gy=q.gy;
 // tint: per-plant tone and hue drift (drier / lusher)
 let tn2=i.ib.y;if(i.ib.w<.5){o.col=o.col*mix(vec3f(.84,.86,.8),vec3f(1.1,1.06,.96),tn2)*mix(vec3f(1.),vec3f(1.08,1.03,.86),smoothstep(.6,1.,tn2)*.6);}
 return o;}
@group(1) @binding(1) var atlasTex:texture_2d<f32>;
@group(1) @binding(2) var atlasSamp:sampler;
// twig atlas (foliage-atlas.js): 4x4 tiles; tile = floor(u/2). Returns linear rgb + alpha with mip-aware coverage boost.
fn atlasUV(uv0:vec2f)->vec2f{let ty=floor(uv0.x/2.);let u=uv0.x-ty*2.;let tc=vec2f(ty%4.,floor(ty/4.));return (tc+vec2f(.04+u*.92,.04+(1.-uv0.y)*.92))/4.;}
fn atlasLod(a:vec2f)->f32{let d=max(length(dpdx(a)),length(dpdy(a)))*2048.;return clamp(log2(max(d,1e-4)),0.,5.);}
fn atlasSample(a:vec2f,lod:f32)->vec4f{var t=textureSampleLevel(atlasTex,atlasSamp,a,lod);t.a=t.a*(1.+lod*.32);return t;}
fn ditherKeep(pos:vec2f,fade:f32)->bool{if(fade>=.999){return true;}return ihash(floor(pos),7u)<fade;}
// depth pre-pass for the near (card) LOD: same vertex shader (positions @invariant), same cut-outs; the colour pass then
// shades each visible leaf pixel once (depth 'equal') instead of once per overlapping card
@fragment fn fsDepth(v:VO)->@location(0) vec4f{let card=v.uv.x>=0.&&v.uv.y>=0.;let au=atlasUV(max(v.uv,vec2f(0.)));let lod=atlasLod(au);
 if(!ditherKeep(v.pos.xy,v.fade)){discard;}
 if(card){let t=atlasSample(au,lod);let cd=distance(F.camPos.xyz,v.wp);if(t.a<mix(.5,.16,smoothstep(120.,420.,cd)*FL.x)){discard;}}
 return vec4f(0.);}
@fragment fn fs(v:VO,@builtin(front_facing) ff:bool)->@location(0) vec4f{
 let card=v.uv.x>=0.&&v.uv.y>=0.;let au=atlasUV(max(v.uv,vec2f(0.)));let lod=atlasLod(au);
 if(!ditherKeep(v.pos.xy,v.fade)){discard;}
 var alb=v.col;var n=normalize(v.n);var leaf=0.;
 if(card){let t=atlasSample(au,lod);let cd=distance(F.camPos.xyz,v.wp);if(t.a<mix(.5,.16,smoothstep(120.,420.,cd)*FL.x)){discard;}leaf=1.;   // far crowns: sub-pixel leaf cards read as a solid canopy, not salt-and-pepper sky holes
  let lin=pow(t.rgb,vec3f(2.2));let lum=dot(lin,vec3f(.3,.5,.2));let sat=max(lin.r,max(lin.g,lin.b))-min(lin.r,min(lin.g,lin.b));
  // leaves are painted neutral (the species tint colours them); blossoms are painted in true colour
  let g=v.col*clamp(lum/.2,.3,1.5);alb=mix(mix(vec3f(dot(g,vec3f(.3,.55,.15))),g,.82),lin*.9,smoothstep(.05,.18,sat));
  n=normalize(n+(vec3f(hash21(floor(au*512.)),.5,hash21(floor(au*512.)+3.))-.5)*.5);}
 else if(v.uv.x<-2.5){leaf=1.;   // LOD-2 crown hull: lit as canopy, broken up into leaf clumps so it never reads as a smooth ball
  let q=v.wp*.09;let m1=tn(q.xz+q.y*.7).r;let m2=tn(q.zx*2.3-q.y*1.1).g;alb*=.6+.55*m1+.25*m2;n=normalize(n+vec3f(m1-.5,m2-.5,m2-m1)*.9);}
 else{if(!ff){n=-n;}
  if(v.uv.y>-1.5&&v.uv.x<0.){
  // bark: vertical fissures and plates in world space (trunks/branches are the only solid parts wider than a blade)
  let bp=v.wp*vec3f(9.,2.2,9.);let fis=tn(vec2f(bp.x+bp.z,bp.y)*.35).r;let pl=tn(vec2f(bp.x-bp.z,bp.y*1.7)*.9).g;alb*=.55+.7*smoothstep(.25,.75,fis)*(.7+.5*pl);}}
 let vd=normalize(F.camPos.xyz-v.wp);let s=F.sunDir.xyz;
 let osh=objShadow(v.wp,n);var sh=terrainShadowCached(v.wp)*cloudShadow(v.wp)*mix(osh,.22+.78*osh,leaf);   /* only the crown's own shadow is porous: a hill or a cloud blocks the sun completely */   // a crown is porous: sun leaks through its gaps
 if(v.wp.y-v.gy<2.){sh*=contactShadow(v.wp,n);}                                          // low shrubs and grass sit in the ground's contact shadows
 // lighting engine (shade()): leaves are thin translucent canopy elements, bark is rough and opaque
 var S:LitSurf;S.p=v.wp;S.n=n;S.alb=alb;S.rough=mix(.9,.55,leaf);S.f0=.035;S.canopy=leaf*.6;S.trans=leaf*.7;S.ao=groundAO(v.wp.xz).x;S.vis=sh;
 var c=vec3f(0.);if(pk(14u)){c=S.alb*(F.sunColor.rgb*.3+ambientSky(vec3f(0.,1.,0.))*.5);}else{c=shade(S);}
 return vec4f(fogApply(c,v.wp),1.);}
@group(2) @binding(0) var<uniform> SVP:mat4x4f;
struct SO{@builtin(position) pos:vec4f,@location(0) uv:vec2f,@location(1) seed:f32,@location(2) fade:f32}
@vertex fn vsShadow(i:VI)->SO{let q=place(i);var o:SO;o.pos=select(vec4f(0.,0.,-2.,1.),SVP*vec4f(q.p,1.),q.keep>0.);o.uv=i.uv;o.seed=i.ib.z;o.fade=q.fade;return o;}
@fragment fn fsShadow(v:SO){let au=atlasUV(max(v.uv,vec2f(0.)));let lod=atlasLod(au)+1.;if(v.fade<.5){discard;}if(v.uv.x>=0.&&v.uv.y>=0.){if(atlasSample(au,lod).a<.5){discard;}}}
`;
// ---------------------------------------------------------------------------------------------------------------------
// Impostors (backend: bakeImpostors / drawFlora). Beyond ~90 m (trees) / ~35 m (shrubs) a plant's wind sway and leaf
// geometry are below what the eye can resolve, so each species is baked once into an atlas from 8 azimuths x 3
// elevations (albedo + coverage, normal + leaf mask) and drawn as ONE camera-facing quad that is still lit per pixel
// with the same lighting, shadows and fog as the real mesh. The four nearest baked views are blended.
export const IMPOSTOR_WGSL=FLORA+/*wgsl*/`
struct BKU{m:mat4x4f,c:vec4f}   // c: crown centre (xyz) + radius, for the baked crown occlusion
@group(2) @binding(0) var<uniform> BK:BKU;
struct BO{@builtin(position) pos:vec4f,@location(0) op:vec3f,@location(1) n:vec3f,@location(2) col:vec3f,@location(3) uv:vec2f}
@vertex fn vsBake(i:VI)->BO{var o:BO;o.pos=BK.m*vec4f(i.pos,1.);o.op=i.pos;o.n=i.nrm;o.col=i.col.rgb;o.uv=i.uv;return o;}
struct BT{@location(0) a:vec4f,@location(1) b:vec4f}
@fragment fn fsBake(v:BO,@builtin(front_facing) ff:bool)->BT{
 let card=v.uv.x>=0.&&v.uv.y>=0.;var alb=v.col;var n=normalize(v.n);var leaf=0.;
 if(card){let au=atlasUV(v.uv);let t=textureSampleLevel(atlasTex,atlasSamp,au,1.);if(t.a<.5){discard;}leaf=1.;
  let lin=pow(t.rgb,vec3f(2.2));let lum=dot(lin,vec3f(.3,.5,.2));let sat=max(lin.r,max(lin.g,lin.b))-min(lin.r,min(lin.g,lin.b));
  let g=v.col*clamp(lum/.2,.3,1.5);alb=mix(mix(vec3f(dot(g,vec3f(.3,.55,.15))),g,.82),lin*.9,smoothstep(.05,.18,sat));
  n=normalize(n+(vec3f(hash21(floor(au*512.)),.5,hash21(floor(au*512.)+3.))-.5)*.5);}
 else if(v.uv.x<-2.5){leaf=1.;}
 else{if(!ff){n=-n;}
  if(v.uv.y>-1.5&&v.uv.x<0.){let bp=v.op*vec3f(9.,2.2,9.);let fis=tn(vec2f(bp.x+bp.z,bp.y)*.35).r;let pl=tn(vec2f(bp.x-bp.z,bp.y*1.7)*.9).g;alb*=.55+.7*smoothstep(.25,.75,fis)*(.7+.5*pl);}}
 // crown self-occlusion the flat quad can't get from the shadow map: leaves deep in the crown sit in their neighbours' shade
 let rad=length((v.op-BK.c.xyz)/vec3f(BK.c.w,BK.c.w*.8,BK.c.w));alb*=mix(1.,.5+.5*smoothstep(.2,.95,rad),leaf);
 return BT(vec4f(sqrt(clamp(alb,vec3f(0.),vec3f(1.))),1.),vec4f(n*.5+.5,leaf));}

struct IMG{blk:vec4f,geo:vec4f,lod:vec4f}   // blk: atlas block origin uv, cell size uv; geo: quad half size, centre y, -, -; lod: fade-in start, end, max distance, -
@group(1) @binding(0) var<uniform> IM:IMG;
@group(1) @binding(1) var impA:texture_2d<f32>;
@group(1) @binding(2) var impB:texture_2d<f32>;
@group(1) @binding(3) var impS:sampler;
struct IO{@builtin(position) pos:vec4f,@location(0) wp:vec3f,@location(1) q:vec2f,@location(2) @interpolate(flat) view:vec4f,@location(3) @interpolate(flat) inst:vec4f}   // view: az cell (float), elevation row (float), yaw, fade; inst: tone, base y, -, -
const ELEV=array<f32,3>(.14,.66,1.26);   // baked elevations (rad): 8, 38, 72 degrees
@vertex fn vsImp(@builtin(vertex_index) vi:u32,@location(4) ia:vec4f,@location(5) ib:vec4f)->IO{var o:IO;
 let c=array<vec2f,6>(vec2f(-1.,-1.),vec2f(1.,-1.),vec2f(1.,1.),vec2f(-1.,-1.),vec2f(1.,1.),vec2f(-1.,1.))[vi];
 let sc=ia.w;let base=vec3f(ia.x,ia.y,ia.z);let cen=base+vec3f(0.,IM.geo.y*sc,0.);let toC=F.camPos.xyz-cen;let d=length(toC);let dir=toC/max(d,1e-3);
 let rr=cross(vec3f(0.,1.,0.),dir);let r=select(normalize(rr),vec3f(1.,0.,0.),length(rr)<1e-4);let u=cross(dir,r);
 let L=IM.geo.x*sc;o.wp=cen+(r*c.x+u*c.y)*L;o.pos=F.viewProj*vec4f(o.wp,1.);o.q=c;
 let ld=rotY(dir,-ib.x);let az=atan2(ld.z,ld.x);let el=asin(clamp(ld.y,-1.,1.));
 let e=clamp(select((el-ELEV[1])/(ELEV[2]-ELEV[1])+1.,(el-ELEV[0])/(ELEV[1]-ELEV[0]),el<ELEV[1]),0.,2.);
 let fade=smoothstep(IM.lod.x,IM.lod.y,d)*(1.-smoothstep(IM.lod.z*.85,IM.lod.z,d));
 o.view=vec4f(fract(az/6.2831853)*8.,e,ib.x,fade);o.inst=vec4f(ib.y,ia.y,d*F.res.w/(2.*L),0.);   // z: metres-per-pixel over quad size -> mip
 if(fade<=.001){o.pos=vec4f(0.,0.,-2.,1.);}return o;}
fn impUV(cell:vec2f,q:vec2f)->vec2f{return IM.blk.xy+(cell+vec2f(q.x*.5+.5,.5-q.y*.5))*IM.blk.zw;}
@fragment fn fsImp(v:IO)->@location(0) vec4f{
 if(!ditherKeep(v.pos.xy,v.view.w)){discard;}
 let a0=floor(v.view.x);let fa=v.view.x-a0;let a1=(a0+1.)%8.;let e0=floor(min(v.view.y,1.999));let fe=v.view.y-e0;
 // shrink the sample slightly inside the cell so bilinear taps never bleed into the neighbouring view
 let lod=clamp(log2(max(v.inst.z*IM.blk.z*f32(textureDimensions(impA).x),1.)),0.,4.);let q=v.q*.985;
 let u00=impUV(vec2f(a0,e0),q);let u10=impUV(vec2f(a1,e0),q);let u01=impUV(vec2f(a0,e0+1.),q);let u11=impUV(vec2f(a1,e0+1.),q);
 let w=vec4f((1.-fa)*(1.-fe),fa*(1.-fe),(1.-fa)*fe,fa*fe);
 // coverage first: most of the quad is empty and is rejected after 4 taps; normals are only fetched for kept pixels
 let A=textureSampleLevel(impA,impS,u00,lod)*w.x+textureSampleLevel(impA,impS,u10,lod)*w.y+textureSampleLevel(impA,impS,u01,lod)*w.z+textureSampleLevel(impA,impS,u11,lod)*w.w;
 if(A.a<mix(.5,.3,clamp(lod/3.,0.,1.))){discard;}   // mips average coverage down: keep distant crowns solid
 let B=textureSampleLevel(impB,impS,u00,lod)*w.x+textureSampleLevel(impB,impS,u10,lod)*w.y+textureSampleLevel(impB,impS,u01,lod)*w.z+textureSampleLevel(impB,impS,u11,lod)*w.w;
 let cov=max(A.a,1e-3);let alb0=A.rgb/cov;let leaf=B.a/cov;
 let tone=v.inst.x;var alb=alb0*alb0*mix(vec3f(.84,.86,.8),vec3f(1.1,1.06,.96),tone)*mix(vec3f(1.),vec3f(1.08,1.03,.86),smoothstep(.6,1.,tone)*.6);
 var n=normalize(B.rgb/cov*2.-1.);n=rotY(n,v.view.z);
 let osh=objShadowFast(v.wp+n*.05);let sh=terrainShadowCached(v.wp)*cloudShadow(v.wp)*mix(osh,.22+.78*osh,leaf);   // (screen-space contact shadows are sub-pixel at impostor range)
 var S:LitSurf;S.p=v.wp;S.n=n;S.alb=alb;S.rough=mix(.9,.55,leaf);S.f0=.035;S.canopy=leaf*.6;S.trans=leaf*.7;S.ao=groundAO(v.wp.xz).x;S.vis=sh;
 return vec4f(fogApply(shade(S),v.wp),1.);}
`;
