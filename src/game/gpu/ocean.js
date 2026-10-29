import {FRAME,COMMON} from './shaders-common.js';
// Tessendorf FFT ocean: JONSWAP-ish (Phillips + spreading) spectrum, two cascades (swell 420 m, chop 47 m), 256^2 each.
// Per frame: row pass (builds h(k,t) and 4 packed complex fields, row IFFT in shared memory) -> column IFFT + resolve
// into displacement (dx,h,dz,Jacobian) and slope (sx,sz) textures sampled by the surface shader.
export const OCEAN_N=256;
const COMMONU=/*wgsl*/`
struct OU{L:f32,t:f32,lambda:f32,wind:f32,dir:vec2f,kmin:f32,kmax:f32,amp:f32,seed:f32,p0:f32,p1:f32}
@group(0) @binding(0) var<uniform> U:OU;
const N=${OCEAN_N}u;const PI=3.14159265;const G=9.81;
fn kvec(id:vec2u)->vec2f{let n=vec2f(f32(select(i32(id.x),i32(id.x)-i32(N),id.x>=N/2u)),f32(select(i32(id.y),i32(id.y)-i32(N),id.y>=N/2u)));return n*2.*PI/U.L;}
fn cmul(a:vec2f,b:vec2f)->vec2f{return vec2f(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
`;
export const OCEAN_INIT=COMMONU+/*wgsl*/`
@group(0) @binding(1) var h0tex:texture_storage_2d<rgba32float,write>;
fn hash(p:vec2u,s:u32)->f32{var v=p.x*1664525u+p.y*1013904223u+s*2654435761u;v^=v>>16u;v*=0x7feb352du;v^=v>>15u;v*=0x846ca68bu;v^=v>>16u;return (f32(v)+.5)/4294967296.;}
fn gauss(p:vec2u,s:u32)->vec2f{let u1=hash(p,s);let u2=hash(p,s+17u);let r=sqrt(-2.*log(u1));return vec2f(r*cos(2.*PI*u2),r*sin(2.*PI*u2));}
fn spec(k:vec2f)->f32{let kl=length(k);if(kl<U.kmin||kl>=U.kmax||kl<1e-5){return 0.;}
 let Lw=U.wind*U.wind/G;let kh=k/kl;let c=dot(kh,U.dir);
 var spread=pow(max(c,0.),4.)*.95+pow(abs(c),2.)*.05;             // mostly downwind, a little crosswind energy
 let S=.0081/2./pow(kl,4.)*exp(-1./(kl*Lw*kl*Lw))*exp(-kl*kl*.0004)*spread*2.7;
 let dk=2.*PI/U.L;return sqrt(max(S,0.)*dk*dk)*U.amp;}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x>=N||id.y>=N){return;}
 let k=kvec(id.xy);let a=gauss(id.xy,u32(U.seed))*spec(k);
 let mid=vec2u((N-id.x)%N,(N-id.y)%N);let b=gauss(mid,u32(U.seed))*spec(-k);
 textureStore(h0tex,id.xy,vec4f(a,b.x,-b.y));}   // h0(k), conj(h0(-k))
`;
// shared-memory radix-2 IFFT over one line of 256 for 4 complex channels
const FFTLINE=/*wgsl*/`
var<workgroup> S:array<array<vec2f,4>,${OCEAN_N}>;
fn rev(i:u32)->u32{return reverseBits(i)>>(32u-8u);}
fn fft(t:u32){for(var s=1u;s<=8u;s++){let m=1u<<s;let half=m>>1u;
  if(t<N/2u){let grp=t/half;let j=t%half;let i0=grp*m+j;let i1=i0+half;let a=-2.*PI*f32(j)/f32(m)*-1.;let w=vec2f(cos(a),sin(a));
   for(var c=0;c<4;c++){let x=S[i0][c];let y=cmul(S[i1][c],w);S[i0][c]=x+y;S[i1][c]=x-y;}}
  workgroupBarrier();}}
`;
export const OCEAN_ROWS=COMMONU+FFTLINE+/*wgsl*/`
@group(0) @binding(1) var h0tex:texture_2d<f32>;
@group(0) @binding(2) var outA:texture_storage_2d<rgba32float,write>;
@group(0) @binding(3) var outB:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(${OCEAN_N/2}) fn main(@builtin(local_invocation_id) lid:vec3u,@builtin(workgroup_id) wg:vec3u){
 let y=wg.x;for(var r=0u;r<2u;r++){let x=lid.x*2u+r;let id=vec2u(x,y);let h0=textureLoad(h0tex,vec2i(id),0);let k=kvec(id);let kl=max(length(k),1e-6);
  let w=sqrt(G*kl);let ph=w*U.t;let e=vec2f(cos(ph),sin(ph));let h=cmul(h0.xy,e)+cmul(h0.zw,vec2f(e.x,-e.y));
  let ih=vec2f(-h.y,h.x);                                   // i*h
  let dx=-ih*k.x/kl;let dz=-ih*k.y/kl;let sx=ih*k.x;let sz=ih*k.y;let dxx=h*k.x*k.x/kl;let dzz=h*k.y*k.y/kl;let dxz=h*k.x*k.y/kl;
  let A=h+vec2f(-dx.y,dx.x);let B=dz+vec2f(-sx.y,sx.x);let C=dxx+vec2f(-dzz.y,dzz.x);let D=dxz+vec2f(-sz.y,sz.x);
  let j=rev(x);S[j][0]=A;S[j][1]=B;S[j][2]=C;S[j][3]=D;}
 workgroupBarrier();fft(lid.x);
 for(var r=0u;r<2u;r++){let x=lid.x*2u+r;textureStore(outA,vec2i(i32(x),i32(y)),vec4f(S[x][0],S[x][1]));textureStore(outB,vec2i(i32(x),i32(y)),vec4f(S[x][2],S[x][3]));}}
`;
export const OCEAN_COLS=COMMONU+FFTLINE+/*wgsl*/`
@group(0) @binding(1) var inA:texture_2d<f32>;
@group(0) @binding(2) var inB:texture_2d<f32>;
@group(0) @binding(3) var disp:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var slope:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(${OCEAN_N/2}) fn main(@builtin(local_invocation_id) lid:vec3u,@builtin(workgroup_id) wg:vec3u){
 let x=wg.x;for(var r=0u;r<2u;r++){let y=lid.x*2u+r;let a=textureLoad(inA,vec2i(i32(x),i32(y)),0);let b=textureLoad(inB,vec2i(i32(x),i32(y)),0);
  let j=rev(y);S[j][0]=a.xy;S[j][1]=a.zw;S[j][2]=b.xy;S[j][3]=b.zw;}
 workgroupBarrier();fft(lid.x);
 for(var r=0u;r<2u;r++){let y=lid.x*2u+r;let A=S[y][0];let B=S[y][1];let C=S[y][2];let D=S[y][3];let l=U.lambda;
  let Jxx=1.-l*C.x;let Jzz=1.-l*C.y;let Jxz=-l*D.x;let J=Jxx*Jzz-Jxz*Jxz;
  textureStore(disp,vec2i(i32(x),i32(y)),vec4f(-l*A.y,A.x,-l*B.x,J));
  textureStore(slope,vec2i(i32(x),i32(y)),vec4f(B.y,D.y,0.,1.));}}
`;
// ---- surface
export const OCEAN_RS=FRAME+COMMON+/*wgsl*/`
@group(1) @binding(0) var d0:texture_2d<f32>;@group(1) @binding(1) var s0:texture_2d<f32>;
@group(1) @binding(2) var d1:texture_2d<f32>;@group(1) @binding(3) var s1:texture_2d<f32>;
@group(1) @binding(4) var<uniform> OPB:array<vec4f,2>;   // [0] L0, L1, enabled, time  [1] first segment of the outer rings' view sector, its segment count, first sector-drawn ring
@group(1) @binding(5) var sceneCol:texture_2d<f32>;@group(1) @binding(6) var sceneDep:texture_2d<f32>;   // opaque scene before the water: screen-space reflections
const RINGS=224u;const SEGS=448u;const SSR_N=14;const SSR_G=1.62;
struct VO{@builtin(position) pos:vec4f,@location(0) wp:vec3f,@location(1) base:vec2f,@location(2) h:f32}
fn ringR(i:f32)->f32{return .4*exp(i/f32(RINGS)*log(20000./.4))-.4;}
fn dispAt(xz:vec2f,d:f32)->vec4f{let a=textureSampleLevel(d0,linSamp,xz/OPB[0].x,0.);let b=textureSampleLevel(d1,linSamp,xz/OPB[0].y,0.);
 let f0=1.-smoothstep(2500.,9000.,d);let f1=1.-smoothstep(250.,700.,d);return vec4f(a.xyz*f0+b.xyz*f1,min(a.w,1.)*f0+(1.-f0)+ (b.w-1.)*f1);}
// Drawn instanced, one instance per ring: the inner rings (the camera can sit up to ~3 m off the grid centre, so every direction
// can be close) all around, the outer rings only across the view's azimuth sector (+ margin) instead of all 448 segments.
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->VO{var o:VO;let c=vi%6u;let qr0=ii;let qs0=select((u32(OPB[1].x)+vi/6u)%SEGS,vi/6u,ii<u32(OPB[1].z));
 // per-quad culling: drop quads outside the view frustum or buried under land (degenerate -> no rasterisation)
 {let qs=qs0;let qr=qr0;let r0=ringR(f32(qr));let r1=ringR(f32(qr+1u));let am=(f32(qs)+.5)/f32(SEGS)*6.2831853;
  let camq=floor(F.camPos.xz/2.)*2.;let cq=camq+vec2f(cos(am),sin(am))*(r0+r1)*.5;
  let rad=(r1-r0)*.5+(r0+r1)*.5*3.1416/f32(SEGS)+8.;let cc=vec3f(cq.x,F.box.w,cq.y);var out=false;
  for(var i=0;i<6;i++){if(dot(F.frustum[i].xyz,cc)+F.frustum[i].w< -rad){out=true;}}
  if(!out&&rad<40.){let u=boxUV(cq);if(all(u>vec2f(0.))&&all(u<vec2f(1.))&&landAt(cq)>.995&&groundH0(cq)>F.box.w+3.){out=true;}}
  if(out){o.pos=vec4f(0.,0.,-2.,1.);return o;}}let corner=array<vec2u,6>(vec2u(0,0),vec2u(1,0),vec2u(0,1),vec2u(0,1),vec2u(1,0),vec2u(1,1))[c];
 let seg=qs0+corner.x;let ring=qr0+corner.y;let r=ringR(f32(ring));let an=f32(seg)/f32(SEGS)*6.2831853;
 let cam=floor(F.camPos.xz/2.)*2.;let xz=cam+vec2f(cos(an),sin(an))*r;
 let d=distance(xz,F.camPos.xz);let lnd=landAt(xz);let D=dispAt(xz,d)*vec4f(1.-lnd*.8,1.-lnd*.8,1.-lnd*.8,1.);let sf=surf(xz,OPB[0].w);
 let p=vec3f(xz.x+D.x+sf.push.x,F.box.w+D.y+sf.h,xz.y+D.z+sf.push.y);o.pos=F.viewProj*vec4f(p,1.);o.wp=p;o.base=xz;o.h=D.y;return o;}
// ---- surf: shoaling breakers driven by distance to shore (baked land fraction in reliefMap.b)
fn landAt(xz:vec2f)->f32{let u=boxUV(xz);if(any(u<vec2f(0.))||any(u>vec2f(1.))){return 0.;}return textureSampleLevel(reliefMap,linSamp,u,0.).b;}
struct Surf{h:f32,push:vec2f,crest:f32,broken:f32}
fn surf(xz:vec2f,t:f32)->Surf{var o:Surf;o.h=0.;o.push=vec2f(0);o.crest=0.;o.broken=0.;
 let land=landAt(xz);if(land<.02||land>.995){return o;}
 let sd=(1.-land)*34.;let e=3.;let g=vec2f(landAt(xz+vec2f(e,0.))-landAt(xz-vec2f(e,0.)),landAt(xz+vec2f(0.,e))-landAt(xz-vec2f(0.,e)));
 let toShore=select(vec2f(0.),normalize(g),dot(g,g)>1e-8);
 let wob=tn(xz*.03+t*vec2f(.004,.002)).r*6.;let u=fract((sd+wob)/11.+t*.09);
 // Green's-law shoaling: waves grow as they reach shallow water, peak and pitch at ~7 m, then collapse into whitewater
 let grow=smoothstep(30.,8.,sd);let collapse=smoothstep(2.,7.,sd);let A=1.35*grow*mix(.35,1.,collapse)*(.8+.4*tn(xz*.011).g);
 let back=pow(1.-u,2.4);                                    // long gentle back toward the sea
 let face=1.-smoothstep(.9,1.,u);                         // near-vertical shoreward face (wraps to the crest)
 let hump=back*face;
 o.h=A*hump;o.push=toShore*A*.55*hump*hump*collapse;      // crest leans / throws forward
 o.crest=smoothstep(.75,.95,hump)*grow*collapse;o.broken=(1.-collapse)*grow;return o;}
// fragment-side surf: height, crest and whitewater only (the shoreward push needs the land gradient: 4 more taps, vertex only)
fn surfF(xz:vec2f,t:f32,land:f32)->Surf{var o:Surf;o.h=0.;o.push=vec2f(0);o.crest=0.;o.broken=0.;if(land<.02||land>.995){return o;}
 let sd=(1.-land)*34.;let wob=tn(xz*.03+t*vec2f(.004,.002)).r*6.;let u=fract((sd+wob)/11.+t*.09);
 let grow=smoothstep(30.,8.,sd);let collapse=smoothstep(2.,7.,sd);let A=1.35*grow*mix(.35,1.,collapse)*(.8+.4*tn(xz*.011).g);
 let back=pow(1.-u,2.4);let face=1.-smoothstep(.9,1.,u);let hump=back*face;
 o.h=A*hump;o.crest=smoothstep(.75,.95,hump)*grow*collapse;o.broken=(1.-collapse)*grow;return o;}
// footprint-filtered noise: tap at the mip that matches the pixel's footprint on the water (fq = the tap's frequency, 1/m).
// Level-0 taps across a distant sea read texels far apart - shimmering foam and a cache miss per tap.
fn tnF(uv:vec2f,fq:f32,fpm:f32)->vec4f{return tnd(uv,max(log2(fpm*fq*512.),0.));}
fn ggx(nh:f32,a:f32)->f32{let a2=a*a;let d=nh*nh*(a2-1.)+1.;return a2/(PI*d*d);}
@fragment fn fs(v:VO)->@location(0) vec4f{
 let xz=v.base;let d=distance(v.wp,F.camPos.xyz);
 let f0=1.-smoothstep(2500.,9000.,d);let f1=1.-smoothstep(250.,900.,d);
 let a=textureSample(s0,linSamp,xz/OPB[0].x);let b=textureSample(s1,linSamp,xz/OPB[0].y);
 let da=textureSample(d0,linSamp,xz/OPB[0].x);let db=textureSample(d1,linSamp,xz/OPB[0].y);
 // capillary ripples up close (animated noise normals) on top of the two FFT cascades
 let fpm=d*F.res.w/sqrt(max(abs(normalize(F.camPos.xyz-v.wp).y),.02));   // pixel footprint on the water (m)
 let f2=1.-smoothstep(15.,80.,d);var rp=vec2f(0.);if(f2>0.){rp=(tnF(xz*.9+OPB[0].w*vec2f(.07,.05),.9,fpm).rg+tnF(xz*1.7-OPB[0].w*vec2f(.05,.09),1.7,fpm).ba-1.)*.18*f2;}
 let sl=a.xy*f0+b.xy*f1+rp;
 let land0=landAt(xz);let sfc=surfF(xz,OPB[0].w,land0);let ee=.6;var hx=0.;var hz=0.;
 if(land0>=.01&&land0<=.997){hx=surfF(xz+vec2f(ee,0.),OPB[0].w,landAt(xz+vec2f(ee,0.))).h-surfF(xz-vec2f(ee,0.),OPB[0].w,landAt(xz-vec2f(ee,0.))).h;hz=surfF(xz+vec2f(0.,ee),OPB[0].w,landAt(xz+vec2f(0.,ee))).h-surfF(xz-vec2f(0.,ee),OPB[0].w,landAt(xz-vec2f(0.,ee))).h;}   // open sea: no breakers, no surf slope
 let dmp=1.-land0*.8;
 var n=normalize(vec3f(-sl.x*dmp-hx/(2.*ee),1.,-sl.y*dmp-hz/(2.*ee)));
 let vd=normalize(F.camPos.xyz-v.wp);if(dot(n,vd)<.02){n=normalize(n+vd*(.02-dot(n,vd)));}
 let s=F.sunDir.xyz;let sh=cloudShadow(v.wp)*terrainShadowCached(v.wp)*objShadowFast(v.wp);   /* cliffs, headlands, trees and clouds all shade the sea */
 // Jacobian < 1 means the surface is folding: whitecaps
 let J=min(da.w*mix(1.,db.w,f1),1.5);
 let foamCrest=smoothstep(.7,.15,J)*(.6+.4*tnF(xz*.09+OPB[0].w*vec2f(.01,.006),.09,fpm).r);
 // shore proximity: fraction of land in rings around this point (0 open sea .. 1 at the waterline)
 let land=land0;
 let depth=mix(8.,.2,land);                    // effective depth for colour
 let sd=(1.-land)*34.;                         // approx metres from the waterline
 // breakers: bands rolling shoreward, breaking in the last ~25 m, wash spreading at the edge
 let wob=tnF(xz*.03+OPB[0].w*vec2f(.004,.002),.03,fpm).r*6.;
 let ph=fract((sd+wob)/11.+OPB[0].w*.09);
 let breakZone=smoothstep(28.,6.,sd);
 let band=smoothstep(.0,.05,ph)*(1.-smoothstep(.05,.32,ph));      // bright leading edge, trailing wake
 let foamBreak=band*breakZone;
 let wash=smoothstep(5.,.5,sd)*(.55+.45*sin(OPB[0].w*.55+wob));      // swash sheet at the waterline
 let foamTrail=breakZone*smoothstep(.3,.9,ph)*.35;               // residual foam behind each breaker
 let foamShore=max(max(max(foamBreak*.6,wash),foamTrail),max(sfc.crest,sfc.broken*(.5+.5*tnF(xz*.7-OPB[0].w*.06,.7,fpm).r)));
 // light through the thin lip of a steepening wave
 let lipGlow=sfc.crest*(1.-sfc.broken);
 let foamTex=smoothstep(.25,.7,tnF(xz*.35+OPB[0].w*vec2f(.02,.01),.35,fpm).a*.5+tnF(xz*1.3+OPB[0].w*.03,1.3,fpm).r*.3+tnF(xz*4.1,4.1,fpm).g*.2);   // lacy foam, not flat paint
 let foam=clamp(max(foamCrest,foamShore)*mix(.35,1.,foamTex),0.,1.);
 // reflection: sky (with the sun disc handled by GGX below)
 let R=reflect(-vd,n);let Rs=normalize(vec3f(R.x,max(R.y,.015),R.z));
 var refl=skyColor(Rs);if(!pk(4u)){refl=clouds(Rs,refl);}   // the cloud deck mirrors in the swell (while Clouds is on)
 // screen-space reflections: cliffs, headlands, trees and buildings mirror in the water (sky/clouds where the ray leaves the screen)
 var ssrHit=0.;
 {let fadeD=1.-smoothstep(350.,1100.,d);if(fadeD>0.&&R.y>-.05&&!pk(12u)){let dims=vec2f(textureDimensions(sceneCol));var t=1.2;
   let c0=F.viewProj*vec4f(v.wp,1.);let cR=F.viewProj*vec4f(R,0.);   // projection is linear in homogeneous coordinates: step the clip position, no matrix per step
   for(var i=0;i<SSR_N;i++){let q=v.wp+R*t;let cq=c0+cR*t;if(cq.w<=0.){break;}let nd=cq.xyz/cq.w;let uv=vec2f(nd.x*.5+.5,.5-nd.y*.5);
    if(any(uv<vec2f(0.))||any(uv>vec2f(1.))){break;}let px=vec2i(uv*dims);let sd=textureLoad(sceneDep,vec2i(uv*vec2f(textureDimensions(sceneDep))),0).r;
    if(sd>nd.z){let hw=F.invViewProj*vec4f(nd.xy,sd,1.);let hp=hw.xyz/hw.w;
     if(distance(hp,q)<t*.3+1.5){let e=min(min(uv.x,uv.y),min(1.-uv.x,1.-uv.y));ssrHit=1.;refl=mix(refl,textureLoad(sceneCol,px,0).rgb,smoothstep(0.,.1,e)*fadeD*smoothstep(-.05,.05,R.y));}break;}
    t*=SSR_G;}}}   // 14 geometric steps x1.62 reach ~630 m (28 x1.25 reached ~620 m); the 1/4-res depth keeps each tap cheap
 let F0=.02;let ndv=max(dot(n,vd),0.);let fres=F0+(1.-F0)*pow(1.-ndv,5.);
 // body colour: deep ocean absorbs to navy; crests lit from behind glow teal (subsurface)
 let amb=ambientSky(vec3f(0.,1.,0.));
 let deep=vec3f(.004,.018,.03)*amb*1.3+vec3f(.002,.012,.016)*F.sunColor.rgb*max(s.y,0.)*sh;
 let sss=vec3f(.02,.14,.12)*F.sunColor.rgb*pow(max(dot(vd,-s)*.5+.5,0.),4.)*max(v.h*.4+.35,0.)*sh;
 let shallow=vec3f(.05,.16,.14)*(amb*.6+F.sunColor.rgb*max(s.y,0.)*.5*sh);
 let turq=vec3f(.06,.26,.24)*(amb*.55+F.sunColor.rgb*max(s.y,0.)*.6*sh);
 var body=mix(deep+sss,mix(shallow,turq,.6),smoothstep(.15,.9,land));
 // sun glint: GGX with roughness from distance (sub-pixel waves) so the glitter path stays alive to the horizon
 let hv=normalize(vd+s);let rough=mix(.05,.2,smoothstep(50.,3000.,d));
 let spec=ggx(max(dot(n,hv),0.),rough)*fres/(4.*max(ndv,.05)*max(dot(n,s),.05))*max(dot(n,s),0.);
 body+=vec3f(.05,.22,.18)*F.sunColor.rgb*lipGlow*.6*max(dot(vd,-s)*.5+.5,.3)*sh;
 var c=mix(body,refl,fres)+F.sunColor.rgb*spec*sh*.9;
 let thin=1.-foam;let foamC=(F.sunColor.rgb*max(dot(n,s),0.)*.8*sh+amb*.8)*mix(vec3f(.95,.97,.98),vec3f(.6,.8,.8),thin*.5);
 c=mix(c,foamC,foam*.9);
 if(i32(F.skyHorizon.z+.5)==25){return vec4f(mix(c,vec3f(3.,0.,3.),ssrHit*.6),1.);}   /* 25: water pixels with a screen-space reflection hit */
 return vec4f(fogApply(c,v.wp),1.);}
`;
