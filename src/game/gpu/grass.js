import {FRAME,COMMON} from './shaders-common.js';
// Real-blade grass. Clump-based placement (after Ghost of Tsushima, GDC 2021) with physically sized blades:
// 2-5 mm wide ryegrass/poa leaves, 6-18 cm in the rough, V-folded with a midrib, twisted and drooping,
// plus sparse seed stalks. Three rings: an ultra-dense 4.5 m field (~12k blades/m^2) for every surface,
// a dense near ring and a thinned far ring whose survivors widen to keep coverage.
// Shading: midrib/vein detail across the leaf, Kajiya-Kay sheen along the blade, translucency,
// canopy occlusion that deepens toward the base, sun shadows (terrain, objects, clouds).
/* three draw lists by 3D distance: near (<9-14 m, 16 verts), mid (<22-28 m, and tall fescue/stalks to ~50 m: 10 verts), far (6 verts) */
export const CHUNK=32;   // blades per instance in the chunked draws
import {BUDGET} from './budget.js';
const GS=n=>Math.round(n*BUDGET.grass/CHUNK)*CHUNK;   /* LOWMEM: ~30% blade pools (buffers are 96 B/blade) */
export const MAX_NEAR=GS(1000000),NEAR_PP_MAX=GS(600000),NEAR_PP_R=4,MAX_MID=GS(600000),MAX_FAR=GS(1000000),MAX_BLADES=MAX_NEAR+MAX_MID+MAX_FAR;
const GR=/*wgsl*/`
struct Blade{a:vec4f,b:vec4f,c:vec4f,d:vec4u}  // a: base xyz, height | b: yaw, width, kind(+10 = seed stalk), shadow | c: lean xz, clump hue, seed
struct Ring{origin:vec2f,cell:f32,count:f32,inner:f32,outer:f32,shortMax:f32,mode:f32}
@group(1) @binding(0) var<storage,read_write> blades:array<Blade>;
@group(1) @binding(1) var<storage,read_write> counter:array<atomic<u32>,16>;
@group(1) @binding(2) var<uniform> R:Ring;
@group(1) @binding(3) var<storage,read_write> lit:array<vec4u>;   // per blade: ground-canopy lighting at vis 0 and 1 (2 x vec4u, half floats)
`;
export const GRASS_CS=FRAME+COMMON+GR+/*wgsl*/`
fn params(k:f32,r:f32)->vec3f{ // height(m), density, clump size (m)
 if(k==2.){return vec3f(.022+r*.012,1.,.1);}    // fairway
 if(k==4.){return vec3f(.024+r*.012,1.,.1);}     // tee
 if(k==3.){return vec3f(.008+r*.004,1.,.05);}   // green
 if(k==8.){return vec3f(.3+r*.3,1.,.6);}       // fescue
 if(k==7.){return vec3f(.14+r*.12,.55,.4);}     // woodland floor
 if(k==5.||k==6.||k==9.||k==10.){return vec3f(0.);}
 return vec3f(.0525+r*.049,1.,.26);}               // rough
// per-blade variants of the ground's contact shadow / near AO: the clipmap height cache (4 taps) instead of the full
// B-spline + relief + bunker height, and beyond 20 m the contact march's short form (7 longer steps, same reach)
fn contactShadowB(p:vec3f,far:bool)->f32{if(pk(0u)){return 1.;}let d=distance(p,F.camPos.xyz);if(d>70.){return 1.;}let s=F.sunDir.xyz;if(s.y<=-.02){return 0.;}
 let fl=far||fastLit();let cone=sunCone()*select(1.,1.35,fl);var o=p+vec3f(0.,.02,0.);o.y=max(o.y,shapeHC(p.xz)+.02);var t=select(.025,.045,fl);var sh=1.;
 let steps=select(10,7,fl);let gr=select(1.95,2.6,fl);
 for(var i=0;i<steps;i++){let q=o+s*t;let h=shapeHC(q.xz);sh=min(sh,clamp((q.y-h)/(t*cone+.008)+.5,0.,1.));t*=gr;}
 return mix(sh,1.,smoothstep(50.,70.,d));}
fn nearAOC(p:vec3f)->f32{if(pk(1u)){return 1.;}let d=distance(p,F.camPos.xyz);if(d>30.){return 1.;}var occ=0.;let rot=hash21(floor(p.xz*7.))*1.57;
 for(var k=0;k<4;k++){let an=f32(k)*1.5708+rot;let dir=vec2f(cos(an),sin(an));var mx=0.;
  for(var j=0;j<select(2,1,fastLit());j++){let r=select(.35*pow(3.2,f32(j)),.75,fastLit());let dh=shapeHC(p.xz+dir*r)-p.y;mx=max(mx,dh/sqrt(dh*dh+r*r));}occ+=max(mx,0.);}
 return mix(clamp(1.-occ*.3,.2,1.),1.,smoothstep(20.,30.,d));}
@compute @workgroup_size(8,8) fn scatter(@builtin(global_invocation_id) id:vec3u){
 let n=u32(R.count);if(id.x>=n||id.y>=n){return;}
 let cellId=vec2f(id.xy)+floor(R.origin/R.cell);
 let xz=(cellId+vec2f(ihash(cellId,11u),ihash(cellId,23u)))*R.cell;
 // rings, density and LOD all run on the true 3D camera distance: from high up nothing below is 'near'
 let hn=F.extra.y;let y0=textureLoad(heightMap,vec2i(clamp(boxUV(xz),vec2f(0.),vec2f(.9999))*hn),0).r;
 let d=distance(vec3f(xz.x,y0,xz.y),F.camPos.xyz);if(d<R.inner||d>R.outer){return;}
 {let c0=vec3f(xz.x,y0,xz.y);for(var i=0;i<6;i++){if(dot(F.frustum[i].xyz,c0)+F.frustum[i].w< -3.){return;}}}
 let D=select(8264.*pow(max(d,1.5)/1.5,-1.15),261.*pow(30./d,2.5),d>30.);let dk=min(D*R.cell*R.cell,1.);
 if(ihash(cellId,101u)>dk){return;}   /* the final keep test (below) is this same hash against dk x factors <= 1: reject the thinned-out cells before any surface, silhouette or clump work */
 let sm=surfMask(xz);let dith=ihash(cellId,57u);let dq=.5+(dith-.5)*.18;if(sm.g>.499||sm.b>dq){return;}   /* bunker: grass grows right up to the edge (roots stop 1.5 cm short), never in the sand */   // near-hard threshold on the AA mask: clean polygon edges with a slight natural wobble
 var k=kindAt(xz);if(k==2.||k==3.||k==4.||k==1.||k==0.){k=select(1.,select(select(2.,4.,k==4.),3.,sm.a>dq),sm.r>dq);}
 let pr0=params(k,.5);if(pr0.x<=0.){return;}
 let short=pr0.x<.05;if(short){return;}   // mown turf is drawn by the shell pass (turf.js)
 // one continuous target density (blades/m^2) across all rings -> no seams; each ring keeps D*cell^2
 // Blades live only where they read as blades: tall enough on screen (>= ~3 px for the kind's nominal height, sinking into the
 // sward below that, gone under ~2 px), or on a silhouette (ground seen at a grazing angle: crests, banks and edges standing
 // against sky, sea or distant ground). Everywhere else the ground's sward material (relief, tussocks, self-shadow) carries it.
 let fpx=d*F.res.w*1.5;let hpxN=pr0.x/fpx;var sink=smoothstep(1.8,3.2,hpxN);var silKeep=0.;
 if(sink<.999&&d>5.){let e=.8;let c1=vec3f(xz.x,shapeHC(xz),xz.y);
  let gn=normalize(vec3f(shapeHC(xz-vec2f(e,0.))-shapeHC(xz+vec2f(e,0.)),2.*e,shapeHC(xz-vec2f(0.,e))-shapeHC(xz+vec2f(0.,e))));
  silKeep=1.-smoothstep(.12,.3,dot(normalize(F.camPos.xyz-c1),gn));}
 sink=max(sink,silKeep);if(sink<.03){return;}
 let cs=pr0.z;let g=floor(xz/cs);var best=1e9;var cc=vec2f(0);var cid=vec2f(0);
 for(var j=-1;j<=1;j++){for(var i=-1;i<=1;i++){let q=g+vec2f(f32(i),f32(j));let c=(q+hash22(q*1.37+.5))*cs;let dd=distance(c,xz);if(dd<best){best=dd;cc=c;cid=q;}}}
 if(k==1.||k==8.){   /* fescue boundary: judge the stand from a jittered, domain-warped point so the 1 m map texels never show as steps */
  let jw=(vec2f(ihash(cellId,401u),ihash(cellId,409u))-.5)*2.2+(tn(xz*.23).rg-.5)*4.;let kf=kindAt(xz+jw);k=select(1.,8.,kf==8.);}
 let cr=hash21(cid*2.17+.3);if(k==8.&&cr<.28){k=1.;}   /* a native stand is tussocks with rough-height grass between them, never bare ground */let pr=params(k,cr);
 let clumpDen=1.-smoothstep(.55,1.,best/cs)*.5;
 let far=clamp((d-R.inner)/max(R.outer-R.inner,.01),0.,1.);
 var keep=pr.y*clumpDen;
 keep*=dk;if(short){keep*=1.-smoothstep(R.shortMax*.6,R.shortMax,d)*.85;}
 keep*=1.-smoothstep(R.outer*.85,R.outer,d)*step(80.,R.outer);  // only the outermost edge fades out
 if(ihash(cellId,101u)>keep){return;}
 let y=groundH(xz);   /* exact root height (B-spline + relief); slopes/silhouettes use the clipmap height cache */let hr=ihash(cellId,118u);
 var h=pr.x*(.5+1.1*hr*hr)*(1.-.3*smoothstep(.3,1.,best/cs));
 let edgeW=max(max(sm.r,select(sm.g,0.,bunkerNew(xz))),sm.b);   // rough grows full height right to a new-engine bunker edgeh*=mix(1.,.55,smoothstep(.12,.45,edgeW));   // blades step down toward mown/sand edges instead of stopping as a wall
 h*=sink;   // below ~3 px the stand sinks into the sward (shorter blades, same density), never thins to whiskers
 var kind=k;let stalk=!short&&ihash(cellId,999u)>.984;if(stalk){h*=1.9;kind=k+10.;}
 // screen-space LOD: a short rough blade under ~3 px tall is sub-pixel stipple whose tone already converges on the ground's
 // canopy shading (fs gcol); thin those out with a dithered fade instead of drawing them (tall fescue and stalks keep their profile)
 let c=vec3f(xz.x,y+h*.5,xz.y);
 for(var i=0;i<6;i++){if(dot(F.frustum[i].xyz,c)+F.frustum[i].w< -h-.25){return;}}
 let nearList=d<9.+5.*ihash(cellId,77u);var idx=0u;
 /* the near list is split at scatter time: within ~NEAR_PP_R m (dithered +-25% per blade so the hand-over has no line) blades
    keep per-pixel shading (midrib, veins, sheen, glints); beyond, where a blade is under ~2.5 px wide and that detail is
    sub-pixel, they go to a second near list (filled from the top of the near range) drawn with the per-vertex lit shader */
 if(nearList){if(d<${NEAR_PP_R.toFixed(2)}*(.75+.5*ihash(cellId,169u))){idx=atomicAdd(&counter[0],1u);if(idx>=${NEAR_PP_MAX}u){return;}}else{let j=atomicAdd(&counter[12],1u);if(j>=${MAX_NEAR-NEAR_PP_MAX}u){return;}idx=${MAX_NEAR-1}u-j;}}else if(d<22.+6.*ihash(cellId,79u)||((kind==8.||stalk)&&d<50.)){let j=atomicAdd(&counter[2],1u);if(j>=${MAX_MID}u){return;}idx=${MAX_NEAR}u+j;}else{let j=atomicAdd(&counter[8],1u);if(j>=${MAX_FAR}u){return;}idx=${MAX_NEAR+MAX_MID}u+j;}
 let sh=terrainShadowCached(vec3f(xz.x,y,xz.y))*contactShadowB(vec3f(xz.x,y+h*.6,xz.y),d>20.);
 var lean=(xz-cc)/max(best,.001)*min(best/cs,1.)*.55+(vec2f(ihash(cellId,301u),ihash(cellId,307u))-.5)*.5;
 // near a bunker edge no blade may lean out over the sand: cap the lean toward the edge by the room the root has
 if(sm.g>.3){let e=.05;let gg=vec2f(surfMask(xz+vec2f(e,0.)).g-surfMask(xz-vec2f(e,0.)).g,surfMask(xz+vec2f(0.,e)).g-surfMask(xz-vec2f(0.,e)).g);
  if(dot(gg,gg)>1e-10){let gi=normalize(gg);let room=max(-(sm.g-.5)*1.2,0.);lean-=gi*max(dot(lean,gi)-room/max(h,.01),0.);}}
 var w=select(.0036,.0015,short)*(.6+.8*ihash(cellId,135u));if(stalk){w=.0011;}
 w*=min(sqrt(8264./D)*mix(1.,.8,smoothstep(0.,4.,d)),3.2);if(short){w*=1.35+d*.02;}
 // per-blade constants resolved once here instead of in every vertex: ground albedo, sky visibility/dryness, ground normal
 let gc=textureSampleLevel(baseMap,linSamp,boxUV(xz),0.).rgb;let su=(xz-F.satBox.xy)/F.satBox.z;let sc=textureSampleLevel(satMap,linSamp,su,1.).rgb;let mcol=mix(gc,sc,.6*F.extra.x);
 let ga0=groundAO(xz);let ga=vec2f(ga0.x*nearAOC(vec3f(xz.x,shapeHC(xz),xz.y)),ga0.y);   /* H5 (shade whiskers): the ground's sky light carries near-field AO, the blades growing from it didn't: invisible in sun, 2-5x brighter blades in shade. Same occlusion for the whole sward, resolved once per blade */let e=.5;let gn=normalize(vec3f(shapeHC(xz-vec2f(e,0.))-shapeHC(xz+vec2f(e,0.)),2.*e,shapeHC(xz-vec2f(0.,e))-shapeHC(xz+vec2f(0.,e))));
 var mfb:vec3f;var sg=0.;if(F.mclip[7].x>.5){let mb=mcLean(xz,d*F.res.w,max(abs(xz.x-F.camPos.x),abs(xz.y-F.camPos.z))).b;mfb=vec3f(mb.x*MAT_STRENGTH,normalize(mb.yz*2.-1.+vec2f(1e-5,0.)));sg=mb.w*2.;}else{mfb=matField(xz);sg=surfGain(xz);}   /* the ground's baked material cache (the same matting field + reflectance the terrain reads): 2 taps instead of 9 noise octaves */   /* matting field (9 value-noise octaves) and surface reflectance: static, once per blade here instead of per vertex and per pixel */
 // the blade's canopy lighting (shared ground normal): shadeSplit is linear in the sun visibility, so the lit/unlit pair
 // reproduces it for any per-vertex visibility. Once per blade here instead of in all 10-16 vertices every frame.
 {var G:LitSurf;G.p=vec3f(xz.x,y+h*.5,xz.y);G.n=gn;G.alb=vec3f(1.);G.rough=.78;G.f0=.035;G.canopy=1.;G.trans=.12;G.ao=ga.x;G.vis=0.;let L0=shadeSplit(G);G.vis=1.;let L1=shadeSplit(G);
  lit[idx*2u]=vec4u(pack2x16float(L0.d.xy),pack2x16float(vec2f(L0.d.z,L1.d.x)),pack2x16float(L1.d.yz),pack2x16float(L0.s.xy));
  lit[idx*2u+1u]=vec4u(pack2x16float(vec2f(L0.s.z,L1.s.x)),pack2x16float(L1.s.yz),0u,0u);}
 blades[idx]=Blade(vec4f(xz.x,y,xz.y,h),vec4f(ihash(cellId,152u)*6.2832,w,kind,sh),vec4f(lean,cr,ihash(cellId,169u)),vec4u(pack4x8unorm(vec4f(sqrt(clamp(mcol,vec3f(0.),vec3f(1.))),0.)),pack2x16unorm(ga),pack2x16snorm(gn.xz),pack4x8unorm(vec4f(mfb.x/MAT_STRENGTH,mfb.yz*.5+.5,sg))));
}
@compute @workgroup_size(1) fn finish(){atomicStore(&counter[1],min(atomicLoad(&counter[0]),${NEAR_PP_MAX}u));atomicStore(&counter[13],min(atomicLoad(&counter[12]),${MAX_NEAR-NEAR_PP_MAX}u));atomicStore(&counter[14],(atomicLoad(&counter[13])+${CHUNK}u-1u)/${CHUNK}u);atomicStore(&counter[3],min(atomicLoad(&counter[2]),${MAX_MID}u));atomicStore(&counter[9],min(atomicLoad(&counter[8]),${MAX_FAR}u));let K=${CHUNK}u;atomicStore(&counter[7],(atomicLoad(&counter[1])+K-1u)/K);atomicStore(&counter[10],(atomicLoad(&counter[3])+K-1u)/K);atomicStore(&counter[11],(atomicLoad(&counter[9])+K-1u)/K);
 let sk=ambientSky(vec3f(0.,1.,0.));atomicStore(&counter[4],bitcast<u32>(sk.x));atomicStore(&counter[5],bitcast<u32>(sk.y));atomicStore(&counter[6],bitcast<u32>(sk.z));}
`;
const GRASS_RS0=FRAME+COMMON+/*wgsl*/`
struct Blade{a:vec4f,b:vec4f,c:vec4f,d:vec4u}
@group(1) @binding(0) var<storage,read> blades:array<Blade>;
fn sn(x:vec3f)->vec3f{return x*inverseSqrt(max(dot(x,x),1e-12));}   // NaN-safe normalize
fn sn2(x:vec2f)->vec2f{return x*inverseSqrt(max(dot(x,x),1e-12));}
/* Lean vertex interface (perf): on a tile-based GPU every vertex output is written to memory before rasterising, so the
   per-blade constants (kind, seed, hue, matting, ground colour / AO / normal, canopy lighting) are no longer copied into all
   15 vertices of each blade: the fragment shader reads them once from the blade buffers through a flat blade index. */
struct VO{@builtin(position) pos:vec4f,@location(0) wp:vec3f,@location(1) n:vec3f,@location(2) t:f32,@location(3) @interpolate(flat) bi:u32,@location(4) gust:f32,@location(5) side:f32,@location(6) tang:vec3f,@location(7) light:f32,@location(14) bpx:f32}
@group(1) @binding(1) var<storage,read> GI:array<u32,16>;
@group(1) @binding(2) var<storage,read> lit:array<vec4u>;   // sky irradiance (up), computed once per scatter
const SEG=7u;
fn bez(a:vec3f,b:vec3f,c:vec3f,t:f32)->vec3f{let u=1.-t;return u*u*a+2.*u*t*b+t*t*c;}
fn bezD(a:vec3f,b:vec3f,c:vec3f,t:f32)->vec3f{return 2.*(1.-t)*(b-a)+2.*t*(c-b);}
fn bladeVert(vi:u32,ii:u32)->VO{
 let B=blades[ii];let base=B.a.xyz;let h=B.a.w;let yaw=B.b.x;let pw=u32(F.perf.w);let kk0=select(B.b.z,B.b.z-10.,B.b.z>=10.);let isFescue=abs(kk0-8.)<.5;
 let bw=select(.6*f32(pw%1000u)/100.,2.*f32(pw/1000u)/100.,isFescue);let w=B.b.y*max(bw,.05);   /* blade width: fescue x2, rough x0.6 by design, each times its Visual debug slider (packed rough%1000, fescue/1000, in hundredths) */let lean=B.c.xy;let seed=B.c.w;let stalk=B.b.z>=10.;
 let seg=f32(vi/2u);let side=select(f32(vi%2u)*2.-1.,0.,vi>=2u*SEG);   /* one tip vertex on the midrib */let t=min(seg/f32(SEG),1.);
 let wd=normalize(F.wind.xy+vec2f(1e-4));let tt=F.camPos.w;
 let gp=dot(base.xz,wd)*.09-tt*1.1;let gust=clamp(vnoise(vec2f(gp,dot(base.xz,vec2f(-wd.y,wd.x))*.05))*1.4-.2,0.,1.);
 let flutter=sin(tt*3.3+seed*20.+dot(base.xz,vec2f(.7,.4)))*.07;
 let windPush=(F.wind.z*(.3+gust*1.1)+flutter)*wd;
 // droop: longer leaves arch over; stalks stay upright
 let droop=select(.35+seed*.9,.12,stalk)*smoothstep(.04,.14,h);
 // Matted patches: irregular clumps (domain-warped noise, ~0.4–1.5 m) where blades lie over together along one shared
 // lay direction that drifts slowly across the lawn. Coherent within a patch, varied between patches.
 let mp=unpack4x8unorm(B.d.w);let mfd=vec3f(mp.x*MAT_STRENGTH,sn2(mp.yz*2.-1.));let mat=select(mfd.x,0.,stalk||h<.03);let lay=mfd.yz;
 let bendDir=mix(lean*(.7+droop),lay*1.4,mat)+windPush*(1.-.6*mat);let bend=min(length(bendDir),1.45);
 let dirXZ=select(vec2f(0.,1.),bendDir/max(length(bendDir),1e-4),length(bendDir)>1e-4);
 let tipOff=vec3f(dirXZ.x,0.,dirXZ.y)*bend*h*.8;let tipH=h*(1.-.5*bend*bend*.6);
 let p0=base;let p2=base+vec3f(0.,max(tipH,h*.15),0.)+tipOff;let p1=base+vec3f(0.,h*.7,0.)+tipOff*.2;
 let pos=bez(p0,p1,p2,t);let tang=sn(bezD(p0,p1,p2,t));
 // leaf plane: random yaw with a slight turn toward the eye, twisting along its length
 let toCam=sn2(F.camPos.xz-base.xz);let ry=sn2(mix(vec2f(cos(yaw),sin(yaw)),vec2f(-lay.y,lay.x),mat*.85));/* matted leaves lie flat across their lay */let face=sn2(mix(ry,vec2f(-toCam.y,toCam.x),.22));
 let tw=(seed-.5)*1.6*t;let cf=cos(tw);let sf=sin(tw);let face2=vec2f(face.x*cf-face.y*sf,face.x*sf+face.y*cf);
 let across=vec3f(face2.x,0.,face2.y);
 // leaf outline: widest ~30% up, long pointed tip
 let prof=select(sin(min(t*1.9+.25,PI*.5+.2))*(1.-smoothstep(.45,1.,t)*.96),(1.-t*.5)+smoothstep(.72,.82,t)*(1.-smoothstep(.93,1.,t))*2.6,stalk);
 // blades never go thinner than ~0.8 px: sub-pixel blades are what shimmer; thicker far blades are darkened to keep coverage
 let pxw=distance(base,F.camPos.xyz)*F.res.w*.8*sqrt(bw);let width=max(w,pxw)*prof*select(1.,0.,seg>=f32(SEG));
 let p=pos+across*side*width;
 var nrm=cross(across,tang);nrm=select(sn(nrm),vec3f(0.,1.,0.),dot(nrm,nrm)<1e-10);   // not flipped per vertex: mixed flips interpolate through zero (NaN). Flipped per pixel in fs.
 nrm=sn(nrm+across*side*.45);          // V-folded leaf: normals tilt away from the midrib
 var o:VO;o.bpx=w/max(pxw/.8,1e-6);   /* blade's true width in pixels */
 o.pos=F.viewProj*vec4f(p,1.);o.wp=p;o.n=nrm;o.t=t;o.bi=ii;o.gust=gust;o.side=side;o.tang=tang;
 // lighting inputs evaluated per vertex (16 per blade) instead of per pixel
 o.light=B.b.w*objShadowFast(p)*cloudShadow(base);
 return o;}
fn palette(k:f32,hue:f32,seed:f32)->vec3f{
 if(k==8.){let c=mix(vec3f(.15,.19,.1),vec3f(.34,.35,.21),hue);return select(c,vec3f(.4,.34,.2),seed>.82);}   // native coastal cover: grey-green/olive, a few sun-dried tan blades
 if(k==2.||k==4.){return mix(vec3f(.09,.21,.045),vec3f(.18,.32,.075),hue);}
 if(k==3.){return mix(vec3f(.08,.21,.05),vec3f(.15,.3,.07),hue);}
 let h2=fract(hue*7.13+seed*3.1);var c=mix(vec3f(.1,.2,.045),vec3f(.22,.34,.08),hue);
 c=mix(c,vec3f(.3,.36,.12),step(.85,h2)*.55);c=mix(c,vec3f(.07,.16,.06),step(h2,.12)*.5);return c;}
fn bladeColor(v:VO)->vec4f{
 let BB=blades[v.bi];let info=vec4f(BB.b.z,BB.b.w,BB.c.w,BB.c.z);
 let mp=unpack4x8unorm(BB.d.w);let mfd=vec3f(mp.x*MAT_STRENGTH,sn2(mp.yz*2.-1.));let mf=vec4f(select(mfd.x,0.,BB.b.z>=10.||BB.a.w<.03),mfd.x,mp.w,atan2(mfd.z,mfd.y));
 let mc=unpack4x8unorm(BB.d.x).rgb;let macroColV=mc*mc;let gao=unpack2x16unorm(BB.d.y);let gxz=unpack2x16snorm(BB.d.z);let gNv=vec3f(gxz.x,sqrt(max(1.-dot(gxz,gxz),0.)),gxz.y);
 var GLd:vec3f;var GLs:vec3f;{let q0=lit[v.bi*2u];let q1=lit[v.bi*2u+1u];let a=unpack2x16float(q0.x);let b=unpack2x16float(q0.y);let c=unpack2x16float(q0.z);let e=unpack2x16float(q0.w);let f=unpack2x16float(q1.x);let g=unpack2x16float(q1.y);
  GLd=mix(vec3f(a,b.x),vec3f(b.y,c),v.light);GLs=mix(vec3f(e,f.x),vec3f(f.y,g),v.light);}   // canopy lighting from the scatter, at this pixel's visibility
 let vt=clamp(v.t,0.,1.);   // perspective interpolation on near-clipped blades can overshoot 0..1; pow() of a negative is NaN
 var k=info.x;let stalk=k>=10.;if(stalk){k-=10.;}let seed=info.z;let hue=info.w;
 let sh=v.light;
 var alb=palette(k,hue*.65+seed*.35,seed);
 if(k==1.){alb=mix(alb,vec3f(.42,.38,.16)*(.8+.4*hue),gao.y*(.35+.5*seed)*.8);}   // sun-bleached crests
 let macroCol=macroColV;let ml=dot(macroCol,vec3f(.3,.5,.2));
 alb*=mix(1.,clamp(ml/.13,.7,1.3),.45);
 let shortK=k==2.||k==3.||k==4.;if(shortK){alb=mix(alb,macroCol*(1.02+.3*seed),.55);}
 if(stalk){alb=mix(vec3f(.42,.38,.2),vec3f(.3,.3,.14),seed);alb=mix(alb,vec3f(.36,.3,.16),smoothstep(.72,.8,vt));}
 // leaf detail: bright midrib, darker margins, fine parallel veins; occasional brown dieback at the tip
 let a=abs(v.side);let rib=1.-smoothstep(0.,.18,a);let veins=.5+.5*sin(v.side*23.+seed*9.);
 let ffar=smoothstep(6.,45.,distance(v.wp,F.camPos.xyz));   // leaf detail and tip highlights melt away with distance
 alb*=mix(RIBTERM,.9,ffar);
 if(seed>.9&&!shortK){alb=mix(alb,vec3f(.33,.25,.12),smoothstep(.72,1.,vt)*.8*(1.-smoothstep(2.,10.,distance(v.wp,F.camPos.xyz))));}
 alb=mix(alb,alb*vec3f(1.14,1.12,.86),smoothstep(.5,1.,vt)*.35*(1.-ffar));
 let s0=F.sunDir.xyz;let vd=sn(F.camPos.xyz-v.wp);var n=sn(v.n);if(dot(n,vd)<0.){n=-n;}let T=sn(v.tang);
 // Blades are lit partly as a canopy on the terrain (shared normal, like a lawn seen from afar) and fully so with distance.
 // Their tone therefore converges on the ground they grow from instead of standing out as light/dark whiskers at any sun angle.
 let gN=sn(gNv);let ndlG=max(dot(gN,s0),0.);
 let ndl=mix(clamp(dot(n,s0)*.65+.35,0.,1.),ndlG,.3+.65*ffar);
 let back=pow(clamp(dot(-vd,s0),0.,1.),4.)*.45*(.25+.75*vt)*(1.-smoothstep(3.,12.,distance(v.wp,F.camPos.xyz)));
 // canopy occlusion: light is absorbed toward the base of a dense sward
 let ao=mix(mix(select(.1,.4,shortK),1.,pow(vt,.75)),.92,mf.x*.8);   // upright clumps shade their own bases; matted leaves lie open to the sky
 // H1 (posterization): a distant blade is 1 px wide, so its dark base (ao .1) lands as an isolated black dash on the flat ground
 // between blades -> two-tone stipple. The pixel footprint already spans the whole canopy depth: use the sward's mean occlusion.
 let pxf=smoothstep(2.5,.9,v.bpx);   // H3: blade footprint, not metres: a blade under ~1.5 px can't show its own base-to-tip shading whatever its distance
 let aoFar=select(.55,.7,shortK);let aoF=mix(ao,aoFar,max(smoothstep(8.,30.,distance(v.wp,F.camPos.xyz)),pxf)*.85);
 // Kajiya-Kay sheen along the leaf (waxy cuticle), plus a tight glint
 let hv=sn(vd+s0);let th=dot(T,hv);let kk=pow(sqrt(max(1.-th*th,0.)),14.)*.12*(1.-smoothstep(3.,14.,distance(v.wp,F.camPos.xyz)));   // waxy cuticle sheen: broad lobe; matted patches share tangents so the whole patch catches it   // glints fade before they turn into sparkle
 alb=mix(alb,alb*vec3f(1.1,1.1,.98),mf.x*.35);   // matted leaves show paler undersides
 // ---- lighting engine: the blade is a canopy element on its ground normal, lit by the same shade() as the terrain
 let dist=distance(v.wp,F.camPos.xyz);
 let keep=select(1.,0.,pk(16u));   /* pk16 = old flat far-field (A/B) */
 var S:LitSurf;S.p=v.wp;S.n=sn(mix(n,gN,.35+mix(.6,.3,keep)*ffar));S.alb=alb*mix(1.,1.1,mf.x*.35);S.rough=select(specAARough(S.n,mix(.55,.95,smoothstep(1.5,.3,v.bpx))),mix(.55,specAARough(S.n,.55),.35),F.perf.z>.5);   /* under TAA the temporal filter integrates the glints: keep them sharp (light spec AA only) */   /* blade-footprint roughness (LEAN/Toksvig-style): a pixel covering many thin blades reflects like their average */S.f0=.035;S.canopy=mix(mix(.55,mix(1.,.8,keep),ffar),1.,pxf);   // H4 (shade whiskers): canopy .8 left 7x the ground's sky reflection (1-.97*canopy) on sub-pixel blades; invisible in sun, it dominates in shade. A ~1 px blade reflects like the sward (=ground)
 S.trans=.45*(.25+.75*vt)*(1.-ffar);S.ao=aoF*gao.x;S.vis=sh;
 var c=S.alb*GLd+GLs;   // per-vertex canopy lighting (from the scatter); the full per-pixel engine only where a blade is big enough to show it
 // far or sub-pixel blades converge on the ground's shading anyway (see gcol below), so the per-pixel shade() fades out over 16-28 m
 let fullK=select(1.-max(smoothstep(16.,28.,dist),smoothstep(.55,.95,pxf)),0.,pk(11u));if(fullK>.001){c=mix(c,shade(S),fullK);}c+=F.sunColor.rgb*kk*sh*vt*vec3f(.9,.95,.8);
 c*=1.+v.gust*.1;
 // with distance the blades converge on exactly the terrain's rough shading (same material, same engine)
 let gcol=roughAlb(macroCol,gao.y)*(.82+.18*gao.x)*roughMottle(v.wp.xz,dist*F.res.w*1.5/sqrt(max(abs(vd.y),.08)))*GLd+GLs;   // same sward mottling as the ground under it
 c=mix(c,gcol,max(smoothstep(3.,40.,dist),pxf)*mix(.95,.88,keep));   // H2: pulled only 55% before, so far blades sat ~35% darker than the ground between them -> one-sided dark stipple (posterized look); now they centre on it and the per-blade tone below gives the +- spread
 // per-blade tone that survives distance (Ghost-style): each blade keeps its own brightness offset and a sunlit tip, so a
 // distant sward reads as many blades catching the light rather than one flat sheet
 let tsp=select(.18,.3,k==8.);c*=mix(1.,1.-tsp+2.*tsp*fract(seed*7.13+hue*3.1),keep*max(ffar,pxf))*mix(1.,1.+.35*smoothstep(.55,1.,vt)*sh,keep*max(ffar,pxf));
 c*=matToneMF(vec3f(mf.y,cos(mf.w),sin(mf.w)),v.wp);   // patch tone applied to blades and (in the mesh shader) the ground under them alike
 let outc=fogApply(c*mf.z,v.wp);   // reflectance calibration (albedo scale; lighting is linear so this is exact)
 // Visual debug views (F.skyHorizon.z, set from the Visual debug menu). 0 = normal shading.
 let dm=i32(F.skyHorizon.z+.5);
 if(dm!=0){var o=outc;
  switch dm{
   case 1:{o=alb;} case 2:{o=F.sunColor.rgb*ndl*sh;} case 3:{o=vec3f(back);} case 4:{o=skyLight(gN,gao.x);} case 5:{o=vec3f(sh);}
   case 6:{o=vec3f(kk)*4.;} case 7:{o=c;} case 8:{o=c;} case 9:{o=n*.5+.5;} case 10:{o=T*.5+.5;} case 11:{o=gN*.5+.5;} case 12:{o=vec3f(ao);}
   case 13:{o=vec3f(.02,.06,.4);} case 14:{o=vec3f(matField(v.wp.xz).x);} case 15:{o=surfClassColor(v.wp.xz);} case 16:{o=vec3f(0.,2.,0.);}   // grass flat blue (pair with terrain red)
   default:{}
  }
  return vec4f(o,1.);}
 return vec4f(outc,1.);}
`;
/* Lit-per-vertex variant for the mid/far draw lists. On a tile-based GPU every vertex's outputs are written to memory
   before rasterizing: the full blade interface is ~45 floats/vertex. Beyond ~9-14 m a blade is a few px wide and its
   pixel shading has already converged on the ground's canopy shading (gcol), so the whole blade shader runs per vertex
   (10 or 6 per blade) and only the colour crosses to the rasterizer. Leaf-width detail uses its across-blade average. */
const FS_SRC=GRASS_RS0.slice(GRASS_RS0.indexOf('fn bladeColor('));
export const GRASS_RS=GRASS_RS0.replace('RIBTERM','.84+.22*rib+.06*veins-.1*smoothstep(.75,1.,a)')
 +FS_SRC.replace('fn bladeColor(','fn bladeColorPV(').replace('RIBTERM','.857').replaceAll('specAARough(','specAAv(')+/*wgsl*/`
fn specAAv(n:vec3f,r:f32)->f32{return r;}
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->VO{return bladeVert(vi,ii);}
@fragment fn fs(v:VO)->@location(0) vec4f{return bladeColor(v);}
/* per-vertex lit blades: colour + the across-leaf coordinate, so the leaf's midrib / margin shading (its RIBTERM profile, faded
   with distance exactly as the per-pixel path fades it) is still applied per pixel; the colour itself used the profile's mean */
struct VOL{@builtin(position) pos:vec4f,@location(0) col:vec3f,@location(1) rib:vec2f}
fn pvRib(o:VO)->vec2f{return vec2f(o.side,1.-smoothstep(6.,45.,distance(o.wp,F.camPos.xyz)));}
@vertex fn vsLit(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->VOL{let o=bladeVert(vi,ii);return VOL(o.pos,bladeColorPV(o).rgb,pvRib(o));}
@fragment fn fsLit(v:VOL)->@location(0) vec4f{let a=abs(v.rib.x);let rib=1.-smoothstep(0.,.18,a);let k=v.rib.y;
 let prof=(.84+.22*rib+.03-.1*smoothstep(.75,1.,a))/.857;return vec4f(v.col*mix(1.,prof,k*.85),1.);}
/* Chunked draws: a blade is 5-15 vertices, far too few to fill a vertex SIMD group per instance. Each instance
   instead carries CHUNK blades through a small shared index buffer (indexed triangle list, 2*SEG+1 vertices per
   blade with a single tip vertex); blade = instance*CHUNK + vertex/VB. Unused slots of the last chunk collapse. */
const VB=2u*SEG+1u;const CNT=1u;
const REV=0u;   // 1: the second near list, stored from the top of the near range down (see scatter)
fn bix(b:u32)->u32{return select(b,${MAX_NEAR-1}u-b,REV==1u);}
@vertex fn vsC(@builtin(vertex_index) vi:u32,@builtin(instance_index) ci:u32)->VO{let b=ci*${CHUNK}u+vi/VB;if(b>=GI[CNT]){var o:VO;o.pos=vec4f(2.,2.,2.,1.);return o;}return bladeVert(vi%VB,bix(b));}
@vertex fn vsLitC(@builtin(vertex_index) vi:u32,@builtin(instance_index) ci:u32)->VOL{let b=ci*${CHUNK}u+vi/VB;if(b>=GI[CNT]){return VOL(vec4f(2.,2.,2.,1.),vec3f(0.),vec2f(0.));}let o=bladeVert(vi%VB,bix(b));return VOL(o.pos,bladeColorPV(o).rgb,pvRib(o));}
`;

