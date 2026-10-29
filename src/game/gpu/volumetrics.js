import {FRAME,COMMON} from './shaders-common.js';
// Half-resolution volumetrics: (1) light shafts - sun in-scattering in the near atmosphere, shadowed by objects, terrain and the
// cloud deck; (2) raymarched 3D cumulus/stratocumulus layer for sky pixels.
export const VOL=FRAME+COMMON+/*wgsl*/`
// shaft march steps: 14 (was 22) - the in-scatter is a smooth, faint integral; the per-pixel IGN jitter plus the 3x3 joint-bilateral
// filter below turn the coarser march into the same gradient
const VOL_SHAFT_N=11;
@group(1) @binding(0) var depthTex:texture_depth_2d;
// temporal cloud reuse (UE-style): each frame marches the cloud deck in one of every 4x4 group of 8x4-texel blocks (full refresh every 16 frames, 133 ms); the rest reproject
// last frame's result by view direction (the deck is 1.25+ km away, so camera translation parallax is negligible)
@group(1) @binding(1) var histRays:texture_2d<f32>;
@group(1) @binding(2) var histCloud:texture_2d<f32>;
struct VolU{prevVP:mat4x4f,p:vec4f}   // p.x: this frame's 2x2 phase, p.y: 1 = history invalid
@group(1) @binding(3) var<uniform> VU:VolU;
struct VO{@builtin(position) pos:vec4f,@location(0) uv:vec2f}
struct FO{@location(0) rays:vec4f,@location(1) cloud:vec4f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:VO;o.pos=vec4f(p*2.-1.,0.,1.);o.uv=vec2f(p.x,1.-p.y);return o;}
fn ign(p:vec2f)->f32{return fract(52.9829189*fract(dot(p,vec2f(.06711056,.00583715))));}
fn fogDens(y:f32)->f32{let hz=F.sunColor.w;let base=F.box.w;
 return (.000018+.00022*hz*hz)*exp(-(y-base)/900.)+F.skyHorizon.w*.0022*exp(-max(y-base,0.)/18.);}
fn cloud3(p:vec3f)->f32{let t=(p.y-1250.)/1500.;if(t<0.||t>1.){return 0.;}
 let cov=F.skyZenith.w;let c=clamp(cloudDensity(p.xz)*(.55+cov*.9),0.,1.);if(c<.01){return 0.;}
 let top=.25+.75*c;let prof=smoothstep(0.,.08,t)*(1.-smoothstep(top*.55,top,t));
 let q=p.xz*.0011+vec2f(t*.12,-t*.08)+F.camPos.w*vec2f(.0009,.0003);
 let z=t*9.;let zf=fract(z);let zi=floor(z);   /* pseudo-3D detail: blend noise slices through height so edges aren't vertical extrusions of the 2D map */
 let o0=vec2f(.37,.71)*zi;let o1=o0+vec2f(.37,.71);let zs=zf*zf*(3.-2.*zf);
 let det=mix(tn(q+o0).r*.6+tn(q*2.7+o0).g*.4,tn(q+o1).r*.6+tn(q*2.7+o1).g*.4,zs);
 return clamp(c*prof*1.25-(1.-det)*.45*(1.-c*.5),0.,1.);}
@fragment fn fs(v:VO)->FO{var o:FO;
 let dims=vec2f(textureDimensions(depthTex));let px=vec2i(v.uv*dims);let dep=textureLoad(depthTex,clamp(px,vec2i(0),vec2i(dims)-1),0);
 let ndc=vec2f(v.uv.x*2.-1.,1.-v.uv.y*2.);
 let w=F.invViewProj*vec4f(ndc,max(dep,1e-7),1.);let far=w.xyz/w.w;let ro=F.camPos.xyz;
 var rd=far-ro;let dist=select(length(rd),1e9,dep<=0.);rd=normalize(rd);
 let jit=ign(v.pos.xy+fract(F.camPos.w*7.)*113.);
 let pxAng=length(fwidth(rd));   /* view-ray angle per (low-res) pixel, taken in uniform control flow for the cloud footprint prefilter */
 let s=F.sunDir.xyz;let mu=dot(rd,s);let sunOn=smoothstep(-.02,.04,s.y);
 // ---- light shafts
 {let L=min(dist,420.);let N=VOL_SHAFT_N;let ds=L/f32(N);var T=1.;var acc=0.;
  for(var i=0;i<N;i++){let p=ro+rd*(ds*(f32(i)+jit));let dn=fogDens(p.y)*7.;
   var sh=terrainShadowCached(p)*(cloudShadow(p)*1.6-.6);if(!pk(2u)){sh*=objShadowOne(p);}   /* each shadow term only while its effect is on */
   acc+=T*dn*ds*max(sh,0.);T*=exp(-dn*ds);}
  let ph=(hg(mu,.78)*.7+hg(mu,.2)*.3)*4.*PI;
  o.rays=vec4f(F.sunColor.rgb*acc*ph*.09*sunOn,1.);}
 // ---- volumetric clouds (sky pixels only)
 o.cloud=vec4f(0.);
 if(dep<=0.&&rd.y>.004&&!pk(4u)){var march=true;
  let mine=((u32(v.pos.x)>>3u)&3u)+4u*((u32(v.pos.y)>>2u)&3u)==u32(VU.p.x);   // 8x4 blocks: whole SIMD groups march or reproject together (a per-pixel pattern leaves 3 of 4 lanes idle, no saving)
  if(!mine&&VU.p.y<.5){let q=VU.prevVP*vec4f(rd,0.);if(q.w>1e-4){let uv=vec2f(q.x/q.w*.5+.5,.5-q.y/q.w*.5);
   if(all(uv>vec2f(.002))&&all(uv<vec2f(.998))){let gw=textureGather(3,histRays,linSamp,uv);   // all four source texels were sky last frame
    if(max(max(gw.x,gw.y),max(gw.z,gw.w))<=0.){o.cloud=textureSampleLevel(histCloud,linSamp,uv,0.);march=false;}}}}
  if(march){let t0=(1250.-ro.y)/rd.y;   /* the cloud deck belongs to the Volumetric clouds effect (perf bit 4): off, no march */let t1=min((2750.-ro.y)/rd.y,t0+9000.);let N=48;   /* 24 steps of ~600 m undersampled the ~900 m detail noise -> streaks toward the horizon */let ds=(t1-t0)/f32(N);
  var T=1.;var col=vec3f(0);let amb=ambientSky(vec3f(0.,1.,0.));
  let ph=mix(hg(mu,-.2),hg(mu,.8),.65)*4.*PI;
  for(var i=0;i<N;i++){let p=ro+rd*(t0+ds*(f32(i)+jit));let d=cloud3(p);if(d<=.003){continue;}
   var od=cloud3(p+s*70.)*110.+cloud3(p+s*260.)*300.;
   let beer=exp(-od*.0045);let powder=1.-exp(-d*6.);let hgt=clamp((p.y-1250.)/1500.,0.,1.);
   let sig=d*.004;let Li=F.sunColor.rgb*sunOn*(beer*ph*powder*1.6+beer*.25)+amb*(.35+.65*hgt)*.55;
   let a=1.-exp(-sig*ds);col+=T*Li*a;T*=1.-a;if(T<.02){break;}}
  // aerial perspective over the distance to the deck
  let dd=t0+max(ds*6.,0.);let fa=1.-exp(-dd*(.000035+.00012*F.sunColor.w));
  // Distant cloud fades into the SAME horizon sky the sky pass draws behind it (skyColor + its horizon haze), so a deck
  // 50-150 km out has no contrast left to alias. Fading toward fogInscatter (a different colour from the sky behind)
  // left a bright/dark rim of undersampled cloud on the horizon that flickered as the TAA jitter moved each ray across it.
  let hzn=exp(-max(rd.y,0.)*mix(14.,5.,F.sunColor.w));let bg=mix(skyColor(rd),fogInscatter(rd),hzn*mix(.15,.55,F.sunColor.w));
  // Footprint prefilter: near the horizon one pixel spans kilometres of cloud deck along the view (range ~ h/rd.y^2 * pixel
  // angle), far beyond the cloud's own detail, so the march result is pure aliasing and the TAA jitter (half a pixel =
  // several km there) turned it into horizon flicker. Past ~1 km per pixel the deck is replaced by the sky behind it.
  let fpR=(1250.-ro.y)/(rd.y*rd.y)*pxAng;let kf=smoothstep(700.,2500.,fpR);
  col=mix(col,bg*(1.-T),max(fa,kf));
  let hf=smoothstep(.004,.05,rd.y);o.cloud=vec4f(col*hf,(1.-T)*hf);}}   /* premultiplied: the horizon fade must scale colour and alpha together (alpha alone left the cloud's full colour added on top of the sky, a bright flickering rim) */
 o.rays.w=dep;   /* the depth this low-res texel was marched against: lets the composite upsample depth-aware */
 return o;}
`;
// Quarter-res filter of the marched shafts + clouds: the 3x3 gaussian that hides the march jitter, joint-bilateral on the
// depth each texel was marched against (shafts) / sky-only (clouds). Done here on 1/16 of the pixels, so the full-res
// composite below only needs a 2x2 depth-aware upsample.
export const VOLFILT=/*wgsl*/`
@group(0) @binding(0) var rays:texture_2d<f32>;
@group(0) @binding(1) var cloud:texture_2d<f32>;
struct VO{@builtin(position) pos:vec4f}
struct FO{@location(0) rays:vec4f,@location(1) cloud:vec4f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:VO;o.pos=vec4f(p*2.-1.,0.,1.);return o;}
@fragment fn fs(v:VO)->FO{let c=vec2i(v.pos.xy);let lmax=vec2i(textureDimensions(rays))-1;let R0=textureLoad(rays,c,0);
 let lz0=select(1e6,.05/R0.w,R0.w>0.);var sr=vec3f(0.);var wr=0.;var sc=vec4f(0.);var wc=0.;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let t=clamp(c+vec2i(x,y),vec2i(0),lmax);let wg=exp(-1.4*f32(x*x+y*y));
  let R=textureLoad(rays,t,0);let lz=select(1e6,.05/R.w,R.w>0.);let wd=exp(-abs(lz-lz0)/(.06*min(lz,lz0)+.02));
  sr+=R.rgb*wg*wd;wr+=wg*wd;if(R.w<=0.){sc+=textureLoad(cloud,t,0)*wg;wc+=wg;}}}
 var o:FO;o.rays=vec4f(sr/max(wr,1e-5),R0.w);o.cloud=select(textureLoad(cloud,c,0),sc/wc,wc>1e-4);return o;}
`;
// Full-res composite of the quarter-res volumetrics onto the HDR frame (premultiplied: rgb = cloud + rays, a = cloud coverage).
export const VOLCOMP=/*wgsl*/`
@group(0) @binding(0) var rays:texture_2d<f32>;
@group(0) @binding(1) var cloud:texture_2d<f32>;
@group(0) @binding(2) var depthTex:texture_depth_2d;
@group(0) @binding(3) var samp:sampler;
@group(0) @binding(4) var<uniform> CU:vec4f;   // x: shaft fade (1, or the in-scatter bound's fade when no sky is in view)
struct VO{@builtin(position) pos:vec4f,@location(0) uv:vec2f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:VO;o.pos=vec4f(p*2.-1.,0.,1.);o.uv=vec2f(p.x,1.-p.y);return o;}
@fragment fn fs(v:VO)->@location(0) vec4f{let full=vec2i(v.pos.xy);let dep=textureLoad(depthTex,full,0);
 // Depth-aware (joint bilateral) upsample, as UE does for its low-res volumetrics: each full-res pixel only takes the low-res
 // texels that were marched against a similar depth, so thin grass in front of a far hill/sky never inherits the background.
 let ld=vec2f(textureDimensions(rays));let lp=v.uv*ld-.5;let b=vec2i(floor(lp));let f=lp-vec2f(b);let lmax=vec2i(ld)-1;
 let lzF=select(1e6,.05/dep,dep>0.);
 // fast path (most pixels): the 4 texels were all marched at this pixel's depth -> the weights are ~1, one bilinear tap is exact
 {let g=textureGather(3,rays,samp,v.uv);let lz=select(vec4f(1e6),.05/g,g>vec4f(0.));let x=abs(lz-lzF)/(.06*min(lz,vec4f(lzF))+.02);
  if(max(max(x.x,x.y),max(x.z,x.w))<.03){var c=vec4f(0.);if(dep<=0.){c=textureSampleLevel(cloud,samp,v.uv,0.);}return vec4f(c.rgb+textureSampleLevel(rays,samp,v.uv,0.).rgb*CU.x,c.a);}}
 var sr=vec3f(0.);var wr=0.;var sb=vec3f(0.);var sc=vec4f(0.);var wc=0.;
 for(var k=0;k<4;k++){let o=vec2i(k&1,k>>1);let t=clamp(b+o,vec2i(0),lmax);let wg=mix(1.-f.x,f.x,f32(o.x))*mix(1.-f.y,f.y,f32(o.y));
  let R=textureLoad(rays,t,0);let lz=select(1e6,.05/R.w,R.w>0.);let wd=exp(-abs(lz-lzF)/(.06*min(lz,lzF)+.02));
  sr+=R.rgb*wg*wd;wr+=wg*wd;sb+=R.rgb*wg;if(R.w<=0.&&dep<=0.){sc+=textureLoad(cloud,t,0)*wg;wc+=wg;}}
 let r=select(sb,sr/wr,wr>1e-4);
 var c=vec4f(0.);if(dep<=0.){if(wc>1e-4){c=sc/wc;}else{c=textureSampleLevel(cloud,samp,v.uv,0.);}}
 return vec4f(c.rgb+r*CU.x,c.a);}
`;
// Auto exposure: centre-weighted log-average luminance of the HDR frame, adapted over time.
// (EXPO auto-exposure metering removed: exposure is the keyframed grade EV, gpu/grade.js)
