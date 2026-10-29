import {FRAME,COMMON} from './shaders-common.js';
// ---------------------------------------------------------------- sky
export const SKY=FRAME+COMMON+/*wgsl*/`
struct VO{@builtin(position) pos:vec4f,@location(0) ndc:vec2f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{let p=vec2f(f32((i<<1u)&2u),f32(i&2u))*2.-1.;var o:VO;o.pos=vec4f(p,0.,1.);o.ndc=p;return o;}   /* far plane (reverse-Z): drawn after the ground, depth-equal to the clear */
@fragment fn fs(v:VO)->@location(0) vec4f{let w=F.invViewProj*vec4f(v.ndc,1.,1.);let d=normalize(w.xyz/w.w-F.camPos.xyz);
 var c=skyColor(d);let mu=dot(d,F.sunDir.xyz);
 // sun: limb-darkened disc + tight aureole, both behind the cloud deck
 let r=acos(clamp(mu,-1.,1.));let disc=1.-smoothstep(.0045,.0052,r);let limb=sqrt(max(1.-pow(r/.0052,2.),0.));
 c+=F.sunColor.rgb*(disc*mix(.45,1.,limb)*90.+hg(mu,.985)*.9)*smoothstep(-.02,.0,d.y);
 // horizon swallowed by the same aerial perspective as the ground
 let hzn=exp(-max(d.y,0.)*mix(14.,5.,F.sunColor.w));
 c=mix(c,fogInscatter(d),hzn*mix(.15,.55,F.sunColor.w));
 return vec4f(c,1.);}
`;
// Ground albedo, split so the material cache (gpu/matcache.js) can bake the part that depends only on world xz:
//  groundAlbedoStatic: painted base + collar / bunker-surround fixes + aerial-photo blend + tee/fairway tone + wet beach.
//    fpm < 0: per pixel (texture footprint from the screen derivatives gDX/gDY); fpm >= 0: baked at fpm metres per texel.
//  groundAlbedoView: the camera-dependent part (near fibre, rough haze tint with distance, sand, footprint-filtered grain).
// All the static terms are multiplicative, so view(static(x)) is exactly the old single function.
const GA=/*wgsl*/`
fn gaTex(t:texture_2d<f32>,uv:vec2f,span:f32,fpm:f32)->vec3f{if(fpm<0.){return textureSampleGrad(t,linSamp,uv,gDX/span,gDY/span).rgb;}
 return textureSampleLevel(t,linSamp,uv,max(log2(max(fpm*f32(textureDimensions(t).x)/span,1e-6)),0.)).rgb;}
fn groundAlbedoStatic(xz:vec2f,sm:vec4f,fpm:f32)->vec3f{let uv=boxUV(xz);var base=gaTex(baseMap,uv,F.box.z,fpm);
 let k=kindAt(xz);
 // collar: the painted base map only knows the green polygon, so the band outside it would take the rough's colour.
 // Borrow the green's colour from ~1.2 m inward (along the mask gradient) instead.
 let fr0=smoothstep(.2,.3,sm.a)*(1.-smoothstep(.71,.79,sm.a));
 if(fr0>.01){let e=.35;let gx=surfMask(xz+vec2f(e,0.)).a-surfMask(xz-vec2f(e,0.)).a;let gz=surfMask(xz+vec2f(0.,e)).a-surfMask(xz-vec2f(0.,e)).a;
  let gd=vec2f(gx,gz);if(dot(gd,gd)>1e-6){let inner=textureSampleLevel(baseMap,linSamp,boxUV(xz+normalize(gd)*1.2),0.).rgb;base=mix(base,inner,fr0);}}
 // bunker surround: the base map and the aerial photo are too coarse to stop at the sand line, so turf within ~0.7 m of a bunker
 // would pick up bright sand colour (a pale rim). Take both from just outside that band instead (outward along the distance field).
 var sq=xz;if(sm.g>.001&&sm.g<.5){let e=.3;let gg=vec2f(surfMask(xz+vec2f(e,0.)).g-surfMask(xz-vec2f(e,0.)).g,surfMask(xz+vec2f(0.,e)).g-surfMask(xz-vec2f(0.,e)).g);
  if(dot(gg,gg)>1e-8){sq=xz-normalize(gg)*(.75+(sm.g-.5)*1.2);base=textureSampleLevel(baseMap,linSamp,boxUV(sq),0.).rgb;}}
 let su=(sq-F.satBox.xy)/F.satBox.z;let s=gaTex(satMap,su,F.satBox.z,fpm);
 let inSat=F.satBox.w*step(0.,min(su.x,su.y))*step(max(su.x,su.y),1.);
 // Photo detail with the mapped surface's hue: fairways read as fairways, the photo supplies wear and variation.
 let sl=dot(s,vec3f(.3,.5,.2));let bl=dot(base,vec3f(.3,.5,.2));let photo=mix(base*(sl/max(bl,.01)),s,.5);
 base=mix(base,photo,F.extra.x*inSat*(1.-.9*smoothstep(.2,.3,sm.a)));  // aerial mow tracks read as contour rings on greens
 if(k==2.||k==4.||k==3.){base*=.96+.08*tn(xz*.014).b;}
 // wet beach: land within a few metres of the sea is darker and glossier-looking
 {let wb=smoothstep(.55,.95,textureSampleLevel(reliefMap,linSamp,boxUV(xz),0.).b);if(wb>0.){base*=mix(1.,.6,wb*(1.-seabedDrop(xz)/5.));}}   // seabedDrop reads 16 height texels: only near the shore
 // static grain (value noise, 2.4-430 m): multiplicative, so it is baked with the rest of the static stack
 {var gl=0.;if(fpm<0.){gl=log2(max(length(gDX)+length(gDY),1e-6)*.5*1024.*.41);}else{gl=log2(max(fpm,1e-6)*1024.*.41);}
  let n1=tn(xz*.0023);let n2=tn(xz*.037);let n3=tnd(xz*.41,clamp(gl,0.,9.));base*=1.+(n1.r-.5)*.16+(n2.g-.5)*.07+(n3.a-.5)*.06;}
 return base;}
fn groundAlbedoView(S:vec3f,p:vec3f,sm:vec4f,k:f32)->vec3f{var base=S;let cd=distance(p.xz,F.camPos.xz);
 if((k==2.||k==4.||k==3.)&&cd<40.){let ax=vec2f(F.extra.z,F.extra.w);let q=vec2f(dot(p.xz,ax),dot(p.xz,vec2f(-ax.y,ax.x)));
  let fl=clamp(log2(cd*F.res.w*1024.*2.2),0.,9.);let fibre=tnd(q*vec2f(.14,.94),fl).a*.55+tnd(q*vec2f(.39,2.2),fl).a*.45;base*=mix(.9+.2*fibre,1.,smoothstep(8.,40.,cd));}
 if(sm.r<.5&&sm.g<.5&&sm.b<.5){base=mix(base*vec3f(.72,.8,.62),base,smoothstep(40.,140.,cd));}
 let sandy=smoothstep(.46,.5,sm.g);
 if(sandy>.01){return mix(base,sandAlb(p.xz),sandy);}
  return base;}
fn sandAlb(xz:vec2f)->vec3f{let rip=tn(xz*vec2f(.094,.031)).r*.5+tn(xz*.36).a*.5;return mix(vec3f(.78,.69,.52),vec3f(.86,.79,.63),rip);}
// fully inside a bunker the sand colour replaces the whole turf stack: skip it (exact: mix(base,sand,1) = sand)
fn groundAlbedo(p:vec3f)->vec3f{let sm=surfMask(p.xz);if(sm.g>=.4999){return sandAlb(p.xz);}return groundAlbedoView(groundAlbedoStatic(p.xz,sm,-1.),p,sm,kindAt(p.xz));}
`;
export {GA};
// ---------------------------------------------------------------- generic meshes (+ ground mode)
const LEAF_P=64.;const LEAF_RES=16.;
// Matted mown turf leaves (procedural, P-periodic when P>0). Baked once into leafTex (LEAF_BAKE below: 4 grain directions,
// mipmapped), which the ground shader samples; mips are the footprint prefilter.
export const LEAF=/*wgsl*/`
struct Turf{col:f32,n:vec2f,ao:f32,sheen:f32,hue:f32}
fn leafLayer(q:vec2f,seed:f32,grain:vec2f,P:i32)->Turf{var o:Turf;o.col=0.;o.n=vec2f(0);o.ao=.55;o.sheen=0.;o.hue=.5;
 let id=floor(q);var best=-1.;
 for(var j=-1;j<=1;j++){for(var i=-1;i<=1;i++){for(var b=0;b<2;b++){
  // one hash per candidate, split into 4 values; reject by centre distance before any trig (most candidates miss)
  let cid=id+vec2f(f32(i),f32(j));let ci=select(vec2i(cid),((vec2i(cid)%vec2i(P))+vec2i(P))%vec2i(P),P>0);let hv=pcg(pcg(bitcast<u32>(ci.x)^(u32(seed)*977u+u32(b)*131u))+bitcast<u32>(ci.y));
  let r2=vec2f(f32(hv&255u),f32((hv>>8u)&255u))/255.;let c=cid+r2;let d=q-c;if(dot(d,d)>.98){continue;}
  let r=vec2f(f32((hv>>16u)&255u),f32(hv>>24u))/255.;
  var a=r.x*6.2832;let dir0=vec2f(cos(a),sin(a));let dir=normalize(mix(dir0,grain*sign(dot(dir0,grain)+1e-3),.35));
  let al=dot(d,dir);let ac=dot(d,vec2f(-dir.y,dir.x));
  let L=.55+.4*r.y;let W=.2+.12*r2.x;
  let u=al/L;if(abs(u)>1.){continue;}
  let wprof=W*(1.-u*u*u*u)*(1.-max(u,0.)*.6);   // pointed tip
  let v=ac/max(wprof,1e-3);if(abs(v)>1.){continue;}
  let hgt=(1.-v*v)*.35+.65*(.5+.5*r2.y)-(u+1.)*.12;  // leaves stack at random heights; rounded cross-section
  if(hgt>best){best=hgt;o.col=1.;o.n=vec2f(-dir.y,dir.x)*v*.55+dir*(.15+.2*r.y);o.ao=.72+.28*hgt;o.sheen=(1.-v*v);o.hue=r2.y*.7+r.x*.3;}}}}
 return o;}
`;
export const LEAF_BAKE=FRAME+COMMON+LEAF+/*wgsl*/`
override ANG:f32=0.;
struct BO{@builtin(position) p:vec4f}
@vertex fn vs(@builtin(vertex_index) i:u32)->BO{let q=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:BO;o.p=vec4f(q*2.-1.,0.,1.);return o;}
// 16 texels per leaf cell, 64 cells per period; 4x4 supersampled
@fragment fn fs(v:BO)->@location(0) vec4f{let grain=vec2f(cos(ANG),sin(ANG));var acc=vec4f(0.);
 for(var j=0;j<4;j++){for(var i=0;i<4;i++){let q=(floor(v.p.xy)+(vec2f(f32(i),f32(j))+.5)/4.)/${LEAF_RES.toFixed(1)};let t=leafLayer(q,0.,grain,${LEAF_P|0});acc+=vec4f(t.n*.5+.5,t.ao,t.hue);}}
 return acc/16.;}
`;
export const LEAF_SIZE=LEAF_P*LEAF_RES;
// derivative_uniformity off: fully submerged ground returns early (below); the only derivative left after that point is
// the specular-AA normal variance, which is merely approximate on the few shoreline quads that mix returned lanes.
export const MESH='diagnostic(off,derivative_uniformity);\n'+FRAME+COMMON+LEAF+/*wgsl*/`
var<private> gDX:vec2f;var<private> gDY:vec2f;   // world-xz screen derivatives, taken at the top of fs in uniform control flow
struct Mat{color:vec4f,params:vec4f,emissive:vec4f,pad:vec4f,e0:vec4f,e1:vec4f,e2:vec4f,e3:vec4f}  // params: hasMap, alphaTest, mode(0 lit,1 ground,2 unlit,3 foliage), vertexColor
// pad: metalness, clearcoat, special (0 none, 1 golf ball, 2 flag cloth, 3 divot, 4 carbon weave, 5 milled face, 6 brushed/satin), spin blur arc (rad)
// e0: spin axis (object space) + dimple strength; e1: ball centre (world) + radius; e2: world->object rotation quaternion; e3: spare
@group(1) @binding(0) var<uniform> M:Mat;
@group(1) @binding(1) var mapTex:texture_2d<f32>;
struct VI{@location(0) pos:vec3f,@location(1) nrm:vec3f,@location(2) uv:vec2f,@location(3) col:vec4f,
 @location(4) m0:vec4f,@location(5) m1:vec4f,@location(6) m2:vec4f,@location(7) m3:vec4f}
struct VO{@builtin(position) pos:vec4f,@location(0) wp:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) col:vec4f}
fn surfY(q:vec2f)->f32{return groundH(q)-bunkerSink(q)-seabedDrop(q);}
// CDLOD terrain (gpu/terrain.js): patch grid coords + node (x, z, vertex spacing, lod). Heights come from the cached clipmap;
// vertices geo-morph onto the next LOD's lattice over the last 20% of their LOD range. col.a = -1.25 marks terrain.
// F.clip[7].w: vertical scale (the course 'rises' from flat while it is being built).
override CUT:bool=true;   // false: pipeline variant without the bunker-outline discard (nodes with no bunker)
override SEA:bool=false;
override GROUND:bool=true;   // false: object pipelines, compiled without the ground material (a much smaller shader)  // true: terrain nodes entirely under the sea (flat deep-water colour, no ground material)
struct TVI{@location(0) g:vec2f,@location(4) node:vec4f}
@vertex fn vsT(i:TVI)->VO{let cell=i.node.z;var xz=i.node.xy+i.g*cell;
 let r=F.clip[7].z*exp2(i.node.w);let d=distance(F.camPos.xyz,vec3f(xz.x,select(terrainH(xz),cmHl(CM_L-1,xz),F.clip[CM_L-1].w>.5)*F.clip[7].w,xz.y));   // morph distance: the coarsest cached level is plenty (any function of xz keeps shared vertices crack-free)
 xz-=fract(i.g*.5)*2.*cell*clamp((d-r*.8)/(r*.2),0.,1.);
 xz=clamp(xz,F.box.xy,F.box.xy+vec2f(F.box.z));
 let w=vec4f(xz.x,terrainH(xz)*F.clip[7].w,xz.y,1.);var o:VO;o.pos=F.viewProj*w;o.wp=w.xyz;o.n=vec3f(0.,1.,0.);o.uv=vec2f(0.);o.col=vec4f(1.,1.,1.,-1.25);return o;}
@vertex fn vs(i:VI)->VO{let m=mat4x4f(i.m0,i.m1,i.m2,i.m3);var w=m*vec4f(i.pos,1.);
 if(i.col.a<-2.5){
  // new-engine bunker sand (lip.js bunkerGeometry): uv.y = distance from the outline. Edge exactly 2 in below the turf, then a
  // rounded bowl (quadratic ease) down to 2 in + 28 cm over 1.6 m.
  let g=groundH(w.xz);let x=min(i.uv.y/1.6,1.);w.y=g-.0508-.28*(1.-(1.-x)*(1.-x));
 }else if(M.params.z>.5&&M.params.z<1.5){w.y+=reliefAt(w.xz)-bunkerSink(w.xz)-seabedDrop(w.xz);}   // course ground mesh (map view)
 if(M.pad.z>7.5&&M.pad.z<8.5){let d=distance(w.xyz,F.camPos.xyz);let el=abs(normalize(F.camPos.xyz-w.xyz).y);w=vec4f(w.xyz+i.nrm*max(.004,d*F.res.w*1.)/max(el,.2)+normalize(F.camPos.xyz-w.xyz)*min(d*.012,.1),1.);}   // pulled a hair toward the eye so the terrain's own LOD triangles never cut through it   // green grid ribbon: ~1.5 px wide at any range
 var o:VO;o.pos=F.viewProj*w;o.wp=w.xyz;
 o.n=normalize((m*vec4f(i.nrm,0.)).xyz);o.uv=i.uv;o.col=i.col;
 if(i.col.a<-2.5){let e=.12;let q=w.xz;let gg=vec2f(groundH(q+vec2f(e,0.))-groundH(q-vec2f(e,0.)),groundH(q+vec2f(0.,e))-groundH(q-vec2f(0.,e)))/(2.*e);
  let x=min(i.uv.y/1.6,1.);let slope=gg-i.nrm.xz*(.28*2.*(1.-x)/1.6);o.n=normalize(vec3f(-slope.x,1.,-slope.y));}   // sand: ground slope + bowl slope (analytic)
 return o;}
fn isWater(p:vec3f)->f32{let sm=surfMask(p.xz);return max(smoothstep(.35,.65,sm.b),1.-smoothstep(F.box.w+.15,F.box.w+.6,p.y));}
${GA}// Matted mown turf: flat-lying leaf strokes, crisscrossing, with height -> normal, gap occlusion and a waxy sheen.
// Evaluated per pixel on the terrain itself (no extra geometry, so it follows every slope exactly).
const TURF_DEPTH=2.4;const TURF_HQ=36.6;   // 40 yd: full small-blade turf detail inside this camera distance
const LIP_W=.065;   // exposed soil band at bunker edges (m) — 2.5 in
const GREEN_TINT=vec3f(1.22,.97,1.42);const TEE_TINT=vec3f(1.24,1.,.94);   // measured vs reference photos (R:G:B ≈ .8:1:.37)
// baked leaf tile: blend the two nearest of the 4 baked grain directions (grain is pi-periodic); gradients = footprint (mips)
fn leafTap(q:vec2f,gx:vec2f,gy:vec2f,ang:f32)->vec4f{let lf=ang/.7853982;let l0=floor(lf);let t=smoothstep(.3,.7,lf-l0);let i0=i32(l0)%4;let i1=(i0+1)%4;
 let k=.8/${LEAF_P.toFixed(1)};let q0=q*(1./${LEAF_P.toFixed(1)});
 // the baked tile has 4 grain directions 45 deg apart; the grain drifts over ~50 m, so a pixel sits on one direction (one
 // anisotropic tap) and only the bands between two directions blend both
 if(t<=0.){return textureSampleGrad(leafTex,linSamp,q0,i0,gx*k,gy*k);}if(t>=1.){return textureSampleGrad(leafTex,linSamp,q0,i1,gx*k,gy*k);}
 return mix(textureSampleGrad(leafTex,linSamp,q0,i0,gx*k,gy*k),textureSampleGrad(leafTex,linSamp,q0,i1,gx*k,gy*k),t);}   // gradients x.8: a touch sharper than box-filtered (the fade below handles the far field)
// A/B reference (profiler bit 20): the original per-pixel procedural leaves (18 candidates x up to 3 layers per pixel)
fn turfDetailProc(xz:vec2f,g:f32,px:f32)->Turf{
 let grain=normalize(vec2f(cos(.6+tn(xz*.02).r*2.),sin(.6+tn(xz*.02).r*2.)));
 let cell=mix(.011,.0075,g);let fw=px/cell;
 var o:Turf;o.col=0.;o.n=vec2f(0);o.ao=.86;o.sheen=0.;o.hue=.5;
 let wFine=1.-smoothstep(.22,.75,fw);
 if(wFine>.001){var a=leafLayer(xz/cell,0.,grain,0);
  if(fw>.12){let o1=px*.35;let b1=leafLayer((xz+vec2f(o1,-o1*.5))/cell,0.,grain,0);a.n=(a.n+b1.n)*.5;a.ao=(a.ao+b1.ao)*.5;a.sheen=(a.sheen+b1.sheen)*.5;a.hue=(a.hue+b1.hue)*.5;}
  a.ao=clamp(.86+(a.ao-.86)*TURF_DEPTH,.08,1.25);o.n=a.n*wFine;o.ao=mix(o.ao,a.ao,wFine);o.sheen=a.sheen*wFine;o.hue=mix(.5,a.hue,wFine);}
 let cc=cell*5.;let wC=1.-smoothstep(.2,.7,px/cc);
 if(wC>.001){let b=leafLayer(xz/cc,11.,grain,0);o.ao*=mix(1.,.9+.1*b.ao/1.,wC);o.hue=mix(o.hue,mix(o.hue,b.hue,.35),wC);o.n+=b.n*.35*wC*(1.-wFine);}
 return o;}
fn turfDetail(xz:vec2f,g:f32,px:f32,dx:vec2f,dy:vec2f,dist:f32)->Turf{
 if(pk(20u)){return turfDetailProc(xz,g,px);}
 let ang=.6+tn(xz*.02).r*2.;   // grain direction (radians, in [.6, 2.6] so it needs no wrap)
 let cell=mix(.011,.0075,g);let fw=px/cell;
 var o:Turf;o.col=0.;o.n=vec2f(0);o.ao=.86;o.sheen=0.;o.hue=.5;
 // Pre-filtered detail: the leaf pattern is a mipmapped texture sampled over the pixel footprint (hardware trilinear +
 // anisotropic), then faded to its average before it can alias.
 // The fine small-blade layer holds to 40 yd (36.6 m) from the camera; the mipmapped tile + anisotropic filtering does
 // the anti-aliasing, so no footprint fade inside that range (the old one gave way to the blurry 5x layer by ~3 m).
 let wFine=1.-smoothstep(TURF_HQ-4.,TURF_HQ,dist);
 if(wFine>.001){let a=leafTap(xz/cell,dx/cell,dy/cell,ang);let ao=clamp(.86+(a.z-.86)*TURF_DEPTH,.08,1.25);   // real turf: lit tips over near-black gaps; mean kept at .86 so the far fade has no seam
  o.n=(a.xy*2.-1.)*wFine;o.ao=mix(o.ao,ao,wFine);o.hue=mix(.5,a.w,wFine);}
 // coarser tufting/clumps keep the texture alive further out (same tile, offset, 5x scale)
 let cc=cell*5.;let wC=(1.-smoothstep(.2,.7,px/cc))*(1.-wFine);   // only beyond the HQ range
 if(wC>.001){let b=leafTap(xz/cc+vec2f(17.31,41.87),dx/cc,dy/cc,ang);o.ao*=mix(1.,.9+.1*b.z,wC);o.hue=mix(o.hue,mix(o.hue,b.w,.35),wC);o.n+=(b.xy*2.-1.)*.35*wC*(1.-wFine);}
 return o;}
// ---- bunker sand: raked rows that waver, scattered footprints, fine grain
// analytic gradient of sandH (rake rows: exact derivative of the cosine across the rows; grain: prefiltered noise gradients).
// Replaces 3 finite-difference evaluations (15 lod-0 noise taps of centimetre-period tiles) with 3 mipmapped taps + 3 plain ones.
fn sandGrad(xz:vec2f,fp:f32)->vec2f{
 let dirA=tn(xz*.006).r*2.4;let d=vec2f(cos(dirA),sin(dirA));let pd=vec2f(-d.y,d.x);let q=dot(xz,pd)+(tn(xz*.11).b-.5)*.05;
 let worn=smoothstep(.15,.7,tn(xz*.04).a);let k=6.2832/.045;
 let rows=pd*(-.5*sin(q*k)*k)*.0011*worn;
 let nL=f32(textureDimensions(noiseTex).x);let L=fp*nL;
 let grain=tnGrad(xz*.9,max(log2(L*.9),0.),0)*(.002*.9)+tnGrad(xz*7.,max(log2(L*7.),0.),1)*(.0028*7.)+tnGrad(xz*19.,max(log2(L*19.),0.),2)*(.0007*19.);
 return rows+grain;}
fn sandH(xz:vec2f)->f32{
 let dirA=tn(xz*.006).r*2.4;let d=vec2f(cos(dirA),sin(dirA));let q=dot(xz,vec2f(-d.y,d.x))+(tn(xz*.11).b-.5)*.05;
 let rake=.5+.5*cos(q/.045*6.2832);let rows=rake*.0011*smoothstep(.15,.7,tn(xz*.04).a);   // worn patches lose their rake marks
 let foot=0.;
 let grain=(tn(xz*.9).r-.5)*.002+(tn(xz*7.).g-.5)*.0028+(tn(xz*19.).b-.5)*.0007;
 return rows+foot+grain;}
fn sandDetail(xz:vec2f,g:f32,dist:f32)->vec4f{
 let rip=tn(xz*vec2f(.094,.031)).r*.5+tn(xz*.36).a*.5;var c=mix(vec3f(.78,.68,.49),vec3f(.88,.79,.6),rip)*.66;   /* measured bunker-sand reflectance ~.45-.55 */
 c*=.95+.08*(tn(xz*1.3).b);
 /* grain speckle: mixed quartz and darker grains read as salt-and-pepper within ~15 m, averaged out beyond */
 let gf=1.-smoothstep(6.,18.,dist);if(gf>0.){let nL=f32(textureDimensions(noiseTex).x);let fp=dist*F.res.w*1.4;   // mip-filtered: lod-0 taps of a 2 cm-period tile thrashed the texture cache
  c*=1.+gf*((tnd(xz*17.,max(log2(fp*nL*17.),0.)).r-.5)*.45+(tnd(xz*41.,max(log2(fp*nL*41.),0.)).g-.5)*.35);}
 // moist/darker sand toward the low middle, drier bright at the faces
 c*=mix(1.,.9,smoothstep(.85,1.,g)*tn(xz*.02).r);
 // exposed dirt lip: 2-3 inch band just inside the edge, dark soil with roots/turf overhang
 return vec4f(c,0.);}
// ---- Grass canopy (hybrid mode): a parallax-occlusion-mapped height field of blade streaks, animated by the wind,
// stands in for individual blades wherever the view looks down onto the sward. Styles: 0 tufted, 1 windswept, 2 soft.
fn canopyH(q:vec2f,style:f32,t:f32)->f32{
 let wd=normalize(F.wind.xy+vec2f(1e-4));let gust=tn(q*.07-wd*t*.35).r;
 let sway=wd*(sin(t*1.9+dot(q,wd)*.9)*.5+gust)*mix(.012,.03,step(.5,style)*step(style,1.5));
 let p=q+sway;
 let lean=normalize(mix(vec2f(.8,.6),wd,select(.35,.9,style>.5&&style<1.5)));let pp=vec2f(-lean.y,lean.x);
 let sl=select(select(28.,34.,style>.5),20.,style>1.5);let ll=select(select(3.2,1.6,style>.5),4.5,style>1.5);
 let a=vec2f(dot(p,pp)*sl,dot(p,lean)*ll);
 let s1=tn(a*.11).r;let s2=tn(a*.23+vec2f(.37,.11)).g;
 var h=pow(max(s1*.62+s2*.38,0.),2.2)*1.7;
 let clump=tn(q*select(select(1.4,.9,style>.5),2.2,style>1.5)).b;
 h*=mix(.55,1.15,smoothstep(.25,.75,clump))*select(1.,.75,style>1.5);
 return clamp(h,0.,1.);}
struct Canopy{h:f32,n:vec3f,ao:f32}
fn canopy(p:vec3f,n:vec3f,style:f32,px:f32)->Canopy{var o:Canopy;if(px>=.03){o.h=.42;o.n=normalize(n);o.ao=.3+.7*pow(.42,.8);return o;}   /* detail fully faded (f = 0 below): the mean canopy, without the ~15 height evaluations of the march */let t=F.camPos.w;let H=select(.09,.06,style>1.5);
 let vd=normalize(F.camPos.xyz-p);let t1=normalize(cross(n,vec3f(0.,0.,1.)));let t2=cross(t1,n);
 let vt=vec3f(dot(vd,t1),dot(vd,t2),max(dot(vd,n),.12));
 // POM: march from the canopy top down along the view ray
 let N=10;var uv=vec2f(dot(p,t1),dot(p,t2));let dirT=-vt.xy/vt.z*H/f32(N);var layer=1.;var h=canopyH(p.xz,style,t);var prevH=h;var prevL=1.;
 for(var i=0;i<N;i++){if(h>=layer){break;}prevH=h;prevL=layer;uv+=dirT;layer-=1./f32(N);h=canopyH(p.xz+(uv-vec2f(dot(p,t1),dot(p,t2))).x*t1.xz+(uv-vec2f(dot(p,t1),dot(p,t2))).y*t2.xz,style,t);}
 let e=.01;let q=p.xz;let hx=canopyH(q+vec2f(e,0.),style,t)-canopyH(q-vec2f(e,0.),style,t);let hz=canopyH(q+vec2f(0.,e),style,t)-canopyH(q-vec2f(0.,e),style,t);
 // detail fades to its mean as streaks go sub-pixel (no whiskers, no plastic)
 let f=1.-smoothstep(.006,.03,px);
 o.h=mix(.42,h,f);o.n=normalize(n+(t1*-hx+t2*-hz)*H/(2.*e)*1.6*f);o.ao=mix(.62,.3+.7*pow(o.h,.8),1.);return o;}
// ---- Sward relief (rough + native cover): the tussock / clump structure individual blades can't carry past a few pixels.
// Seen from any height the rough reads as a lumpy canopy (the grass-to-landscape blend of UE's RVT / Ghost of Tsushima): rounded
// mounds (~0.3 m rough, ~0.8 m fescue stands) on a warped jittered lattice, bright sunlit tops, dark gaps, and the mounds' own
// shadows at low sun. Fades to its mean tone once a mound is a few pixels across (no aliasing, no whiskers).
// x: height 0..1, yz: gradient (m/m), w: self-shadow amount.
fn swardH(pw:vec2f)->vec4f{let ip=floor(pw);let fr=pw-ip;let o0=select(vec2f(0.),vec2f(-1.),fr<vec2f(.5));var sum=0.;var gs=vec2f(0.);var hue=0.;
 // soft union of rounded tussocks (1-exp(-sum)): neighbours merge into one fuzzy stand, gaps stay open. w: per-tussock tone.
 // Centres jitter within [.3,.7] and radii stay under .6 cell, so only the 2x2 cells on this quadrant's side can reach.
 for(var k=0;k<4;k++){let c=ip+o0+vec2f(f32(k&1),f32(k>>1));let hv=pcg(pcg(bitcast<u32>(i32(c.x))^0x9e37u)+bitcast<u32>(i32(c.y)));
  let r4=vec4f(f32(hv&255u),f32((hv>>8u)&255u),f32((hv>>16u)&255u),f32(hv>>24u))/255.;
  let dv=pw-(c+.3+.4*r4.xy);let r=.4+.2*r4.z;let d2=dot(dv,dv)/(r*r);
  if(d2<1.){let pk0=.7+.6*r4.w;let u=1.-d2;let w=pk0*u*u;sum+=w;gs+=-4.*pk0*u*dv/(r*r);hue+=w*fract(r4.w*7.31+r4.z*3.7);}}
 let e=exp(-sum*1.15);return vec4f(1.-e,gs*1.15*e,hue/max(sum,1e-4));}
fn sward(xz:vec2f,nat:f32,fp:f32)->vec4f{
 if(nat<.5){   // mown/semi rough: low clumps from the filtered fbm (one tap + its gradient), no self-shadow at 4 cm relief
  let T=2.8;let uv=xz/T;let lod=max(log2(fp*512./T),0.);let h=tnd(uv,lod).b;let g=tnGrad(uv,lod,2)/T*.04*1.6;swHue=h;return vec4f(clamp((h-.3)*1.6,0.,1.),g,0.);}
 let cell=1.05;let A=.16;let f=1.-smoothstep(.08,.25,fp/cell);
 if(f<=0.){swHue=.5;return vec4f(.45,0.,0.,0.);}
 let pw=xz/cell+(vec2f(tn(xz*.17).r,tn(xz*.17+vec2f(.37,.61)).g)-.5)*1.8;let m=swardH(pw);swHue=mix(.5,m.w,f);
 var sh=0.;let s=F.sunDir.xyz;let sl=length(s.xz);
 if(s.y>0.&&sl>1e-3){let r=.4;let ms=swardH(pw+s.xz/sl*r);sh=clamp(((ms.x-m.x)*A-r*cell*s.y/sl)/(A*.45),0.,1.);}
 return vec4f(mix(.45,m.x,f),m.yz*A/cell*f,sh*f);}
var<private> swHue:f32=.5;
// ---- Ground material, in stages. The same functions run in the forward shader below (debug views, map view, legacy
// ground meshes) and in the deferred terrain passes (backend: depth prepass -> sun/AO term passes -> material G-buffer ->
// ground detail -> lighting -> haze), each its own GPU pass so every effect's cost is its own GPU timestamp.
struct GB{alb:vec3f,n:vec3f,wat:f32,gEdge:f32,prelit:bool,pc:vec3f,gain:f32,msh:f32,nat:f32}   // nat: native-cover weight (-1 = not known: looked up); msh: sun shadow cast by the sward's own tussocks (0 = none; zero-initialised)
fn deepWater()->vec3f{return vec3f(.012,.03,.06)*(ambientSky(vec3f(0.,1.,0.))*.5+F.sunColor.rgb*.08);}
// base: albedo stack (baked material cache or exact), rough terms, native cover, water, macro normal noise.
// terr: CDLOD terrain pixel; strip: bunker-sand strip pixel; gao: ground AO map (1,0 when AO is off)
fn groundBase(wp:vec3f,nIn:vec3f,terr:bool,strip:bool,gao:vec2f)->GB{var g:GB;g.nat=-1.;g.n=nIn;g.prelit=false;g.pc=vec3f(0.);g.gEdge=0.;g.alb=vec3f(0.);
 var mc:MCS;mc.ok=false;mc.a=vec4f(0.);mc.b=vec4f(0.);if(terr&&F.mclip[7].x>.5){mc=matCache(wp.xz,distance(wp,F.camPos.xyz)*F.res.w*1.15);}   // CDLOD terrain: baked material (runtime virtual texture)
 var wq=wp;if(strip){if(wp.y<F.box.w+3.){wq.y=select(groundH(wp.xz),terrainH(wp.xz)*F.clip[7].w,F.clip[0].w>.5);}else{wq.y=wp.y+1.;}}   /* the height term only matters within .6 m of sea level: skip the 20-tap turf height above it */g.wat=isWater(wq);   // bunker sand sits below the turf: judge 'at sea level' by the turf height
 // fully submerged ground ends as flat deep-water colour whatever its material (exactly what the full path gives, wat = 1)
 if(g.wat>=1.&&!strip&&i32(F.skyHorizon.z+.5)==0){g.prelit=true;g.pc=deepWater();return g;}
 var gEdge=surfMask(wp.xz).g;if(strip){gEdge=max(gEdge,.52);}else if(bunkerNew(wp.xz)){gEdge=min(gEdge,.3);}g.gEdge=gEdge;   // new bunkers: any turf fragment left is pure turf, right up to the edge
 if(mc.ok){g.gain=mc.b.w*2.;}else{g.gain=-1.;}
 var alb:vec3f;if(mc.ok){alb=groundAlbedoView(mc.a.rgb*mc.a.rgb,wp,surfMask(wp.xz),kindAt(wp.xz));}else{alb=groundAlbedo(wp);}
 {let sm2=surfMask(wp.xz);let roughK=(1.-smoothstep(.3,.6,sm2.r))*(1.-smoothstep(.46,.5,gEdge));
   if(roughK>.001){   // rough-only terms (mean sward colour, AO dryness, matting sheen, clump mottle): skipped on fairways, tees, greens
    alb=mix(alb,roughAlb(alb,gao.y),roughK);alb*=mix(1.,.82+.18*gao.x,roughK);var mt=0.;if(mc.ok){mt=matToneMF(vec3f(mc.b.x*MAT_STRENGTH,normalize(mc.b.yz*2.-1.+vec2f(1e-5,0.))),wp);}else{mt=matTone(wp.xz,wp);}alb*=mix(1.,mt,roughK);
    let vv0=normalize(F.camPos.xyz-wp);let fp0=distance(wp,F.camPos.xyz)*F.res.w*1.5/sqrt(max(abs(vv0.y),.08));alb*=mix(1.,roughMottle(wp.xz,fp0),roughK);}}

 /* native cover (kind 8) seen beyond the blade range: the ground takes the stand's grey-green/olive tone and clumpy texture */
 if(surfMask(wp.xz).r<.6&&gEdge<.5){let q=wp.xz;var nat=mc.a.a;if(!mc.ok){let jw=(tn(q*.23).rg-.5)*4.+(tn(q*1.7).ba-.5)*1.4;nat=select(0.,1.,kindAt(q+jw)==8.)*(1.-smoothstep(.3,.6,surfMask(q).r));}
   if(i32(F.skyHorizon.z+.5)==23){g.prelit=true;g.pc=mix(vec3f(.2),vec3f(3.,.1,.1),nat);return g;}   /* 23: native cover (kind 8) in red */
   if(nat>0.){   // footprint-filtered (mip lod from the pixel's size) and contrast-stretched: the flat olive plateau read as posterized
    let fpn=distance(wp,F.camPos.xyz)*F.res.w*1.5/sqrt(max(abs(normalize(F.camPos.xyz-wp).y),.08));let nL=f32(textureDimensions(noiseTex).x);
    let cl=smoothstep(.28,.72,tnd(q*.9,max(log2(fpn*nL*.9),0.)).r*.35+tnd(q*3.1,max(log2(fpn*nL*3.1),0.)).g*.25+tnd(q*.045+vec2f(.13,.57),max(log2(fpn*nL*.045),0.)).b*.4);   // + 1-3 m clumps that still read at 100 m
    let nc=mix(vec3f(.075,.095,.045),vec3f(.2,.2,.11),cl)*mix(1.,1.25,smoothstep(.72,.84,tnd(q*2.3,max(log2(fpn*nL*2.3),0.)).b))*roughMottle(q,fpn);alb=mix(alb,nc,nat*.85);}}  
 alb=mix(alb,vec3f(.02,.05,.09),g.wat);let mn=tn(wp.xz*.19).gb-.5;g.n=normalize(g.n+vec3f(mn.x,0.,mn.y)*.25*(1.-smoothstep(1.5,5.,distance(wp,F.camPos.xyz)*F.res.w*1.4*.19)));  
 g.alb=alb;return g;}
// detail (the Ground detail effect): relief, rough canopy, turf leaves, sand grain + rake. dWx/dWy: world-xz footprint of a pixel
fn groundDetail(wp:vec3f,gIn:GB,isGrid:bool,dWx:vec2f,dWy:vec2f)->GB{var g=gIn;var alb=g.alb;var n=g.n;let gEdge=g.gEdge;
 if(!isGrid&&!pk(10u)){let e=.35;let rx=reliefAt(wp.xz+vec2f(e,0.))-reliefAt(wp.xz-vec2f(e,0.));let rz=reliefAt(wp.xz+vec2f(0.,e))-reliefAt(wp.xz-vec2f(0.,e));n=normalize(n+vec3f(-rx,0.,-rz)/(2.*e));}
 if(F.skyHorizon.x>.5&&!pk(8u)){let sm3=surfMask(wp.xz);let rk=(1.-smoothstep(.3,.6,sm3.r))*(1.-smoothstep(.46,.5,gEdge))*(1.-g.wat);
   if(rk>.01){let pxc=distance(wp,F.camPos.xyz)*F.res.w*1.4;let cp=canopy(wp,n,F.skyHorizon.y-select(0.,100.,F.skyHorizon.y>=50.),pxc);
    // tone matched to the blades: dark roots, sun-dried tips, same ground-lit shading
    let tip=alb*vec3f(1.22,1.16,.82);let root=alb*vec3f(.55,.62,.5);
    alb=mix(alb,mix(root,tip,cp.h)*cp.ao*1.12,rk);n=normalize(mix(n,cp.n,rk));}}
 if(!pk(8u)){let smr=surfMask(wp.xz);let rk=(1.-smoothstep(.3,.6,smr.r))*(1.-smoothstep(.46,.5,gEdge))*(1.-g.wat);
  if(rk>.01){let q=wp.xz;var nat=g.nat;if(nat<0.){let jw=(tn(q*.23).rg-.5)*4.+(tn(q*1.7).ba-.5)*1.4;nat=select(0.,1.,kindAt(q+jw)==8.)*(1.-smoothstep(.3,.6,smr.r));}
   let fpx=distance(wp,F.camPos.xyz)*F.res.w*1.5;let sw=sward(q,nat,fpx);
   n=normalize(n+vec3f(-sw.y,0.,-sw.z)*rk);
   let lo=mix(.88,.74,nat);let hi=mix(1.06,1.16,nat);alb*=mix(1.,mix(lo,hi,sw.x)/(lo+(hi-lo)*.45),rk);   // gaps a little darker, tops lit; mean tone unchanged
   // tussock-to-tussock tone: some greener, some sun-bleached (the stand is never one flat colour)
   alb*=mix(vec3f(1.),mix(vec3f(.9,1.04,.92),vec3f(1.12,1.04,.86),swHue),rk*mix(.5,1.,nat));
   // blade texture on the tussocks: fine streaks along the wind, footprint-filtered (averages to 1 when sub-pixel)
   {let nL=512.;let wd=normalize(F.wind.xy+vec2f(.8,.6));let a2=vec2f(dot(q,vec2f(-wd.y,wd.x))*14.,dot(q,wd)*5.);let lf=max(log2(fpx*nL*14.),0.);
    alb*=mix(1.,.86+.28*tnd(a2,lf).a,rk*nat);}
   alb=mix(alb,alb*vec3f(1.22,1.14,.82),sw.x*nat*.55*rk);         // fescue tussock tops sun-dried straw
   g.msh=max(g.msh,sw.w*rk*.6);}}
 var smk=surfMask(wp.xz);smk.g=gEdge;
 let gq=smoothstep(.71,.79,smk.a);let fringe=smoothstep(.2,.3,smk.a)*(1.-gq);
  // .5 in the green channel marks the collar
  let turfW=smoothstep(.38,.62,smk.r)*(1.-smoothstep(.38,.62,smk.g));
  if(turfW>.01&&!pk(7u)){let vv=normalize(F.camPos.xyz-wp);let px=distance(wp,F.camPos.xyz)*F.res.w*1.4/sqrt(max(abs(dot(vv,n)),.08));let pick=step(fract(sin(dot(floor(wp.xz*55.),vec2f(12.9898,78.233)))*43758.5),gq);let td=turfDetail(wp.xz,select(.25,1.,pick>.5),px,dWx,dWy,distance(wp,F.camPos.xyz));
   // tangent frame on the actual slope so detail never fights the terrain
   let t1=normalize(cross(n,vec3f(0.,0.,1.)));let t2=cross(t1,n);
   n=normalize(mix(n,normalize(n+(t1*td.n.x*-1.+t2*td.n.y)*(1.+.6*fringe)),turfW));
   // collar: slightly longer, denser sward -> deeper occlusion and a touch darker/richer than the putting surface
   let aoF=mix(td.ao,td.ao*(.9+.1*td.ao),fringe);
   // as blade detail fades, keep the turf alive with larger-scale mottling and mown-grain sheen instead of a flat plastic tone
   {let fd=smoothstep(TURF_HQ-4.,TURF_HQ,distance(wp,F.camPos.xyz))*smoothstep(.15,1.2,px/mix(.011,.0075,smk.a));if(fd>0.){let q=wp.xz;
    let mot=tn(q*.62).r*.45+tn(q*2.1+vec2f(.3,.1)).g*.35+tn(q*.17).b*.2;
    let gr=normalize(vec2f(cos(.6+tn(q*.02).r*2.),sin(.6+tn(q*.02).r*2.)));let vdir=normalize(wp.xz-F.camPos.xz);
    let sheenV=dot(gr,vdir);
    alb*=mix(1.,1.+(mot-.5)*.34+sheenV*.07,fd*turfW);}
    }alb*=mix(vec3f(1.),(.66+.68*td.hue)*aoF*mix(vec3f(.94,1.,1.08),vec3f(1.14,1.07,.78),smoothstep(.45,1.,td.hue)),turfW);/* wider leaf-to-leaf tone; sunlit tips go yellow-green, lower leaves bluer */alb*=mix(1.,1.1,turfW*gq*.5);alb*=mix(vec3f(1.),mix(TEE_TINT,GREEN_TINT,gq),turfW);/* greens/tees rendered near-zero blue (R:G:B .6:1:.12) vs photos .8:1:.37 */alb*=mix(1.,.97,fringe*turfW);}
  
 if(smk.g>.3&&!pk(6u)){let sd=sandDetail(wp.xz,smk.g,distance(wp,F.camPos.xyz));
   // Bunker lip: the detail mask stores the sand edge as a signed distance (g=.5 at the edge, ±.6 m ramp), so a fixed
   // 2.5 in (6.5 cm) band of exposed soil sits between the turf and the sand everywhere.
   let sdm=(smk.g-.5)*1.2;let sandW=smoothstep(-.002,.004,sdm);let band=0.;   /* no flat soil band on the turf: soil is only the vertical wall */
   if(band>.001){let q=wp.xz;let cr=tn(q*38.).r*.6+tn(q*11.).g*.4;var soil=mix(vec3f(.2,.135,.08),vec3f(.35,.255,.16),cr);
    soil*=1.-.45*smoothstep(.7,.9,tn(q*57.+3.).a);                                   // root threads and dark crumbs
    soil*=mix(.45,1.,smoothstep(-LIP_W,-LIP_W+.014,sdm));                            // shadow line under the overhanging turf mat
    soil=mix(soil,vec3f(.55,.48,.36),smoothstep(-.01,0.,sdm)*.3*(.6+.4*tn(q*23.).b)); // sand splashed onto the face
    alb=mix(alb,soil,band);n=normalize(n+vec3f(tn(q*29.).r-.5,0.,tn(q*29.+7.).g-.5)*.35*band);}
   alb=mix(alb,sd.xyz,sandW);
   let fade=(1.-smoothstep(.006,.016,distance(wp,F.camPos.xyz)*F.res.w*1.4/sqrt(max(abs(dot(normalize(F.camPos.xyz-wp),n)),.1))))*smoothstep(.5,.6,smk.g);   // rake rows only while resolvable, and only on the sand itself
   if(fade>0.){let gh=sandGrad(wp.xz,distance(wp,F.camPos.xyz)*F.res.w*1.4);n=normalize(n+vec3f(-gh.x,0.,-gh.y)*fade);}
   // lip wall: steep face of the cut, tilted toward the bunker interior
   let lipW=0.;if(lipW>.01){let ge=.3;let gx=surfMask(wp.xz+vec2f(ge,0.)).g-surfMask(wp.xz-vec2f(ge,0.)).g;let gz=surfMask(wp.xz+vec2f(0.,ge)).g-surfMask(wp.xz-vec2f(0.,ge)).g;
    let gd=vec2f(gx,gz);if(dot(gd,gd)>1e-6){let g2=normalize(gd);n=normalize(mix(n,normalize(vec3f(g2.x,.9,g2.y)),lipW*.6));}}}
 g.alb=alb;g.n=n;return g;}
// lighting: surface parameters from the masks, measured per-surface reflectance, the shared lighting engine, water
// Green-reading grid (PGA 2K style, kept quiet): a 3 ft lattice squared to the line from the ball to the pin, draped on the
// green. Thin lines (~1.5 px at any distance, faded out before they crowd), tinted by the local grade (white = flat, then
// yellow, amber, coral past ~3%), with soft pulses running downhill along them so the break reads at a glance.
fn puttGrid(p:vec3f,c:vec3f)->vec3f{let a=F.putt.w;if(a<.004){return c;}let onG=smoothstep(.22,.4,surfMask(p.xz).a);if(onG<=0.){return c;}
 let cd=distance(p,F.camPos.xyz);let fp=cd*F.res.w*1.25;const S=.9144;let lod=smoothstep(6.,12.,S/max(fp,1e-4));if(lod<=0.){return c;}
 let ax=vec2f(cos(F.putt.z),sin(F.putt.z));let ay=vec2f(-ax.y,ax.x);let q=p.xz-F.putt.xy;let u=dot(q,ax);let v=dot(q,ay);
 let du=abs(fract(u/S+.5)-.5)*S;let dv=abs(fract(v/S+.5)-.5)*S;let w=fp*.7;
 let lu=1.-smoothstep(w*.4,w*1.4,du);let lv=1.-smoothstep(w*.4,w*1.4,dv);if(max(lu,lv)<.002){return c;}
 let n=terrainN(p.xz,max(fp,.35));let down=vec2f(n.x,n.z)/max(n.y,.3);let grade=length(down)*100.;   // % slope, downhill direction
 let t=F.camPos.w;let sp=clamp(length(down)*28.,.12,1.1);
 // pulses: along a line of constant u the ball would roll along v, and vice versa; they travel whichever way is downhill
 let pv=.55+.45*smoothstep(.72,1.,fract((v-sign(dot(down,ay))*t*sp)/1.8));let pu=.55+.45*smoothstep(.72,1.,fract((u-sign(dot(down,ax))*t*sp)/1.8));
 let col=mix(mix(vec3f(.93,.96,.9),vec3f(.98,.92,.58),smoothstep(.8,1.8,grade)),mix(vec3f(1.,.72,.38),vec3f(1.,.47,.33),smoothstep(3.,4.5,grade)),smoothstep(1.8,3.,grade));
 let k=a*onG*lod*max(lu*pv,lv*pu)*.6;let L=dot(c,vec3f(.2126,.7152,.0722));
 return mix(c,col*max(L*2.6,.003),k);}
fn groundLight(wp:vec3f,g:GB,strip:bool,vis:f32,ao:f32,gain:f32)->vec3f{
 var S:LitSurf;S.p=wp;S.n=g.n;S.alb=g.alb;S.vis=vis;S.ao=ao;
 let smk2=surfMask(wp.xz);let sand=select(smoothstep(.45,.55,smk2.g),1.,strip)*(1.-g.wat);let mown=smoothstep(.38,.62,smk2.r)*(1.-sand);
 S.alb*=gain;   // measured per-surface reflectance (albedo); 1 on the sand strip
 S.rough=mix(mix(.78,.6,mown),.93,sand);S.f0=mix(.035,.04,sand);S.canopy=(1.-sand)*(1.-g.wat);S.trans=mix(.12,.06,mown)*(1.-sand);
 var c=shade(S);   /* green-reading grid: draped overlay mesh (putt-grid.js), no longer shaded into the ground */if(g.wat>.9){return mix(c,deepWater(),smoothstep(.9,1.,g.wat));}return c;}   // deepWater() evaluates the sky ambient: only where it shows


// ---- hero-object shading (clubs, ball, flagstick, tee markers): metals take their colour into the specular, clear-coated
// plastics/paint get a second tight lobe, and reflections see the ground below the horizon (the sky LUT alone mirrored the
// sky into the lower half of every chrome surface).
fn envRefl(r:vec3f,rough:f32)->vec3f{let ru=normalize(vec3f(r.x,max(r.y,.02),r.z));let up=clouds(ru,skyColor(ru));   // the cloud deck is part of what chrome mirrors
 let gnd=vec3f(.075,.105,.05)*(F.sunColor.rgb*max(F.sunDir.y,0.)*.9+(ambL(1u)+ambL(2u)+ambL(3u)+ambL(4u))*.25*2.4);   // lit turf radiance (matches how the ground itself shades)   // sunlit turf seen in the reflection
 let e=mix(up,gnd,1.-smoothstep(-.1-rough*.35,.03+rough*.25,r.y));
 let side=(ambL(1u)+ambL(2u)+ambL(3u)+ambL(4u))*.25;let cov=F.skyZenith.w;let zen=mix(ambL(0u),vec3f(dot(side,vec3f(.33)))*2.2,cov*.6);let hemi=mix(mix(gnd,side,smoothstep(-.6,0.,r.y)),mix(side,zen,smoothstep(0.,.8,r.y)),step(0.,r.y));   // cosine-blurred environment
 return mix(e,hemi*1.15,smoothstep(.08,.55,rough));}   // satin and brushed metals see a blurred sky, not a mirror of the zenith
fn qrot(q:vec4f,v:vec3f)->vec3f{let t=2.*cross(q.xyz,v);return v+q.w*t+cross(q.xyz,t);}
fn shadeObj(S:LitSurf,metal:f32,coat:f32)->vec3f{let v=normalize(F.camPos.xyz-S.p);let n=S.n;let s=F.sunDir.xyz;let h=normalize(v+s);
 let nl=max(dot(n,s),0.);let nv=max(dot(n,v),.02);let vh=max(dot(v,h),0.);let nh=max(dot(n,h),0.);
 let sun=F.sunColor.rgb*S.vis*smoothstep(-.02,.02,s.y);
 let tint=S.alb;let f0=mix(vec3f(.04),tint,metal);let a=max(S.rough*S.rough,.003);let m5=pow(1.-vh,5.);let Fh=f0+(1.-f0)*m5;
 var D=S;D.f0=.04;let od=shadeSplit(D);
 var c=S.alb*(1.-metal)*od.d+sun*Fh*dGGX(nh,a)*vSmith(nv,nl,a)*nl*PI;
 let r=reflect(-v,n);let mv=pow(1.-nv,5.);let Fe=f0+(max(vec3f(1.-S.rough),f0)-f0)*mv;
 c+=envRefl(r,S.rough)*Fe*S.ao;
 if(coat>0.){let ac=.0025;let Fc=.04+.96*m5;let Fce=.04+.96*mv;
  c=c*(1.-coat*Fce)+coat*(sun*Fc*dGGX(nh,ac)*vSmith(nv,nl,ac)*nl*PI+envRefl(r,.03)*Fce*S.ao);}
 return c;}
// Golf ball: dimple height (r) + printed ink (g) in an octahedral map of the ball's own directions (renderer.js bakes it at
// load, projecting the game name onto it). Normals come from the height gradient, so ink follows the dimples. When the ball
// spins faster than the shutter can freeze, the pattern is averaged along the arc it sweeps during the frame (motion blur).
fn ballOct(d:vec3f)->vec2f{let a=d/(abs(d.x)+abs(d.y)+abs(d.z));var p=a.xy;if(a.z<0.){p=(1.-abs(a.yx))*select(vec2f(-1.),vec2f(1.),a.xy>=vec2f(0.));}return p*.5+.5;}
fn ballTap(d:vec3f,lod:f32)->vec3f{return textureSampleLevel(mapTex,linSamp,ballOct(d),lod).rgb;}
fn rotAx(v:vec3f,k:vec3f,t:f32)->vec3f{let c=cos(t);let s=sin(t);return v*c+cross(k,v)*s+k*dot(k,v)*(1.-c);}
struct BallS{n:vec3f,ink:f32,red:f32,cav:f32}
fn ballSurf(wp:vec3f,nw:vec3f)->BallS{let q=M.e2;let d0=normalize(qrot(q,normalize(wp-M.e1.xyz)));
 let fp=distance(wp,F.camPos.xyz)*F.res.w;   // metres per pixel
 let tex=f32(textureDimensions(mapTex).x);let lod=max(log2(fp/M.e1.w*tex*.35),0.);   // texels per pixel on the octahedral map
 let det=M.e0.w*(1.-smoothstep(3.,6.5,lod))*(1.-.8*smoothstep(1.,3.,M.pad.w));   // a fast-spinning ball smears its dimples into bands
 let t1=normalize(cross(d0,select(vec3f(0.,1.,0.),vec3f(1.,0.,0.),abs(d0.y)>.9)));let t2=cross(d0,t1);
 let e=max(2.2/tex,fp/M.e1.w*.6);
 let arc=M.pad.w;let ax=M.e0.xyz;let N=select(1,select(7,12,arc>1.5),arc>.12);
 var g=vec2f(0.);var ink=0.;var red=0.;var cav=0.;
 for(var i=0;i<N;i++){let t=select(0.,(f32(i)/f32(N-1)-.5)*min(arc,6.2832),N>1);let d=rotAx(d0,ax,t);let a=rotAx(t1,ax,t);let b=rotAx(t2,ax,t);
  let h0=ballTap(d,lod);let ha=ballTap(normalize(d+a*e),lod).r;let hb=ballTap(normalize(d+b*e),lod).r;
  g+=vec2f(ha-h0.r,hb-h0.r)/e;ink+=h0.g;red+=h0.b*h0.g;cav+=1.-h0.r;}
 g/=f32(N);ink/=f32(N);cav/=f32(N);red/=max(ink*f32(N),1e-4);
 let k=.018*det;   // dimple depth relative to the radius (0.25 mm on a 21.3 mm ball) -> slope
 let no=normalize(d0-(t1*g.x+t2*g.y)*k);
 var o:BallS;o.n=normalize(qrot(vec4f(-q.xyz,q.w),no));o.ink=ink;o.red=red;o.cav=cav*det;
 if(det<=0.){o.n=nw;}return o;}
// Cup interior (special 'cup'): the disc on the green traces the view ray into the hole. e1 = rim centre + radius,
// e2.x = depth, e2.y = flagstick radius (0 when pulled), e0 = ball centre + radius (0 unless it is in the hole).
fn cupShade(wp:vec3f)->vec3f{let c=M.e1.xyz;let R=M.e1.w;let D=M.e2.x;let rd=normalize(wp-F.camPos.xyz);let q=wp.xz-c.xz;
 let a=max(dot(rd.xz,rd.xz),1e-8);let b=dot(q,rd.xz);let cc=dot(q,q)-R*R;let tw=(-b+sqrt(max(b*b-a*cc,0.)))/a;
 let tb=(wp.y-(c.y-D))/max(-rd.y,1e-4);var t=min(tw,tb);var h=wp+rd*t;var n=select(vec3f(0.,1.,0.),normalize(vec3f(c.x-h.x,0.,c.z-h.z)),tw<tb);
 let depth0=c.y-h.y;var alb=select(vec3f(.07,.06,.045),vec3f(.78,.78,.74),depth0<.028&&tw<tb);var metal=false;
 let pr=M.e2.y;if(pr>0.){let qp=wp.xz-c.xz;let bp=dot(qp,rd.xz);let cp=dot(qp,qp)-pr*pr;let dp=bp*bp-a*cp;if(dp>0.){let tp=(-bp-sqrt(dp))/a;if(tp>0.&&tp<t){t=tp;h=wp+rd*t;n=normalize(vec3f(h.x-c.x,0.,h.z-c.z));alb=vec3f(.7,.72,.74);metal=true;}}}
 let br=M.e0.w;if(br>0.){let oc=wp-M.e0.xyz;let bb=dot(oc,rd);let c2=dot(oc,oc)-br*br;let d2=bb*bb-c2;if(d2>0.){let ts=-bb-sqrt(d2);if(ts>0.&&ts<t){t=ts;h=wp+rd*t;n=normalize(h-M.e0.xyz);alb=vec3f(.8,.8,.77);metal=false;}}}
 let depth=max(c.y-h.y,0.);let s=F.sunDir.xyz;
 // sun reaches h only if the ray toward it leaves through the opening
 let tt=depth/max(s.y,.02);let ex=h.xz+s.xz*tt-c.xz;let lit=(1.-smoothstep(R*.96,R*1.02,length(ex)))*step(0.,s.y);
 let sky=exp(-depth*20.)*(.6+.4*max(n.y,0.))+.015;   // the opening's solid angle shrinks fast with depth
 let amb=(ambL(0u)+ambL(1u)+ambL(2u)+ambL(3u)+ambL(4u))*.2;
 var col=alb*(F.sunColor.rgb*max(dot(n,s),0.)*lit*sunVis(c+vec3f(0.,.02,0.),vec3f(0.,1.,0.))+amb*sky);
 if(metal){col+=envRefl(reflect(rd,n),.1)*.6*sky;}
 return col;}
@fragment fn fs(v:VO,@builtin(front_facing) ff:bool)->@location(0) vec4f{
 if(SEA){return vec4f(fogApplyLite(deepWater(),v.wp),1.);}
 let dWx=dpdx(v.wp.xz);let dWy=dpdy(v.wp.xz);gDX=dWx;gDY=dWy;   // footprint for the baked turf detail (taken here, in uniform control flow)
 var alb=M.color.rgb;var a=M.color.a;
 if(M.params.x>.5&&abs(M.pad.z-1.)>.5){let t=textureSample(mapTex,linSamp,v.uv);alb*=t.rgb;a*=t.a;}
 if(M.params.w>.5){alb*=v.col.rgb;}
 if(M.params.y>0.&&a<M.params.y){discard;}
 let mode=M.params.z;
 var n=normalize(v.n);if(!ff&&!(mode>.5&&mode<1.5)){n=-n;}   /* ground is a heightfield: its normal always faces up, whatever the winding of the sink/strip meshes */
 if(v.col.a<-1.1&&v.col.a>-1.4){n=terrainN(v.wp.xz,distance(v.wp,F.camPos.xyz)*F.res.w*1.15);}   // CDLOD terrain: exact cached surface normal per pixel, prefiltered to the footprint
 if(CUT&&mode>.5&&mode<1.5&&v.col.a>-2.5&&bunkerHole(v.wp.xz)){discard;}   // turf is cut out along the bunker outline (new-engine bunkers)
 if(mode>1.5&&mode<2.5&&M.pad.z>7.5&&M.pad.z<8.5){   // green-reading grid ribbon: AA edges, fade once thinner than a pixel, downhill pulses
  let aw=fwidth(v.uv.y);let aa=1.-smoothstep(1.-2.2*aw,1.,abs(v.uv.y));let fp=distance(v.wp,F.camPos.xyz)*F.res.w;let thin=clamp(.014/max(fp,1e-5)/1.4,0.,1.);
  let sp=mix(.35,1.3,v.col.a);let pulse=.5+.5*smoothstep(.7,1.,fract((v.uv.x-F.camPos.w*sp)/1.8));
  return vec4f(fogApply(v.col.rgb*.9*pulse,v.wp),M.color.a*aa*mix(.6,1.,thin)*mix(.75,1.,pulse));}
 if(mode>1.5&&mode<2.5){return vec4f(fogApply(alb+M.emissive.rgb,v.wp),a);}   // unlit overlay (alpha used by the blended overlay pipeline)
 if(GROUND&&mode>.5&&mode<1.5){let wp=v.wp;let strip=v.col.a<-2.5;let terr=v.col.a<-1.1&&v.col.a>-1.4;let isGrid=v.col.a<-.5;
  var gao=vec2f(1.,0.);if(!pk(9u)){gao=groundAO(wp.xz);}
  var g=groundBase(wp,n,terr,strip,gao);
  if(g.prelit){if(i32(F.skyHorizon.z+.5)==23){return vec4f(g.pc,1.);}return vec4f(fogApply(g.pc,wp),1.);}
  g=groundDetail(wp,g,isGrid,dWx,dWy);n=g.n;alb=g.alb;let wat=g.wat;
  var S:LitSurf;S.ao=gao.x*nearAO(wp);S.vis=sunVis(wp,n);let s=F.sunDir.xyz;let ndl=max(dot(n,s),0.);
  let c=groundLight(wp,g,strip,S.vis,S.ao,select(surfGain(wp.xz),1.,strip));
  if(i32(F.skyHorizon.z+.5)==24){return vec4f(n*.5+.5,1.);}   /* 24: final shading normal */
 if(i32(F.skyHorizon.z+.5)==22){let sky=skyLight(n,S.ao);let bounce=bounceLight(n)*S.ao;return vec4f(ndl,sky.g*.6,length(bounce)*4.,1.);}   /* (evaluated here only: it was computed for every pixel) */   /* 22: r=N.L g=sky b=bounce */
 if(i32(F.skyHorizon.z+.5)==20){return vec4f(terrainShadowCached(wp),objShadow(wp,n)*cloudShadow(wp),contactShadow(wp,n),1.);}   /* 20: sun shadow terms r=terrain g=objects*clouds b=contact */
 if(i32(F.skyHorizon.z+.5)==21){return vec4f(gao.x,nearAO(wp),gao.x*nearAO(wp),1.);}   /* 21: ground AO r=map g=near-field b=product */
 if(i32(F.skyHorizon.z+.5)==18){return vec4f(normalize(v.n)*.5+.5,1.);}   /* 18: interpolated vertex normal */
 if(i32(F.skyHorizon.z+.5)==19){return vec4f(select(alb,vec3f(1.,0.,1.),v.col.a<-2.5&&fract(wp.x*.5)<.5),1.);}   /* 19: terrain albedo */
 if(i32(F.skyHorizon.z+.5)==17){let er=wp.y-surfY(wp.xz);return vec4f((select(vec3f(.3),vec3f(3.,0.,0.),er>.01)+select(vec3f(0.),vec3f(0.,0.,3.),er<-.01))*select(vec3f(1.),vec3f(.4,1.6,.4),v.col.a<-1.5),1.);}   /* edge strip tinted green *//* 17: mesh vs true surface height error (red: mesh above, blue: below) */
 if(i32(F.skyHorizon.z+.5)==13){return vec4f(.4,.02,.02,1.);}if(i32(F.skyHorizon.z+.5)==14){return vec4f(vec3f(matField(wp.xz).x),1.);}if(i32(F.skyHorizon.z+.5)==15){return vec4f(surfClassColor(wp.xz),1.);}if(i32(F.skyHorizon.z+.5)==16){return vec4f(select(vec3f(0.,.2,3.),vec3f(3.,.2,0.),isGrid),1.);}   /* dense camera grid = red, coarse terrain = blue */   // visual debug: surfaces red (grass blue)

  return vec4f(fogApply(c,wp),1.);}
 if(mode>3.5){ // buildings: per-house stucco tone, dark roofs, window bands, grounded contact darkening
   let id=floor(v.wp.xz/9.);let hv=hash21(id);let wall=mix(vec3f(.5,.47,.41),vec3f(.64,.62,.57),hv);   /* measured stucco reflectance (~.45-.65), not paper white */let wallB=mix(wall,vec3f(.62,.55,.45),step(.7,hash21(id+3.)));
   let roof=mix(vec3f(.16,.15,.14),vec3f(.36,.2,.14),step(.6,hash21(id+7.)));
   let up=smoothstep(.45,.75,abs(n.y));alb=mix(wallB,roof,up);
   let gy=v.wp.y-groundH(v.wp.xz);let along=dot(v.wp.xz,normalize(vec2f(-n.z,n.x)+vec2f(1e-4)));
   let win=step(.55,fract(along/2.6))*step(.35,fract(gy/3.))*step(fract(gy/3.),.8)*(1.-up)*step(1.,gy);
   alb=mix(alb,vec3f(.08,.1,.12),win*.8);alb*=mix(.55,1.,smoothstep(0.,1.2,gy));}

 var S:LitSurf;S.p=v.wp;S.n=n;S.alb=alb;S.rough=M.emissive.w;S.f0=.04;S.canopy=0.;S.trans=0.;S.ao=1.;S.vis=sunVis(v.wp,n);
 if(mode>3.5){S.rough=.85;S.ao=nearAO(v.wp);}
 else if(mode>2.5){S.rough=.6;S.canopy=1.;S.trans=.4;S.ao=nearAO(v.wp);}
 else{S.ao=nearAO(v.wp);}
 let sp=M.pad.z;let metal=M.pad.x;var coat=M.pad.y;
 if(mode<.5&&(metal>0.||coat>0.||sp>.5)){
  if(dot(S.n,F.camPos.xyz-v.wp)<0.){S.n=-S.n;}   // thin extruded plates (club faces) can arrive with mirrored winding: visible surfaces face the eye
  if(sp>6.5&&sp<7.5){return vec4f(fogApply(cupShade(v.wp),v.wp),1.);}
  if(sp>.5&&sp<1.5){let b=ballSurf(v.wp,n);S.n=b.n;S.alb=mix(S.alb,mix(vec3f(.018,.03,.06),vec3f(.5,.03,.03),b.red),b.ink);S.rough=mix(S.rough,.2,b.ink);S.vis=sunVis(v.wp,S.n);S.ao*=1.-.2*b.cav;S.alb*=1.-.05*b.cav;}   // ionomer cover, clear-coated; navy ink
  else if(sp>1.5&&sp<2.5){S.trans=.55;S.rough=.75;   // flag cloth: lit through from behind, woven sheen
   let fw=max(fwidth(v.uv.x*900.),fwidth(v.uv.y*640.));let w=sin(v.uv.x*900.)*sin(v.uv.y*640.)*(1.-smoothstep(.3,1.,fw));S.alb*=1.-.05*w;}   // weave only where it's resolved (no moire)
  else if(sp>3.5&&sp<4.5){let u=v.uv*vec2f(420.,420.);let cx=floor(u.x);let cy=floor(u.y);let tw=fract((cx+cy)*.5)*2.;   // 2x2 twill carbon weave
   let fu=fract(u);let along=select(fu.x,fu.y,tw>.5);let ridge=sin(along*3.1416);let wk=clamp(v.col.a,0.,1.)*(1.-smoothstep(.6,1.4,distance(v.wp,F.camPos.xyz)*F.res.w*420.));S.alb=S.alb*mix(1.,.72+.5*ridge*ridge,wk);
   let tn=select(vec3f(1.,0.,0.),vec3f(0.,0.,1.),tw>.5);S.n=normalize(n+(tn-n*dot(tn,n))*(cos(along*3.1416)*.1*wk));}
  else if(sp>4.5&&sp<5.5){let f=fract(length(v.uv*vec2f(1.,1.))*700.);S.rough=S.rough*(.8+.4*f);   // fly-cut milling rings
   S.alb*=.94+.12*f;}
  else if(sp>5.5&&sp<6.5){let f=hash21(vec2f(floor(v.uv.y*4000.),0.));S.rough=S.rough*(.82+.36*f);}   // brushed/satin lines
  var c=shadeObj(S,metal,coat);c+=M.emissive.rgb;return vec4f(fogApply(c,v.wp),1.);}
 var c=shade(S);c+=M.emissive.rgb;
 return vec4f(fogApply(c,v.wp),1.);}

// ---- deferred terrain passes (backend: ground deferred). Group 2: depth + G-buffer + term targets.
@group(2) @binding(0) var gDepth:texture_depth_2d;
@group(2) @binding(1) var gb0:texture_2d<f32>;   // albedo rgb, kind (0 pre-lit, .5 bunker-sand strip, 1 terrain)
@group(2) @binding(2) var gb1:texture_2d<f32>;   // octahedral normal xy, edge mask, water  (pre-lit: final colour rgb)
@group(2) @binding(3) var gVis:texture_2d<f32>;  // sun visibility terms: r objects + contact, g terrain, b clouds
@group(2) @binding(4) var gAO:texture_2d<f32>;   // r ground AO map, g dryness, b near-field AO
@group(2) @binding(7) var gShLo:texture_2d<f32>;   // half-res contact shadow (r) and the raw depth it was marched at (g)
@group(2) @binding(6) var gb2:texture_2d<f32>;   // surface mask r, g, a (so later passes don't re-filter it) + per-surface gain
struct FV{@builtin(position) pos:vec4f}
@vertex fn vsFull(@builtin(vertex_index) i:u32)->FV{let p=vec2f(f32((i<<1u)&2u),f32(i&2u))*2.-1.;var o:FV;o.pos=vec4f(p,0.,1.);return o;}
fn gNdc(fc:vec2f)->vec2f{let dim=vec2f(textureDimensions(gDepth));return vec2f(fc.x/dim.x*2.-1.,1.-fc.y/dim.y*2.);}
fn gPos(fc:vec2f)->vec3f{let d=textureLoad(gDepth,vec2i(fc),0);let w=F.invViewProj*vec4f(gNdc(fc),d,1.);return w.xyz/w.w;}
fn gRay(fc:vec2f)->vec3f{let w=F.invViewProj*vec4f(gNdc(fc),.5,1.);return normalize(w.xyz/w.w-F.camPos.xyz);}
// world-xz footprint of a one-pixel step on the surface's tangent plane (ray differentials: no 2x2-quad derivatives, so
// silhouettes don't blow up the texture footprint)
fn gFoot(fc:vec2f,p:vec3f,n:vec3f,o:vec2f)->vec2f{let c=F.camPos.xyz;let r=gRay(fc+o);let den=dot(r,n);if(abs(den)<1e-4){return vec2f(0.);}let t=dot(p-c,n)/den;return (c+r*t-p).xz;}
fn octEnc(n:vec3f)->vec2f{let m=n/(abs(n.x)+abs(n.y)+abs(n.z));var e=m.xz;if(m.y<0.){e=(1.-abs(m.zx))*select(vec2f(-1.),vec2f(1.),m.xz>=vec2f(0.));}return e;}
fn octDec(e:vec2f)->vec3f{var n=vec3f(e.x,1.-abs(e.x)-abs(e.y),e.y);if(n.y<0.){let t=(1.-abs(n.zx))*select(vec2f(-1.),vec2f(1.),n.xz>=vec2f(0.));n.x=t.x;n.z=t.y;}return normalize(n);}
struct GOut{@location(0) a:vec4f,@location(1) b:vec4f}
struct GOut3{@location(0) a:vec4f,@location(1) b:vec4f,@location(2) c:vec4f}
// seed the per-invocation surfMask memo from the G-buffer copy (every surfMask(p.xz) in the pass then costs nothing)
fn gMask(fc:vec2f,p:vec3f)->f32{let c=textureLoad(gb2,vec2i(fc),0);smKey=p.xz;smVal=vec4f(c.r,c.g,0.,c.b);return c.a*2.;}
fn gPack(g:GB,kind:f32)->GOut{var o:GOut;if(g.prelit){o.a=vec4f(0.);o.b=vec4f(g.pc,0.);}else{o.a=vec4f(g.alb,kind);o.b=vec4f(octEnc(g.n),g.gEdge,g.wat);}return o;}
fn gUnpack(fc:vec2f)->GB{let a=textureLoad(gb0,vec2i(fc),0);let b=textureLoad(gb1,vec2i(fc),0);var g:GB;g.nat=-1.;g.alb=a.rgb;g.prelit=a.a<.25;g.pc=b.rgb;g.n=octDec(b.xy);g.gEdge=b.z;g.wat=b.w;return g;}
// depth prepass: bunker holes cut out of the turf (the only fragment work before the G-buffer)
@fragment fn fsDepthCut(v:VO){if(bunkerHole(v.wp.xz)){discard;}}
// material G-buffer: base material of every terrain / sand-strip pixel, depth-equal over the prepass (one shade per pixel)
@fragment fn fsG(v:VO)->GOut3{let dWx=dpdx(v.wp.xz);let dWy=dpdy(v.wp.xz);gDX=dWx;gDY=dWy;
 let strip=v.col.a<-2.5;let terr=v.col.a<-1.1&&v.col.a>-1.4;
 if(SEA){var g:GB;g.prelit=true;g.pc=fogApplyLite(deepWater(),v.wp);g.alb=vec3f(0.);g.n=vec3f(0.,1.,0.);g.wat=1.;g.gEdge=0.;let o=gPack(g,0.);return GOut3(o.a,o.b,vec4f(0.));}
 var n=normalize(v.n);if(terr){n=terrainN(v.wp.xz,distance(v.wp,F.camPos.xyz)*F.res.w*1.15);}
 var g=groundBase(v.wp,n,terr,strip,vec2f(1.,0.));   // the AO map's rough-dryness tint is applied in the lighting pass
 if(g.prelit){g.pc=fogApply(g.pc,v.wp);}
 let o=gPack(g,select(1.,.5,strip));let sm=surfMask(v.wp.xz);return GOut3(o.a,o.b,vec4f(sm.r,sm.g,sm.a,select(select(surfGain(v.wp.xz),g.gain,g.gain>=0.),1.,strip)*.5));}
// Terrain material from the material cache (CDLOD terrain, cache fully baked, no debug view): the same material as
// groundBase, with everything that depends only on world xz (albedo stack, surface mask, gain, matting, native weight) read
// from the cache in one level-blended tap set and the surface normal from one level pair of the normal cache. Seeds the
// surfMask memo, so every later surfMask(p.xz) (detail, lighting) is free. g.gain = measured per-surface reflectance.
fn terrMat(wp:vec3f)->GB{let cd=distance(wp,F.camPos.xyz);let fp=cd*F.res.w*1.15;let dc=max(abs(wp.x-F.camPos.x),abs(wp.z-F.camPos.z));
 let mc=mcLean(wp.xz,fp,dc);let sm=mc.m;smKey=wp.xz;smVal=sm;
 var g:GB;g.prelit=false;g.pc=vec3f(0.);g.n=terrainNLean(wp.xz,fp,dc);g.gain=mc.b.w*2.;g.alb=vec3f(0.);g.gEdge=0.;g.nat=mc.a.a*(1.-smoothstep(.3,.6,sm.r));
 g.wat=max(smoothstep(.35,.65,sm.b),1.-smoothstep(F.box.w+.15,F.box.w+.6,wp.y));
 if(g.wat>=1.){g.prelit=true;g.pc=deepWater();return g;}
 var gEdge=sm.g;if(bunkerNew(wp.xz)){gEdge=min(gEdge,.3);}g.gEdge=gEdge;
 var alb=groundAlbedoView(mc.a.rgb*mc.a.rgb,wp,sm,select(0.,kindAt(wp.xz),distance(wp.xz,F.camPos.xz)<40.));
 let roughK=(1.-smoothstep(.3,.6,sm.r))*(1.-smoothstep(.46,.5,gEdge));
 if(roughK>.001){alb=mix(alb,roughAlb(alb,0.),roughK);let mt=matToneMF(vec3f(mc.b.x*MAT_STRENGTH,normalize(mc.b.yz*2.-1.+vec2f(1e-5,0.))),wp);alb*=mix(1.,mt,roughK);
  let vv0=normalize(F.camPos.xyz-wp);let fp0=cd*F.res.w*1.5/sqrt(max(abs(vv0.y),.08));alb*=mix(1.,roughMottle(wp.xz,fp0),roughK);}
 if(sm.r<.6&&gEdge<.5){let nat=mc.a.a;if(nat>0.){let q=wp.xz;
   let fpn=cd*F.res.w*1.5/sqrt(max(abs(normalize(F.camPos.xyz-wp).y),.08));let nL=f32(textureDimensions(noiseTex).x);
   let cl=smoothstep(.28,.72,tnd(q*.9,max(log2(fpn*nL*.9),0.)).r*.35+tnd(q*3.1,max(log2(fpn*nL*3.1),0.)).g*.25+tnd(q*.045+vec2f(.13,.57),max(log2(fpn*nL*.045),0.)).b*.4);
   let nc=mix(vec3f(.075,.095,.045),vec3f(.2,.2,.11),cl)*mix(1.,1.25,smoothstep(.72,.84,tnd(q*2.3,max(log2(fpn*nL*2.3),0.)).b))*roughMottle(q,fpn);alb=mix(alb,nc,nat*.85);}}
 alb=mix(alb,vec3f(.02,.05,.09),g.wat);let mn=tn(wp.xz*.19).gb-.5;g.n=normalize(g.n+vec3f(mn.x,0.,mn.y)*.25*(1.-smoothstep(1.5,5.,fp*.19*1.4/1.15)));
 g.alb=alb;return g;}
// Lean terrain G-buffer (timed frames / A-B only; see fsTerrainLit)
@fragment fn fsGT(v:VO)->GOut3{let dWx=dpdx(v.wp.xz);let dWy=dpdy(v.wp.xz);gDX=dWx;gDY=dWy;
 let g=terrMat(v.wp);let o=gPack(g,1.);let sm=smVal;return GOut3(o.a,o.b,vec4f(sm.r,sm.g,sm.a,g.gain*.5));}
// ground detail pass (Ground detail effect): reads the base G-buffer, writes the detailed one
@fragment fn fsDetail(f:FV)->GOut{let a=textureLoad(gb0,vec2i(f.pos.xy),0);var g=gUnpack(f.pos.xy);if(g.prelit){var o:GOut;o.a=a;o.b=textureLoad(gb1,vec2i(f.pos.xy),0);return o;}
 let p=gPos(f.pos.xy);gMask(f.pos.xy,p);let dWx=gFoot(f.pos.xy,p,g.n,vec2f(1.,0.));let dWy=gFoot(f.pos.xy,p,g.n,vec2f(0.,1.));gDX=dWx;gDY=dWy;
 g=groundDetail(p,g,true,dWx,dWy);return gPack(g,a.a);}
// lighting pass: the shading engine over the G-buffer, with the separately rendered sun-visibility and AO terms
@fragment fn fsLight(f:FV)->@location(0) vec4f{let a=textureLoad(gb0,vec2i(f.pos.xy),0);let g=gUnpack(f.pos.xy);if(g.prelit){return vec4f(g.pc,1.);}
 let p=gPos(f.pos.xy);let gain=gMask(f.pos.xy,p);return vec4f(lightG(f.pos.xy,p,g,a.a,gain,false),1.);}
// ground detail + lighting in one pass (frames without detailed GPU timing): same result as fsDetail then fsLight, without
// the round trip of the detailed G-buffer through memory. Frames that sample GPU timing run the two passes separately.
@fragment fn fsDetailLight(f:FV)->@location(0) vec4f{let a=textureLoad(gb0,vec2i(f.pos.xy),0);var g=gUnpack(f.pos.xy);if(g.prelit){return vec4f(g.pc,1.);}
 let p=gPos(f.pos.xy);let gain=gMask(f.pos.xy,p);let dWx=gFoot(f.pos.xy,p,g.n,vec2f(1.,0.));let dWy=gFoot(f.pos.xy,p,g.n,vec2f(0.,1.));gDX=dWx;gDY=dWy;
 g=groundDetail(p,g,true,dWx,dWy);return vec4f(lightG(f.pos.xy,p,g,a.a,gain,true),1.);}
// Terrain in one screen pass (the production path): material from the material cache + ground detail + lighting, straight
// from the depth prepass. No G-buffer: nothing is written or read back but the lit colour. Bunker sand (the strip mesh, whose
// bowl normal only the mesh knows) is shaded by fsStripLit right after, over the pixels this pass leaves.
override DETAIL:bool=true;
@fragment fn fsTerrainLit(f:FV)->@location(0) vec4f{let fc=f.pos.xy;let p=gPos(fc);
 if(bunkerHole(p.xz)){return vec4f(0.,0.,0.,1.);}
 var g=terrMat(p);if(g.prelit){return vec4f(g.pc,1.);}
 if(DETAIL){let dWx=gFoot(fc,p,g.n,vec2f(1.,0.));let dWy=gFoot(fc,p,g.n,vec2f(0.,1.));gDX=dWx;gDY=dWy;g=groundDetail(p,g,true,dWx,dWy);}
 return vec4f(lightG(fc,p,g,1.,g.gain,true),1.);}
// The same terrain shading drawn as the CDLOD mesh, depth-equal over the prepass, AFTER the grass blades have written their
// depth (production path when grass is drawn): the early depth test then skips every ground pixel a blade covers, where the
// screen pass shaded the ground under the sward only for the blades to paint over it. Same material, detail, lighting.
@fragment fn fsTerrainLitM(v:VO)->@location(0) vec4f{let fc=v.pos.xy;let p=v.wp;
 if(bunkerHole(p.xz)){discard;}
 var g=terrMat(p);if(g.prelit){return vec4f(g.pc,1.);}
 if(DETAIL){let dWx=gFoot(fc,p,g.n,vec2f(1.,0.));let dWy=gFoot(fc,p,g.n,vec2f(0.,1.));gDX=dWx;gDY=dWy;g=groundDetail(p,g,true,dWx,dWy);}
 return vec4f(lightG(fc,p,g,1.,g.gain,true),1.);}
// bunker sand strip, forward over its own prepass depth (depth-equal): the same material, detail and lighting as the terrain
@fragment fn fsStripLit(v:VO)->@location(0) vec4f{let dWx=dpdx(v.wp.xz);let dWy=dpdy(v.wp.xz);gDX=dWx;gDY=dWy;
 var g=groundBase(v.wp,normalize(v.n),false,true,vec2f(1.,0.));if(g.prelit){return vec4f(g.pc,1.);}
 if(DETAIL){g=groundDetail(v.wp,g,true,dWx,dWy);}
 return vec4f(lightG(v.pos.xy,v.wp,g,.5,1.,true),1.);}
fn lightG(fc:vec2f,p:vec3f,g:GB,kind:f32,gain:f32,inlineCloud:bool)->vec3f{   // inlineCloud: merged pass evaluates the sun and cloud shadows itself (no shadow screen passes)
 var vis=1.;if(!pk(0u)||!pk(2u)){vis*=contactUp(fc);}   // contact x object shadows, marched / filtered at half res (fsShLo)
 // merged passes evaluate the terrain (one cached-map tap) and cloud shadows inline: no full-res term passes / G.vis traffic
 if(!pk(3u)){if(inlineCloud){vis*=terrainShadowCached(p);}else{vis*=textureLoad(gVis,vec2i(fc),0).g;}}if(!pk(4u)){if(inlineCloud){vis*=cloudShadow(p);}else{vis*=textureLoad(gVis,vec2i(fc),0).b;}}   // term textures read only while their effect is on
 var ao=1.;var gg=g;if(!pk(1u)||!pk(9u)){let at=aoUp(fc);ao=at.r*at.b;
  // rough: the AO map's dryness / occlusion tint of the sward (the forward shader does this inside the albedo stack)
  if(!pk(9u)){let sm=surfMask(p.xz);let roughK=(1.-smoothstep(.3,.6,sm.r))*(1.-smoothstep(.46,.5,g.gEdge));
   if(roughK>.001){gg.alb=mix(gg.alb,vec3f(.36,.33,.15),roughK*at.g*.25)*mix(1.,.82+.18*at.r,roughK);}}}
 vis*=1.-g.msh;return groundLight(p,gg,kind<.75,vis,ao,gain);}
// haze pass (Haze effect): aerial perspective blended over the lit ground (colour * T + in-scatter)
@fragment fn fsFog(f:FV)->@location(0) vec4f{let a=textureLoad(gb0,vec2i(f.pos.xy),0);if(a.a<.25){discard;}return fogParts(gPos(f.pos.xy));}
// sun visibility terms, one pass per effect (the colour write mask picks the channel)
fn gGeoN(p:vec3f)->vec3f{return terrainN(p.xz,distance(p,F.camPos.xyz)*F.res.w*1.15);}
// Contact shadows are marched at half resolution (fsShLo: ~11 height-field taps per pixel was the whole cost of Sun shadows),
// together with the object shadow-map PCF (6-12 taps per pixel),
// and brought back depth-aware: each full-res pixel only takes the half-res samples marched at a similar depth.
@fragment fn fsShLo(f:FV)->@location(0) vec4f{let dims=vec2f(textureDimensions(gDepth));let fc=min(floor(f.pos.xy)*2.+vec2f(.5),dims-vec2f(.5));
 let d=textureLoad(gDepth,vec2i(fc),0);if(d<=0.){return vec4f(1.,0.,0.,1.);}let p=gPos(fc);let n=gGeoN(p);
 var ob=1.;if(!pk(2u)){if(fastLit()){ob=objShadowFast(p+n*.03);}else{ob=objShadow(p,n);}}   // object (tree, flag, building) shadows too: soft PCF edges survive the half-res + depth-aware upsample
 return vec4f(contactShadow(p,n)*ob,d,0.,1.);}
fn contactUp(fc:vec2f)->f32{let d0=textureLoad(gDepth,vec2i(fc),0);let dims=vec2f(textureDimensions(gShLo));let u=(fc-.5)/2.;
 // common case: the four half-res samples were marched at about this pixel's depth -> one hardware-bilinear tap (same weights)
 {let uv=(floor(u)+1.)/dims;let dg=textureGather(1,gShLo,linSamp,uv);let rel=max(max(abs(dg.x-d0),abs(dg.y-d0)),max(abs(dg.z-d0),abs(dg.w-d0)))/max(d0,1e-9);
  if(rel<.002){return textureSampleLevel(gShLo,linSamp,(u+.5)/dims,0.).r;}}
 let lm=vec2i(dims)-1;let b=vec2i(floor(u));let f=u-floor(u);
 var s=0.;var w=0.;var best=1.;var bw=1e9;
 for(var k=0;k<4;k++){let o=vec2i(k&1,k>>1);let t=textureLoad(gShLo,clamp(b+o,vec2i(0),lm),0);let rel=abs(t.g-d0)/max(d0,1e-9);
  let wg=mix(1.-f.x,f.x,f32(o.x))*mix(1.-f.y,f.y,f32(o.y))*exp(-rel*60.);s+=t.r*wg;w+=wg;if(rel<bw){bw=rel;best=t.r;}}
 return select(best,s/w,w>1e-4);}
fn sunVisG(p:vec3f)->f32{let n=gGeoN(p);var o=1.;if(fastLit()){o=objShadowFast(p+n*.03);}else{o=objShadow(p,n);}return o*contactShadow(p,n);}
@fragment fn fsShSun(f:FV)->@location(0) vec4f{return vec4f(sunVisG(gPos(f.pos.xy)));}
@fragment fn fsShTerr(f:FV)->@location(0) vec4f{return vec4f(terrainShadowCached(gPos(f.pos.xy)));}
@fragment fn fsShCloud(f:FV)->@location(0) vec4f{return vec4f(cloudShadow(gPos(f.pos.xy)));}
// ambient occlusion pass (AO effect): ground AO map (+ dryness) and near-field occlusion
// Both terms are smooth at the half-res pixel scale (a cubic-filtered 2 m course map, and 8 height taps spanning 0.35-1.1 m),
// so the pass runs at half resolution (a quarter of the pixels) and stores the depth it was evaluated at for a depth-aware
// upsample (aoUp), like the contact shadows.
@fragment fn fsAO(f:FV)->@location(0) vec4f{let dims=vec2f(textureDimensions(gDepth));let fc=min(floor(f.pos.xy)*2.+vec2f(.5),dims-vec2f(.5));
 let d=textureLoad(gDepth,vec2i(fc),0);if(d<=0.){return vec4f(1.,0.,1.,0.);}let p=gPos(fc);var gao=vec2f(1.,0.);if(!pk(9u)){gao=groundAO(p.xz);}return vec4f(gao.x,gao.y,nearAO(p),d);}
fn aoUp(fc:vec2f)->vec3f{let d0=textureLoad(gDepth,vec2i(fc),0);let dims=vec2f(textureDimensions(gAO));let u=(fc-.5)/2.;
 {let uv=(floor(u)+1.)/dims;let dg=textureGather(3,gAO,linSamp,uv);let rel=max(max(abs(dg.x-d0),abs(dg.y-d0)),max(abs(dg.z-d0),abs(dg.w-d0)))/max(d0,1e-9);
  if(rel<.003){return textureSampleLevel(gAO,linSamp,(u+.5)/dims,0.).rgb;}}
 let lm=vec2i(dims)-1;let b=vec2i(floor(u));let f=u-floor(u);var s=vec3f(0.);var w=0.;var best=vec3f(1.,0.,1.);var bw=1e9;
 for(var k=0;k<4;k++){let o=vec2i(k&1,k>>1);let t=textureLoad(gAO,clamp(b+o,vec2i(0),lm),0);let rel=abs(t.a-d0)/max(d0,1e-9);
  let wg=mix(1.-f.x,f.x,f32(o.x))*mix(1.-f.y,f.y,f32(o.y))*exp(-rel*60.);s+=t.rgb*wg;w+=wg;if(rel<bw){bw=rel;best=t.rgb;}}
 return select(best,s/w,w>1e-4);}
`;
// ---------------------------------------------------------------- height bake (top-down, writes world y)
export const HEIGHT=/*wgsl*/`
struct B{box:vec4f}
@group(0) @binding(0) var<uniform> U:B;
struct VO{@builtin(position) pos:vec4f,@location(0) y:f32}
@vertex fn vs(@location(0) p:vec3f,@location(4) m0:vec4f,@location(5) m1:vec4f,@location(6) m2:vec4f,@location(7) m3:vec4f)->VO{
 let w=mat4x4f(m0,m1,m2,m3)*vec4f(p,1.);var o:VO;let uv=(w.xz-U.box.xy)/U.box.z;
 o.pos=vec4f(uv.x*2.-1.,1.-uv.y*2.,clamp(.5-w.y/4000.,0.,1.),1.);o.y=w.y;return o;}
@fragment fn fs(v:VO)->@location(0) vec4f{return vec4f(v.y,0,0,1);}
`;
export const POST=/*wgsl*/`
@group(0) @binding(0) var hdr:texture_2d<f32>;
@group(0) @binding(1) var samp:sampler;
@group(0) @binding(2) var<uniform> PU:array<vec4f,12>; // [exposure,vignette,saturation,time] [sunUV.xy,sunVis,rays] [sunColor.rgb,haze] [debug,golden w,taa,cas] [headroom] + keyframed grade (gpu/grade.js): [5] ev [6] hueBlend,contrast,-,shoulderKnee [7] blackPoint,gamma,-,whitePoint [8] wbGain.rgb,warmHighlights [9] -,-,-,coolShadows [10] -,-,liftMax,liftStrength [11] bloom
@group(0) @binding(3) var bloomTex:texture_2d<f32>;
@group(0) @binding(5) var lumTex:texture_2d<f32>;
// volumetrics folded in (no TAA): the quarter-res filtered shafts / cloud deck, composited here exactly as the old composite pass did
@group(0) @binding(6) var vRays:texture_2d<f32>;@group(0) @binding(7) var vCloud:texture_2d<f32>;@group(0) @binding(8) var vDepth:texture_depth_2d;@group(0) @binding(9) var<uniform> CU:vec4f;
fn volAt(full:vec2i,uv:vec2f)->vec4f{let dep=textureLoad(vDepth,full,0);
 let ld=vec2f(textureDimensions(vRays));let lp=uv*ld-.5;let b=vec2i(floor(lp));let f=lp-vec2f(b);let lmax=vec2i(ld)-1;let lzF=select(1e6,.05/dep,dep>0.);
 {let g=textureGather(3,vRays,samp,uv);let lz=select(vec4f(1e6),.05/g,g>vec4f(0.));let x=abs(lz-lzF)/(.06*min(lz,vec4f(lzF))+.02);
  if(max(max(x.x,x.y),max(x.z,x.w))<.03){var c=vec4f(0.);if(dep<=0.){c=textureSampleLevel(vCloud,samp,uv,0.);}return vec4f(c.rgb+textureSampleLevel(vRays,samp,uv,0.).rgb*CU.x,c.a);}}
 var sr=vec3f(0.);var wr=0.;var sb=vec3f(0.);var sc=vec4f(0.);var wc=0.;
 for(var k=0;k<4;k++){let o=vec2i(k&1,k>>1);let t=clamp(b+o,vec2i(0),lmax);let wg=mix(1.-f.x,f.x,f32(o.x))*mix(1.-f.y,f.y,f32(o.y));
  let R=textureLoad(vRays,t,0);let lz=select(1e6,.05/R.w,R.w>0.);let wd=exp(-abs(lz-lzF)/(.06*min(lz,lzF)+.02));
  sr+=R.rgb*wg*wd;wr+=wg*wd;sb+=R.rgb*wg;if(R.w<=0.&&dep<=0.){sc+=textureLoad(vCloud,t,0)*wg;wc+=wg;}}
 let r=select(sb,sr/wr,wr>1e-4);var c=vec4f(0.);if(dep<=0.){if(wc>1e-4){c=sc/wc;}else{c=textureSampleLevel(vCloud,samp,uv,0.);}}
 return vec4f(c.rgb+r*CU.x,c.a);}
struct VO{@builtin(position) pos:vec4f,@location(0) uv:vec2f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:VO;o.pos=vec4f(p*2.-1.,0.,1.);o.uv=vec2f(p.x,1.-p.y);return o;}
fn L(c:vec3f)->f32{return log2(1.+dot(c,vec3f(.299,.587,.114)));}
fn tex(uv:vec2f)->vec3f{return textureSampleLevel(hdr,samp,uv,0.).rgb;}
fn aces(x:vec3f)->vec3f{let a=x*(x+.0245786)-.000090537*(1.-exp(-x/.0037));   /* Hill's RRT+ODT fit has a negative intercept: everything under .0037 clipped to black. Fading the intercept in keeps the same curve above the toe and a soft, never-negative toe below it */let b=x*(.983729*x+.4329510)+.238081;return clamp(a/b,vec3f(0),vec3f(1));}
fn aces1(x:f32)->f32{let a=x*(x+.0245786)-.000090537*(1.-exp(-x/.0037));let b=x*(.983729*x+.4329510)+.238081;return clamp(a/b,0.,1.);}   // scalar aces() for the luminance path
fn nonFinite(x:vec3f)->bool{let b=bitcast<vec3u>(x)&vec3u(0x7f800000u);return any(b==vec3u(0x7f800000u));}
@fragment fn fs(v:VO)->@location(0) vec4f{let t=1./vec2f(textureDimensions(hdr));let uv=v.uv;var m=tex(uv);
 // Visual debug: PU[3].x=1 paints non-finite (NaN/Inf) scene pixels magenta and non-finite bloom cyan
 if(PU[3].x>.5){if(nonFinite(textureLoad(hdr,vec2i(uv*vec2f(textureDimensions(hdr))),0).rgb)){return vec4f(1.,0.,1.,1.);}if(nonFinite(textureSampleLevel(bloomTex,samp,uv,0.).rgb)){return vec4f(0.,1.,1.,1.);}}
 let lM=L(m);let lNW=L(tex(uv+vec2f(-t.x,-t.y)));let lNE=L(tex(uv+vec2f(t.x,-t.y)));let lSW=L(tex(uv+vec2f(-t.x,t.y)));let lSE=L(tex(uv+t));
 let lo=min(lM,min(min(lNW,lNE),min(lSW,lSE)));let hi=max(lM,max(max(lNW,lNE),max(lSW,lSE)));
 if(PU[3].z<.5&&hi-lo>max(.03,hi*.12)){var dir=vec2f(-((lNW+lNE)-(lSW+lSE)),(lNW+lSW)-(lNE+lSE));let red=max((lNW+lNE+lSW+lSE)*.03125,1./128.);
  dir=clamp(dir/(min(abs(dir.x),abs(dir.y))+red),vec2f(-8),vec2f(8))*t;
  let a=.5*(tex(uv-dir/6.)+tex(uv+dir/6.));let b=a*.5+.25*(tex(uv-dir*.5)+tex(uv+dir*.5));let lb=L(b);m=select(b,a,lb<lo||lb>hi);}
 if(PU[3].w>0.){   // contrast-adaptive sharpening (FidelityFX CAS) after TAA: restores edge/specular crispness without ringing
  let a0=tex(uv+vec2f(0.,-t.y));let b0=tex(uv+vec2f(-t.x,0.));let c0=tex(uv+vec2f(t.x,0.));let d0=tex(uv+vec2f(0.,t.y));
  let k=vec3f(1.);let mn=min(m,min(min(a0,b0),min(c0,d0)));let mx=max(m,max(max(a0,b0),max(c0,d0)));let mnC=mn/(k+mn);let mxC=mx/(k+mx);   /* CAS measures headroom on a compressed range so HDR highlights still get sharpened */
  let amp=sqrt(clamp(min(mnC,1.-mxC)/max(mxC,vec3f(1e-4)),vec3f(0.),vec3f(1.)));let wN=-amp*mix(.125,.2,PU[3].w);
  m=max((a0+b0+c0+d0)*wN+m,vec3f(0.))/(1.+4.*wN);}
 if(CU.y>.5){let vc=volAt(vec2i(v.pos.xy),uv);m=m*(1.-vc.a)+vc.rgb;}
 { // local exposure: bilateral lookup of the 1/16-res log-luminance map, lift regions far below the frame's average
  let lsz=vec2f(textureDimensions(lumTex));let lp=uv*lsz-.5;let b=vec2i(floor(lp));let f=fract(lp);let lpx=log2(max(dot(m,vec3f(.2126,.7152,.0722)),1e-7));
  var sw=0.;var sl=0.;for(var y=0;y<2;y++){for(var x=0;x<2;x++){let t=clamp(b+vec2i(x,y),vec2i(0),vec2i(lsz)-1);let l=textureLoad(lumTex,t,0).r;
   let wb=select(1.-f.x,f.x,x==1)*select(1.-f.y,f.y,y==1);let we=exp(-abs(l-lpx)*.9);sw+=wb*we;sl+=l*wb*we;}}
  let loc=select(lpx,sl/sw,sw>1e-4);let kx=PU[0].x*exp2(PU[5].x);let glob=log2(.005/max(kx,1e-6));   /* reference = the scene level that exposes to a deep-shadow display floor (~.018 linear) */
  let lift=clamp((glob-loc)*PU[10].w,0.,PU[10].z);
  if(PU[3].x>1.5&&PU[3].x<2.5){return vec4f(clamp((lpx-glob+12.)/16.,0.,1.),lift/4.5,clamp((loc-glob+12.)/16.,0.,1.),1.);}   /* debug: r = pixel EV rel. frame avg (-12..+4), g = local lift/4.5, b = local EV */
  m*=exp2(lift);}   /* up to ~2.6 EV for deep shade, none for mid/bright regions: no washed-out sky */
 let P=PU[0];let S=PU[1];let hz=PU[2].w;
 if(PU[11].x>0.){m+=textureSampleLevel(bloomTex,samp,uv,0.).rgb*mix(.025,.05,hz)*PU[11].x;}   // bloom is glare around bright sources, not a veil over the frame
 // filmic: gentle toe, long shoulder (ACES fit), warm key / teal shadow split-tone
 // Grade (targets: Ghost of Tsushima / Yotei golden-hour frames, outputs/ghost-sunrise-sunset): warm, rich, never sterile.
 // All grade parameters come from gpu/grade.js, keyframed over the time of day (no separate day / golden-hour sets).
 let k=P.x*exp2(PU[5].x);   /* fixed, keyframed exposure: no auto metering */let H=max(PU[4].x,1.);let xk=m*k;
 // Tone curve. Per-channel ACES bleaches bright colours toward white (sunlit blades/leaves read silver) and shifts hues;
 // tone-mapping luminance alone keeps them but can over-saturate. Half of each: highlights keep their colour, a little
 // natural film desaturation remains.
 let Yx=max(dot(xk,vec3f(.2126,.7152,.0722)),1e-7);let cC=aces(xk);let cL=xk*(aces1(Yx)/Yx);
 var c=mix(cC,cL,PU[6].x)+(H-1.)*(1.-exp(-max(xk-vec3f(1.),vec3f(0.))*.35));   /* HDR: identical to SDR up to the ACES shoulder; energy above it rises smoothly toward the display headroom H (SDR: H=1, no change) */
 if(PU[3].x>4.5&&PU[3].x<5.5){return vec4f(pow(clamp(c,vec3f(0.),vec3f(1.)),vec3f(1./2.2)),1.);}   /* debug (post 5): tone-mapped colour BEFORE the grade's gamma / saturation / white balance / split tone */
 let gam=PU[7].y;c=pow(max(c,vec3f(0.)),vec3f(gam));   /* gamma on the tone-mapped image (grade) */
 let g=dot(c,vec3f(.2126,.7152,.0722));c=mix(vec3f(g),c,P.z);
 // colour: warm-highlight / cool-shadow split tone and a temperature + tint white balance, all from the keyframed grade
 c=mix(c,c*vec3f(1.08,1.0,.86),smoothstep(.3,.95,g)*PU[8].w);
 c*=PU[8].xyz;   /* white balance gains from temperature + tint */
 c=mix(c,c*vec3f(.93,1.0,1.05),(1.-smoothstep(.0,.3,g))*PU[9].w);
 // levels: fixed black and white points from the grade, then contrast and a highlight shoulder on luminance
 {let b0=max(PU[7].x,1e-6);let w0=max(PU[7].w,b0+.01);   /* fixed black / white points (grade), no per-frame auto levels */
  // levels + contrast on LUMINANCE, then scale the colour: per-channel black-point subtraction pushed low channels (blue in
  // grass, everything at night) below zero and clamped them, collapsing every blade onto one hue (channel clipping)
  let Y=max(dot(c,vec3f(.2126,.7152,.0722)),1e-6);var Yn=(Y-b0*(1.-exp(-Y/b0)))/(w0-b0);   /* soft toe: slope 0 at black, never negative, -> Y-b0 above; the old max(Y-b0+..,0) zeroed everything under ~.6*b0 */
  Yn=.18*pow(max(Yn,0.)/.18,PU[6].y);
  // highlight shoulder after the contrast: linear to .75, then a C1 roll-off toward the display peak (1 in SDR, the HDR
  // headroom otherwise), so sunlit sand and white clouds keep texture instead of flattening into 255 white
  {let kn=PU[6].w;let A=H;if(Yn>kn){Yn=kn+(A-kn)*(1.-exp(-(Yn-kn)/max(A-kn,1e-3)));}}
  Yn=clamp(Yn,0.,H);c=c*(Yn/Y);   /* contrast in log space around mid-grey: a linear (Yn-.5)*1.06+.5 subtracted .03 from every pixel and zeroed everything under ~.028 (tree shade went solid black, and HDR can't restore a zero) */
  if(PU[3].x>3.5){return vec4f(.5,.25,.125,1.);}
  if(PU[3].x>2.5){return vec4f(clamp((log2(max(dot(xk,vec3f(.2126,.7152,.0722)),1e-9))+16.)/20.,0.,1.),pow(clamp(Yn,0.,1.),1./2.2),clamp((log2(max(Y,1e-9))+16.)/20.,0.,1.),1.);}}   /* debug (Visual debug post 3): r = scene EV after exposure (log2 xk, -16..+4), g = display luminance after levels (gamma-encoded, as shown), b = log2 after tone curve+gamma (-16..+4) */
 // gamut-safe: pull an out-of-range colour toward its own grey instead of clamping channels independently
 {let Y=dot(c,vec3f(.2126,.7152,.0722));let lo=min(c.r,min(c.g,c.b));let hi=max(c.r,max(c.g,c.b));
  var t=1.;if(lo<0.){t=min(t,Y/max(Y-lo,1e-5));}if(hi>H){t=min(t,(H-Y)/max(hi-Y,1e-5));}c=vec3f(Y)+(c-vec3f(Y))*clamp(t,0.,1.);}
 c=clamp(c,vec3f(0),vec3f(H));
 let d=uv-.5;c*=1.-dot(d,d)*P.y*1.4;
 c=pow(max(c,vec3f(0)),vec3f(1./2.2));
 let n=fract(sin(dot(v.pos.xy,vec2f(12.9898,78.233)))*43758.5453)-.5;c+=n/255.;
 return vec4f(c,1.);}
`;

// ---------------------------------------------------------------- shadow depth
export const SHADOW=/*wgsl*/`
@group(0) @binding(0) var<uniform> S:mat4x4f;
@vertex fn vs(@location(0) p:vec3f,@location(4) m0:vec4f,@location(5) m1:vec4f,@location(6) m2:vec4f,@location(7) m3:vec4f)->@builtin(position) vec4f{
 return S*(mat4x4f(m0,m1,m2,m3)*vec4f(p,1.));}
`;

export const BLOOM=/*wgsl*/`
@group(0) @binding(0) var src:texture_2d<f32>;@group(0) @binding(1) var samp:sampler;@group(0) @binding(2) var<uniform> B:vec4f;@group(0) @binding(6) var vRays:texture_2d<f32>;@group(0) @binding(7) var vCloud:texture_2d<f32>;@group(0) @binding(9) var<uniform> CU:vec4f; // texel.xy, mode(0 down-first,1 down,2 up), intensity
struct VO{@builtin(position) pos:vec4f,@location(0) uv:vec2f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:VO;o.pos=vec4f(p*2.-1.,0.,1.);o.uv=vec2f(p.x,1.-p.y);return o;}
fn t(uv:vec2f)->vec3f{return textureSampleLevel(src,samp,uv,0.).rgb;}
@fragment fn fs(v:VO)->@location(0) vec4f{let d=B.xy;let uv=v.uv;
 if(B.z<1.5){var c=t(uv)*.125;c+=(t(uv+d*vec2f(-1,-1))+t(uv+d*vec2f(1,-1))+t(uv+d*vec2f(-1,1))+t(uv+d*vec2f(1,1)))*.125;
  c+=(t(uv+d*vec2f(-2,0))+t(uv+d*vec2f(2,0))+t(uv+d*vec2f(0,-2))+t(uv+d*vec2f(0,2)))*.0625;
  c+=(t(uv+d*vec2f(-2,-2))+t(uv+d*vec2f(2,-2))+t(uv+d*vec2f(-2,2))+t(uv+d*vec2f(2,2)))*.03125;
  if(B.z<.5&&CU.y>.5){let cl=textureSampleLevel(vCloud,samp,uv,0.);c=c*(1.-cl.a)+cl.rgb+textureSampleLevel(vRays,samp,uv,0.).rgb*CU.x;}   // volumetrics folded into post (no TAA): bloom sees them too
  if(B.z<.5){let nb=bitcast<vec3u>(c)&vec3u(0x7f800000u);if(any(nb==vec3u(0x7f800000u))){c=vec3f(0.);}   // a NaN/Inf pixel must never become a bloom blob (min(NaN,40) = 40)
  let l=dot(c,vec3f(.2126,.7152,.0722));c*=smoothstep(.9,2.4,l)/max(l,1e-4)*l;c=min(c,vec3f(40.));}
  return vec4f(c,1.);}
 var c=t(uv)*4.;c+=(t(uv+d*vec2f(-1,0))+t(uv+d*vec2f(1,0))+t(uv+d*vec2f(0,-1))+t(uv+d*vec2f(0,1)))*2.;
 c+=t(uv+d*vec2f(-1,-1))+t(uv+d*vec2f(1,-1))+t(uv+d*vec2f(-1,1))+t(uv+d*vec2f(1,1));return vec4f(c/16.*B.w,1.);}
`;

// Sky irradiance lobes: the five sky-dome directions ambientSkyOcc() weights (zenith + four low horizon lobes, all fixed
// relative to the sun) looked up once whenever the sky LUT changes, instead of 2 x 5 LUT lookups with atan2/asin per pixel.
export const SKYAMB=/*wgsl*/`
@group(0) @binding(0) var lut:texture_2d<f32>;
@group(0) @binding(1) var samp:sampler;
@group(0) @binding(2) var<uniform> U:vec4f;   // sun direction (as F.sunDir)
const PI=3.14159265;
fn skyUV(d:vec3f)->vec2f{let s=U.xyz;let az=atan2(d.z,d.x)-atan2(s.z,s.x);let u=fract(az/(2.*PI)+1.);let e=asin(clamp(d.y,-1.,1.));
 let v=select(.5-.5*sqrt(-e/(PI*.5)),.5+.5*sqrt(e/(PI*.5)),e>=0.);return vec2f(u,1.-v);}
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let p=vec2f(f32((i<<1u)&2u),f32(i&2u))*2.-1.;return vec4f(p,0.,1.);}
@fragment fn fs(@builtin(position) q:vec4f)->@location(0) vec4f{let i=i32(q.x);let sd=normalize(vec3f(U.x,0.,U.z)+vec3f(1e-4,0.,0.));let sp=vec3f(-sd.z,0.,sd.x);
 let e=.26;let ce=cos(e);let se=sin(e);var d=vec3f(0.,1.,0.);
 if(i==1){d=sd*ce+vec3f(0.,se,0.);}else if(i==2){d=-sd*ce+vec3f(0.,se,0.);}else if(i==3){d=sp*ce+vec3f(0.,se,0.);}else if(i==4){d=-sp*ce+vec3f(0.,se,0.);}
 return vec4f(textureSampleLevel(lut,samp,skyUV(d),0.).rgb,1.);}
`;
export const SKYLUT=/*wgsl*/`
@group(0) @binding(0) var<uniform> U:array<vec4f,2>; // sunDir.xyz,camHeight | turbidity, intensity
struct VO{@builtin(position) pos:vec4f,@location(0) uv:vec2f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:VO;o.pos=vec4f(p*2.-1.,0.,1.);o.uv=vec2f(p.x,1.-p.y);return o;}
const PI=3.14159265;const RE=6360e3;const RA=6460e3;
const BR=vec3f(5.802e-6,13.558e-6,33.1e-6);const BM=3.996e-6;const OZ=vec3f(.65e-6,1.881e-6,.085e-6);
fn rsi(ro:vec3f,rd:vec3f,r:f32)->f32{let b=dot(ro,rd);let c=dot(ro,ro)-r*r;let h=b*b-c;if(h<0.){return -1.;}return -b+sqrt(h);}
fn dens(h:f32)->vec3f{return vec3f(exp(-h/8000.),exp(-h/1200.),max(0.,1.-abs(h-25000.)/15000.));}
fn transmit(p:vec3f,s:vec3f,turb:f32)->vec3f{let L=rsi(p,s,RA);var od=vec3f(0);for(var i=0;i<6;i++){let q=p+s*L*(f32(i)+.5)/6.;od+=dens(length(q)-RE)*L/6.;}
 return exp(-(BR*od.x+BM*1.11*turb*od.y+OZ*od.z));}
@fragment fn fs(v:VO)->@location(0) vec4f{let sun=normalize(U[0].xyz);let turb=U[1].x;
 let u=v.uv.x;let vv=1.-v.uv.y;var e=0.;if(vv<.5){let a=(.5-vv)*2.;e=-a*a*PI*.5;}else{let a=(vv-.5)*2.;e=a*a*PI*.5;}
 let az=u*2.*PI+atan2(sun.z,sun.x);let d=vec3f(cos(e)*cos(az),sin(e),cos(e)*sin(az));
 let ro=vec3f(0.,RE+max(U[0].w,1.)+2.,0.);var dd=d;if(dd.y<0.){dd=normalize(vec3f(d.x,-d.y*.25,d.z));}
 let L=rsi(ro,dd,RA);let N=24;let ds=L/f32(N);var sumR=vec3f(0);var sumM=vec3f(0);var od=vec3f(0);
 for(var i=0;i<N;i++){let p=ro+dd*ds*(f32(i)+.5);let h=length(p)-RE;let dn=dens(h)*ds;od+=dn;
  let tv=exp(-(BR*od.x+BM*1.11*turb*od.y+OZ*od.z));let ts=transmit(p,sun,turb);sumR+=tv*ts*dn.x;sumM+=tv*ts*dn.y;}
 let mu=dot(dd,sun);let pr=3./(16.*PI)*(1.+mu*mu);let g=.78;let pm=3./(8.*PI)*((1.-g*g)*(1.+mu*mu))/((2.+g*g)*pow(1.+g*g-2.*g*mu,1.5));
 var col=(sumR*BR*pr+sumM*BM*turb*pm)*U[1].y;
 // Multiple scattering (approximation). Single scattering alone turns the low sky green: along the long near-horizontal path
 // blue is scattered out of the view ray faster than it is scattered in, so the in-scattered spectrum peaks in green
 // (measured at hole 7, noon, 2 deg up: rgb .86/1.07/.75). In the real sky, light scattered many times refills the path and
 // whitens the horizon. Blend the low sky toward its own luminance with a faint blue-white cast; the zenith is untouched.
 {let Yc=dot(col,vec3f(.2126,.7152,.0722));let lowS=1.-smoothstep(0.,.35,max(d.y,0.));col=mix(col,Yc*vec3f(.93,.99,1.1),.7*lowS);}
 if(d.y<0.){col*=mix(.55,1.,exp(d.y*6.));}
 return vec4f(col,1.);}
`;

export const TRACER=/*wgsl*/`
struct TU{view:mat4x4f,proj:mat4x4f,p:vec4f,glow:vec4f} // p: headDist, fade, viewportH, 0
@group(1) @binding(0) var<uniform> T:TU;
struct VO{@builtin(position) pos:vec4f,@location(0) side:f32,@location(1) tip:f32,@location(2) half:f32}
@vertex fn vs(@location(0) pos:vec3f,@location(1) tan:vec3f,@location(2) side:f32,@location(3) arc:f32)->VO{
 var pv=T.view*vec4f(pos,1.);let tv=normalize((T.view*vec4f(tan,0.)).xyz);let eye=normalize(-pv.xyz);var n=cross(tv,eye);let nl=length(n);
 n=select(normalize(cross(tv,vec3f(0.,1.,0.))+vec3f(1e-4,0.,0.)),n/max(nl,1e-5),nl>.02);
 let depth=max(.05,-pv.z);let px=2.*depth/(T.proj[1][1]*T.p.z);
 let tip=T.p.x-.12-arc;let cap=.35;let t=clamp(tip/cap,0.,1.);let taper=sqrt(1.-(1.-t)*(1.-t));let start=sqrt(clamp(arc/cap,0.,1.));
 let w=9.*min(taper,max(start,.08));pv=vec4f(pv.xyz+n*side*w*px,1.);var o:VO;o.pos=T.proj*pv;o.side=side;o.tip=tip;o.half=w;return o;}
@fragment fn fs(v:VO)->@location(0) vec4f{if(v.tip<0.){discard;}let d=abs(v.side);let px=d*v.half;
 let core=1.-smoothstep(.55,1.25,px);let g=exp(-d*d*6.)*(1.-smoothstep(.8,1.,d));
 let col=(T.glow.rgb*g*.95+vec3f(1.)*core)*3.;let a=clamp(core+g*.35,0.,1.)*T.p.y;return vec4f(col*T.p.y,a);}
`;


