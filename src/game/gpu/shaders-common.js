import {BUDGET} from './budget.js';
// Shared WGSL: frame uniforms, sky model, noise, fog, heightfield helpers.
export const FRAME=/*wgsl*/`
struct Frame{
 viewProj:mat4x4f, invViewProj:mat4x4f,
 camPos:vec4f,      // xyz, w=time (s)
 sunDir:vec4f,      // xyz toward sun, w=exposure
 sunColor:vec4f,    // rgb radiance, w=haze
 skyZenith:vec4f, skyHorizon:vec4f,
 box:vec4f,         // terrain box x,z,size, water level
 res:vec4f,         // w,h,1/w,1/h
 wind:vec4f,        // dir.xy, strength, gust
 frustum:array<vec4f,6>,
 satBox:vec4f,      // satellite bounds x,z,size, ready
 extra:vec4f,       // x: satellite mix, y: height tex size, z: hole dir x, w: hole dir z
 shadowVP:array<mat4x4f,2>,
 maskBox:vec4f,     // hole detail mask bounds x,z,size, enabled
 perf:vec4f,        // x: shader-term kill mask for the frame-cost profiler (Visual debug); 0 = everything on
 clip:array<vec4f,8>,   // terrain height cache (gpu/terrain.js): [l] = window origin (lattice) xy, texel size, valid; [7] = N, levels, R0, vertical scale
 mclip:array<vec4f,8>,  // ground material cache (gpu/matcache.js): [l] = window origin (lattice) xy, texel size, level valid
 skyAmbH:array<vec4u,3>, // the five sky-ambient lobe colours (skyAmb texels, rgba16float bits), copied in on the GPU when the sky LUT updates
 putt:vec4f,             // (byte 848) green-reading grid (backend: puttGrid): pin xz, grid angle (toward the ball), opacity
}
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var baseMap:texture_2d<f32>;
@group(0) @binding(2) var satMap:texture_2d<f32>;
@group(0) @binding(3) var heightMap:texture_2d<f32>;
@group(0) @binding(4) var kindMap:texture_2d<f32>;
@group(0) @binding(5) var linSamp:sampler;
@group(0) @binding(6) var shadowMap:texture_depth_2d_array;
@group(0) @binding(7) var shadowSamp:sampler_comparison;
@group(0) @binding(8) var skyLUT:texture_2d<f32>;
@group(0) @binding(9) var maskMap:texture_2d<f32>;
@group(0) @binding(10) var tshadowMap:texture_2d<f32>;
@group(0) @binding(11) var cloudMap:texture_2d<f32>;
const CLOUD_SPAN=48000.;
@group(0) @binding(12) var noiseTex:texture_2d<f32>;
@group(0) @binding(13) var reliefMap:texture_2d<f32>;
@group(0) @binding(14) var aoMap:texture_2d<f32>;   // r: sky visibility of the shaped ground, g: dryness (crests)
@group(0) @binding(15) var maskDetail:texture_2d<f32>;   // surface mask for the current hole at ~0.1–0.2 m/texel (F.maskBox)
@group(0) @binding(16) var cmH:texture_2d_array<f32>;   // terrain height cache (r32float, toroidal per level)
@group(0) @binding(17) var cmN:texture_2d_array<f32>;   // terrain normal cache (rgba16float)
@group(0) @binding(18) var leafTex:texture_2d_array<f32>;   // baked turf leaf tile, 4 grain directions, mipmapped (shaders.js LEAF_BAKE)
@group(0) @binding(19) var skyAmb:texture_2d<f32>;
@group(0) @binding(20) var mcA:texture_2d_array<f32>;   // material cache: sqrt(static albedo).rgb, native-cover weight
@group(0) @binding(21) var mcB:texture_2d_array<f32>;   // material cache: matted amount, lay direction xy, surface gain/2   // 8x1: sky colour of the five ambient lobes (backend: SKYAMB, refreshed with the sky LUT)
@group(0) @binding(22) var noiseGrad:texture_2d_array<f32>;   // analytic gradient of noiseTex per uv unit, mipmapped: layer 0 (r.xy, g.xy), layer 1 (b.xy, a.xy)
// gradient of tn(uv).channel with respect to uv, prefiltered to the lod (exact derivative of the filtered noise, one tap)
fn tnGrad(uv:vec2f,lod:f32,ch:i32)->vec2f{let t=textureSampleLevel(noiseGrad,linSamp,uv,ch/2,lod);return select(t.zw,t.xy,ch%2==0);}
const CM_N=512;const CM_L=7;
fn cmWrap(i:vec2i)->vec2i{return ((i%vec2i(CM_N))+vec2i(CM_N))%vec2i(CM_N);}
// how much level l can be trusted at xz: 1 well inside its window, fading to 0 over its outer 16 texels (coarsest: always)
const MC_N=1024;const MC_L=7;
// Ground material cache (runtime virtual texture, gpu/matcache.js): the xz-only part of the ground material baked into a
// camera-centred clipmap, so a ground pixel reads 2 textures instead of evaluating the albedo stack and matting noise.
struct MCS{a:vec4f,b:vec4f,ok:bool}
fn mcCover(l:i32,xz:vec2f)->f32{let c=F.mclip[l];if(l==MC_L-1){return 1.;}let q=xz/c.z-c.xy;let e=min(min(q.x,q.y),min(f32(MC_N-1)-q.x,f32(MC_N-1)-q.y));return smoothstep(2.,14.,e);}
fn mcFrom(l0:i32,xz:vec2f)->MCS{var o:MCS;o.a=vec4f(0.);o.b=vec4f(0.);var rem=1.;
 for(var l=l0;l<MC_L;l++){if(F.mclip[l].w<.5){break;}let w=mcCover(l,xz);if(w>0.){let uv=(xz/F.mclip[l].z+.5)/f32(MC_N);let k=rem*w;
  o.a+=k*textureSampleLevel(mcA,linSamp,uv,l,0.);o.b+=k*textureSampleLevel(mcB,linSamp,uv,l,0.);rem*=1.-w;if(rem<=1e-4){break;}}}
 o.ok=rem<=1e-3;return o;}
fn matCache(xz:vec2f,fp:f32)->MCS{let lf=clamp(log2(max(fp,1e-6)/F.mclip[0].z),0.,f32(MC_L-1));let l0=i32(floor(lf));let t=fract(lf);
 let a=mcFrom(l0,xz);if(!a.ok||t<.02||l0>=MC_L-1){return a;}let b=mcFrom(l0+1,xz);if(!b.ok){return a;}var o:MCS;o.a=mix(a.a,b.a,t);o.b=mix(a.b,b.b,t);o.ok=true;return o;}
// Lean terrain lookups (fsGT): one clipmap level chosen from the pixel footprint and the camera distance (every window is
// camera-centred, so the finest level holding xz is known without testing coverage), blended to the next level for filtering
// and over the last 15% of each window's reach. Two taps per cache instead of the per-level coverage loops.
fn clipLf(fpLf:f32,dc:f32,R0:f32)->f32{let r=dc/R0;let li=max(ceil(log2(max(r,1e-6))),0.);let b=smoothstep(.85,1.,r/exp2(li));return clamp(max(fpLf,li+b),0.,6.);}
struct MCL{a:vec4f,b:vec4f,m:vec4f}
fn mcTap(l:i32,xz:vec2f)->MCL{let uv=(xz/F.mclip[l].z+.5)/f32(MC_N);var o:MCL;o.a=textureSampleLevel(mcA,linSamp,uv,l,0.);o.b=textureSampleLevel(mcB,linSamp,uv,l,0.);o.m=textureSampleLevel(mcA,linSamp,uv,l+MC_L,0.);return o;}
fn mcLean(xz:vec2f,fp:f32,dc:f32)->MCL{let lf=clipLf(log2(max(fp,1e-6)/F.mclip[0].z),dc,(f32(MC_N/2)-30.)*F.mclip[0].z);let l0=i32(lf);let t=lf-f32(l0);
 let a=mcTap(l0,xz);if(t<.02||l0>=MC_L-1){return a;}let b=mcTap(l0+1,xz);var o:MCL;o.a=mix(a.a,b.a,t);o.b=mix(a.b,b.b,t);o.m=mix(a.m,b.m,t);return o;}
fn terrainNLean(xz:vec2f,fp:f32,dc:f32)->vec3f{let lf=clipLf(log2(max(fp,1e-6)/F.clip[0].z),dc,(f32(CM_N/2)-30.)*F.clip[0].z);let l0=i32(lf);let t=lf-f32(l0);
 var n=cmNl(l0,xz);if(t>.02&&l0<CM_L-1){n=mix(n,cmNl(l0+1,xz),t);}return normalize(n);}
fn cmCover(l:i32,xz:vec2f)->f32{let c=F.clip[l];if(c.w<.5){return 0.;}if(l==CM_L-1){return 1.;}let q=xz/c.z-c.xy;
 let e=min(min(q.x,q.y),min(f32(CM_N-1)-q.x,f32(CM_N-1)-q.y));return smoothstep(2.,14.,e);}
fn cmHl(l:i32,xz:vec2f)->f32{let p=xz/F.clip[l].z;let b=floor(p);let f=p-b;let i=vec2i(b);
 let a=textureLoad(cmH,cmWrap(i),l,0).r;let c=textureLoad(cmH,cmWrap(i+vec2i(1,0)),l,0).r;
 let d=textureLoad(cmH,cmWrap(i+vec2i(0,1)),l,0).r;let e=textureLoad(cmH,cmWrap(i+vec2i(1,1)),l,0).r;
 return mix(mix(a,c,f.x),mix(d,e,f.x),f.y);}
// finished ground height (the same surface the old per-vertex surfY computed) from the finest level that covers xz
fn terrainH(xz:vec2f)->f32{var h=0.;var rem=1.;for(var l=0;l<CM_L;l++){let w=cmCover(l,xz);if(w>0.){h+=rem*w*cmHl(l,xz);rem*=1.-w;if(rem<=1e-4){break;}}}return h;}
fn cmNl(l:i32,xz:vec2f)->vec3f{return textureSampleLevel(cmN,linSamp,(xz/F.clip[l].z+.5)/f32(CM_N),l,0.).xyz;}
fn cmNFrom(l0:i32,xz:vec2f)->vec3f{var n=vec3f(0.);var rem=1.;for(var l=l0;l<CM_L;l++){let w=cmCover(l,xz);if(w>0.){n+=rem*w*cmNl(l,xz);rem*=1.-w;if(rem<=1e-4){break;}}}return n;}
// surface normal, prefiltered to the pixel footprint fp (m): the level whose texel matches the footprint, blended to the next
fn terrainN(xz:vec2f,fp:f32)->vec3f{let lf=clamp(log2(max(fp,1e-6)/F.clip[0].z),0.,f32(CM_L-1));let l0=i32(floor(lf));
 let t=fract(lf);var n=cmNFrom(l0,xz);if(t>.02&&l0<CM_L-1){n=mix(n,cmNFrom(l0+1,xz),t);}return normalize(n);}
// tileable baked noise (period 1 in uv): r,g,b = independent fbm, a = fine value noise
fn tn(uv:vec2f)->vec4f{return textureSampleLevel(noiseTex,linSamp,uv,0.);}
fn tnd(uv:vec2f,lod:f32)->vec4f{return textureSampleLevel(noiseTex,linSamp,uv,lod);}
// Cubic B-spline reconstruction (4 bilinear taps): boundaries come out as smooth rounded curves, not texel facets.
fn cubicMask(tx:texture_2d<f32>,uv:vec2f)->vec4f{let n=vec2f(textureDimensions(tx));let t=uv*n-.5;let f=fract(t);let b=floor(t);
 let w0=(1.-f)*(1.-f)*(1.-f)/6.;let w1=(4.-6.*f*f+3.*f*f*f)/6.;let w2=(1.+3.*f+3.*f*f-3.*f*f*f)/6.;let w3=f*f*f/6.;
 let g0=w0+w1;let g1=w2+w3;let h0=(b-.5+w1/g0)/n;let h1=(b+1.5+w3/g1)/n;
 let a=textureSampleLevel(tx,linSamp,vec2f(h0.x,h0.y),0.);let c=textureSampleLevel(tx,linSamp,vec2f(h1.x,h0.y),0.);
 let d=textureSampleLevel(tx,linSamp,vec2f(h0.x,h1.y),0.);let e=textureSampleLevel(tx,linSamp,vec2f(h1.x,h1.y),0.);
 return g0.y*(g0.x*a+g1.x*c)+g1.y*(g0.x*d+g1.x*e);}
// Surface mask: the hole's high-res detail mask where it exists (crossfading to the course-wide mask over its outer 6%)
// surfMask is asked for the same point many times per pixel (surface class, gain, bunker hole/depth, rough, canopy, water...):
// each call is 4-8 bilinear taps. Memoise the last point per shader invocation.
var<private> smKey:vec2f=vec2f(1e30);var<private> smVal:vec4f;
fn surfMask(xz:vec2f)->vec4f{if(all(xz==smKey)){return smVal;}smKey=xz;smVal=surfMaskRaw(xz);return smVal;}
fn surfMaskRaw(xz:vec2f)->vec4f{
 if(F.maskBox.w>.5){let u=(xz-F.maskBox.xy)/F.maskBox.z;let edge=min(min(u.x,u.y),min(1.-u.x,1.-u.y));
  if(edge>.06){return cubicMask(maskDetail,u);}
  if(edge>0.){return mix(cubicMask(maskMap,boxUV(xz)),cubicMask(maskDetail,u),smoothstep(0.,.06,edge));}}
 return cubicMask(maskMap,boxUV(xz));}
`;
export const COMMON=/*wgsl*/`
const PI=3.14159265;
fn hash21(p:vec2f)->f32{var q=fract(p*vec2f(123.34,456.21));q+=dot(q,q+45.32);return fract(q.x*q.y);}
fn pcg(v:u32)->u32{let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn ihash(c:vec2f,salt:u32)->f32{let i=vec2i(c);return f32(pcg(pcg(bitcast<u32>(i.x)^salt)+bitcast<u32>(i.y)))/4294967295.;}
fn hash22(p:vec2f)->vec2f{let n=hash21(p);return vec2f(n,hash21(p+n*17.13));}
fn vnoise(p:vec2f)->f32{let i=floor(p);let f=fract(p);let u=f*f*(3.-2.*f);
 return mix(mix(hash21(i),hash21(i+vec2f(1,0)),u.x),mix(hash21(i+vec2f(0,1)),hash21(i+vec2f(1,1)),u.x),u.y);}
fn fbm(p0:vec2f)->f32{var p=p0;var a=.5;var s=0.;for(var i=0;i<5;i++){s+=a*vnoise(p);p=p*2.03+vec2f(17.1,9.2);a*=.5;}return s;}
fn boxUV(xz:vec2f)->vec2f{return (xz-F.box.xy)/F.box.z;}
// Matted rough: irregular clumps (domain-warped noise, ~0.4–1.5 m) where blades lie over along a shared lay direction that
// drifts slowly across the lawn. x = matted amount, yz = lay direction. Shared by the blades and the ground under them.
const MAT_STRENGTH=.7;   // how far matted blades lie over / how strongly patches tint (1 = full)
fn matField(xz:vec2f)->vec3f{
 // lay direction drifts slowly (~10 m) so neighbouring patches lie roughly the same way
 let la=vnoise(xz*.09+1.7)*9.4+vnoise(xz*.5)*.9;let lay=vec2f(cos(la),sin(la));
 // zones (~8–15 m): trampled stretches vs. barely touched ones
 let zone=smoothstep(.3,.72,vnoise(xz*.075+4.2)*.7+vnoise(xz*.19-2.3)*.3);
 // patch shapes: wind-combed, stretched along the lay direction (streaks a few metres long, ~1 m across) with feathered edges,
 // so the rough reads as softly brushed swathes rather than hard-edged blobs
 let ax=normalize(vec2f(.8,.6));let al=dot(xz,ax);let ac=dot(xz,vec2f(-ax.y,ax.x));   /* one prevailing comb direction: a spatially varying rotation of world coordinates would swirl into contour lines */let q=vec2f(al*.45,ac*1.0);
 let wq=q+vec2f(vnoise(q*.7+3.1),vnoise(q*.7-7.7))*.9;
 let pf=vnoise(wq)*.55+vnoise(wq*2.1+11.)*.3+vnoise(wq*4.7-4.)*.15;
 let th=mix(.74,.5,zone);let m=smoothstep(th-.16,th+.16,pf)*MAT_STRENGTH;
 return vec3f(m,lay);}
// Patch-scale tone: a matted patch acts like one big anisotropic sheet — its shared blade direction catches the sun as a
// broad sheen lobe (bright or dark depending on lay vs sun and eye); upright clumps are a little darker (self-shaded).
fn matTone(xz:vec2f,wp:vec3f)->f32{return matToneMF(matField(xz),wp);}
fn matToneMF(mf:vec3f,wp:vec3f)->f32{let T=vec3f(mf.y,.25,mf.z)/1.03;let vd=normalize(F.camPos.xyz-wp);let hv=normalize(vd+F.sunDir.xyz);
 let th=dot(T,hv);let st2=max(1.-th*th,0.);let lobe=st2*st2;let sunUp=smoothstep(0.,.25,F.sunDir.y);
 return mix(.975,.985+.14*lobe*sunUp,mf.x);}   // gentle: matting shifts tone by a few percent, like real brushed rough
// Bilinear height (texture is r32float, non-filterable).
// Cubic B-spline filtering (4 bilinear taps). Bilinear height/relief data has piecewise-constant slopes, which shows
// up as a grid of flat facets in the lighting; the B-spline keeps slopes continuous so the ground shades smoothly.
fn cubicTex(t:texture_2d<f32>,uv:vec2f)->vec4f{let n=vec2f(textureDimensions(t));let p=uv*n-.5;let f=fract(p);let b=floor(p);
 let w0=(1.-f)*(1.-f)*(1.-f)/6.;let w1=(4.-6.*f*f+3.*f*f*f)/6.;let w2=(1.+3.*f+3.*f*f-3.*f*f*f)/6.;let w3=f*f*f/6.;
 let g0=w0+w1;let g1=w2+w3;let h0=(b-.5+w1/g0)/n;let h1=(b+1.5+w3/g1)/n;
 return g0.y*(g0.x*textureSampleLevel(t,linSamp,h0,0.)+g1.x*textureSampleLevel(t,linSamp,vec2f(h1.x,h0.y),0.))+g1.y*(g0.x*textureSampleLevel(t,linSamp,vec2f(h0.x,h1.y),0.)+g1.x*textureSampleLevel(t,linSamp,h1,0.));}
fn reliefAt(xz:vec2f)->f32{return cubicTex(reliefMap,boxUV(xz)).r;}
// Mean albedo of a rough sward (what the blades average to), shared by the terrain under the rough and by distant blades,
// so blades melt into the ground instead of reading as light/dark whiskers on a different-coloured floor.
fn roughAlb(mc:vec3f,dry:f32)->vec3f{let ml=dot(mc,vec3f(.3,.5,.2));var c=vec3f(.14,.262,.07)*mix(1.,clamp(ml/.13,.7,1.3),.45)*vec3f(1.05,1.04,.94);
 return mix(c,vec3f(.36,.33,.15),dry*.25);}
// Rough sward texture on the ground between the blades (the canopy's own prefiltered look, the way AAA landscapes put a grass
// texture under the foliage): clump mottling (~30 cm) + blade grain (~6 cm) from the mipmapped noise, sampled at the pixel's
// footprint so it averages to exactly 1 once it's sub-pixel (no shimmer, no posterized flat plateau). fp = metres per pixel.
fn roughMottle(xz:vec2f,fp:f32)->f32{if(pk(19u)){return 1.;}let n=f32(textureDimensions(noiseTex).x);
 let a=tnd(xz/2.5,max(log2(fp*n/2.5),0.)).r;let g=tnd(xz/4.1+vec2f(.37,.71),max(log2(fp*n/4.1)+1.,0.)).a;
 return 1.+.44*(a-.5)+.34*(g-.5);}
fn groundAO(xz:vec2f)->vec2f{return cubicTex(aoMap,boxUV(xz)).rg;}
// seabed: ground that is mapped as water or sits at sea level is pushed down so the ocean surface covers it cleanly
fn seabedDrop(xz:vec2f)->f32{let w=max(smoothstep(.35,.65,surfMask(xz).b),1.-smoothstep(F.box.w+.2,F.box.w+.9,groundH0(xz)));return w*5.;}
fn groundH(xz:vec2f)->f32{return groundH0(xz)+reliefAt(xz);}
// raw terrain from the baked height map (no course micro-relief), cubic B-spline over 4x4 texels
fn hL(i:vec2i,m:i32)->f32{return textureLoad(heightMap,clamp(i,vec2i(0),vec2i(m)),0).r;}
fn groundH0(xz:vec2f)->f32{let n=F.extra.y;let t=boxUV(xz)*n-.5;let i=vec2i(floor(t));let f=fract(t);let m=i32(n)-1;
 let wx=array<f32,4>((1.-f.x)*(1.-f.x)*(1.-f.x)/6.,(4.-6.*f.x*f.x+3.*f.x*f.x*f.x)/6.,(1.+3.*f.x+3.*f.x*f.x-3.*f.x*f.x*f.x)/6.,f.x*f.x*f.x/6.);
 let wy=array<f32,4>((1.-f.y)*(1.-f.y)*(1.-f.y)/6.,(4.-6.*f.y*f.y+3.*f.y*f.y*f.y)/6.,(1.+3.*f.y+3.*f.y*f.y-3.*f.y*f.y*f.y)/6.,f.y*f.y*f.y/6.);
 var h=0.;for(var y=0;y<4;y++){var r=0.;for(var x=0;x<4;x++){r+=wx[x]*hL(i+vec2i(x-1,y-1),m);}h+=wy[y]*r;}return h;}
fn kindAt(xz:vec2f)->f32{let n=vec2f(textureDimensions(kindMap));let p=vec2i(clamp(boxUV(xz),vec2f(0),vec2f(.9999))*n);return round(textureLoad(kindMap,p,0).r*255.);}
// Visual debug: flat false colour per surface class exactly as the renderer's masks see it (mode 15)
fn surfClassColor(xz:vec2f)->vec3f{let sm=surfMask(xz);let k=kindAt(xz);
 if(sm.b>.5){return vec3f(0.,0.,4.);}           // water: blue
 if(sm.g>.5){return vec3f(4.,4.,4.);}           // sand/bunker: white
 if(sm.a>.75){return vec3f(4.,0.,4.);}          // green: magenta
 if(sm.a>.25){return vec3f(0.,4.,4.);}          // collar/fringe: cyan
 if(sm.r>.5){if(k==4.){return vec3f(4.,1.2,0.);}return vec3f(4.,4.,0.);}   // tee: orange, fairway: yellow
 return vec3f(.03,.03,.03);}                    // rough / other: near-black
// Soft heightfield shadow toward the sun (terrain self-shadowing, also used by grass).
// Bunker edge strip hand-off (lip.js edgeStrip): inside the strip band the camera grid drops 30 cm out of the way (hidden under the
// strip). Only vertices 1.5 cells inside the band and where the distance field is clean (|grad sd|~1) move, so no grid triangle
// that reaches outside the strip ever sags. lp = the grid vertex's local position (for its cell size).
fn gridPush(xz:vec2f,lp:vec2f)->f32{if(F.maskBox.w<.5){return 0.;}let rel=(xz-F.maskBox.xy)/F.maskBox.z;if(any(rel<vec2f(.075))||any(rel>vec2f(.925))){return 0.;}
 let sm1=surfMask(xz).g;if(sm1<.001||sm1>.999){return 0.;}
 let pn1=max(abs(lp.x),abs(lp.y))/72.;var t1=pn1;for(var it=0;it<4;it++){t1=clamp(t1-(.35*t1+.65*pow(t1,2.2)-pn1)/(.35+1.43*pow(max(t1,1e-4),1.2)),0.,1.);}
 let cell1=max(2.*72./384.*(.35+1.43*pow(t1,1.2)),.01);let sd1=(sm1-.5)*1.2;
 if(sd1<-.4+1.5*cell1||sd1>.58-1.5*cell1){return 0.;}
 let e1=max(cell1*1.5,.06);let gg1=vec2f(surfMask(xz+vec2f(e1,0.)).g-surfMask(xz-vec2f(e1,0.)).g,surfMask(xz+vec2f(0.,e1)).g-surfMask(xz-vec2f(0.,e1)).g)*1.2/(2.*e1);
 return select(0.,.3,length(gg1)>.93);}
// New-engine bunkers (lip.js bunkerGeometry) live inside the hole's detail box: there the terrain has no sink at all and the
// turf is cut away exactly along the smoothed outline (signed distance g=.5, bilinear = the same polyline the sand/ribbon use).
// Surface lightness hierarchy (lightest -> darkest): green = tee, fairway = fringe, rough. One brightness gain per class applied
// to the final lit colour of the ground, the mown-turf shells and the blades, so the ordering holds whatever makes up the pixel.
const SURF_GAIN=vec3f(.6,.58,.34);const FRINGE_ADJ=.7;   // the collar's own tone runs brighter than the fairway's: bring it level   // x: green/tee, y: fairway/fringe, z: rough
fn surfGain(xz:vec2f)->f32{let sm=surfMask(xz);let gq=smoothstep(.71,.79,sm.a);let fr=smoothstep(.2,.3,sm.a)*(1.-gq);
 let tee=select(0.,1.,kindAt(xz)==4.)*smoothstep(.38,.62,sm.r);let fw=max(smoothstep(.38,.62,sm.r)*(1.-tee),fr)*(1.-gq);let gt=max(gq,tee);
 return mix(mix(SURF_GAIN.z,SURF_GAIN.y,fw),SURF_GAIN.x,gt)*mix(1.,FRINGE_ADJ,fr);}
fn bunkerNew(xz:vec2f)->bool{if(F.maskBox.w<.5){return false;}let u=(xz-F.maskBox.xy)/F.maskBox.z;return all(u>vec2f(.07))&&all(u<vec2f(.93));}
fn bunkerHole(xz:vec2f)->bool{if(!bunkerNew(xz)){return false;}let u=(xz-F.maskBox.xy)/F.maskBox.z;return textureSampleLevel(maskDetail,linSamp,u,0.).g>.5;}
fn bunkerSink(xz:vec2f)->f32{if(bunkerNew(xz)){return 0.;}
 // wide-footprint average of the sand channel gives a bowl profile: shallow at the lip, ~35 cm deep inside
 var a=surfMask(xz).g*.4;for(var k=0;k<8;k++){let an=f32(k)*.785;a+=surfMask(xz+vec2f(cos(an),sin(an))*1.6).g*.075;}
 let g0=surfMask(xz).g;let lip=smoothstep(.5,.51,g0);   // detail mask g is a signed distance (±.6 m): the drop starts exactly at the sand edge / lip wall
 // a flat 7 cm shelf for the first ~45 cm inside the wall, so the sand meets the wall at one constant depth whatever the
 // terrain grid spacing (the bowl only starts deepening behind that shelf)
 let shelf=smoothstep(.5+.3/1.2,.5+.45/1.2,g0);
 return lip*(.07+.28*smoothstep(.35,1.,a)*shelf);}
// profiler kill switch: bit b set = that shading term is skipped (returns its neutral value)
// FX: the effects that are switched off, as a pipeline-overridable constant. The ground pipelines are specialised per effect
// set (like Unreal's static-switch permutations), so a disabled term is compiled out rather than branched around: the
// uber-shader then needs far fewer registers and runs at much higher occupancy. F.perf.x still carries the runtime mask.
override FX:u32=0u;
fn pk(b:u32)->bool{return ((u32(F.perf.x)|FX)&(1u<<b))!=0u;}
fn glowVisCached(p:vec3f)->f32{let u=boxUV(p.xz);if(any(u<vec2f(0.))||any(u>vec2f(1.))){return 1.;}return textureSampleLevel(tshadowMap,linSamp,u,0.).g;}
fn terrainShadowCached(p:vec3f)->f32{if(pk(3u)){return 1.;}let u=boxUV(p.xz);if(any(u<vec2f(0.))||any(u>vec2f(1.))){return 1.;}return textureSampleLevel(tshadowMap,linSamp,u,0.).r;}
// ---- unified lighting (every surface: terrain, turf, blades, sand, lip, flora) --------------------------------------------
// Irradiance = direct sun (terrain horizon shadow x object shadow x cloud shadow) + sky dome weighted by the point's own sky
// visibility + light bounced off the surrounding ground. No per-surface fill, gain or wrap.
const SKY_K=1.15;
fn bounceLight(n:vec3f)->vec3f{return F.sunColor.rgb*max(F.sunDir.y,0.)*vec3f(.16,.19,.1)*.5*clamp(.5-n.y*.5,0.,1.);}
fn skyLight(n:vec3f,vis:f32)->vec3f{return ambientSky(n)*vis*SKY_K;}
fn skyLightOcc(n:vec3f,vis:f32,sv:f32)->vec3f{return ambientSkyOcc(n,sv)*vis*SKY_K;}
// terrain shadow: march toward the sun; the penumbra is the sun's disc (~0.27 deg half-angle) widened by atmospheric
// refraction/scatter as the sun nears the horizon, so hills cast long soft-edged shadows at dawn and dusk
fn terrainShadow(p:vec3f)->f32{return terrainShadowDir(p,F.sunDir.xyz);}
// horizon occlusion of the bright sun-side sky band (~15 deg up at the sun's azimuth): what hides the dawn/dusk glow
fn glowDir()->vec3f{let s=F.sunDir.xyz;let h=normalize(vec3f(s.x,0.,s.z)+vec3f(1e-4,0.,0.));let e=max(asin(clamp(s.y,-1.,1.)),.26);return vec3f(h.x*cos(e),sin(e),h.z*cos(e));}
fn terrainShadowDir(p:vec3f,s:vec3f)->f32{let cone=.0047+.02*(1.-smoothstep(.02,.25,s.y));var t=.8;var sh=1.;for(var i=0;i<48;i++){let q=p+s*t;let h=groundH(q.xz);sh=min(sh,clamp((q.y-h)/(t*cone+.04)+.5,0.,1.));t*=1.15;if(t>1600.){break;}}return sh;}
// Two-cascade sun shadow map with a 12-tap Poisson PCF; cascade 0 covers the near ~30 m.
fn shTap6(p:vec3f,nrm:vec3f,c:i32)->vec2f{
 let taps=array<vec2f,6>(vec2f(-.326,-.406),vec2f(-.840,-.074),vec2f(-.203,.621),vec2f(.962,-.195),vec2f(.519,.767),vec2f(.185,-.893));
 let q=F.shadowVP[c]*vec4f(p+nrm*select(.015,.12,c==1),1.);let uv=vec2f(q.x*.5+.5,.5-q.y*.5);
 let e=min(min(uv.x,uv.y),min(1.-uv.x,1.-uv.y));if(e<.005||q.z>=1.||q.z<=0.){return vec2f(1.,0.);}
 let texel=select(1./${BUDGET.shadow}.,1.2/${BUDGET.shadow}.,c==1);var s=0.;let rot=hash21(p.xz*37.)*6.2832;let cs=vec2f(cos(rot),sin(rot));
 for(var i=0;i<6;i++){let o=taps[i];let r=vec2f(o.x*cs.x-o.y*cs.y,o.x*cs.y+o.y*cs.x)*texel*2.2;s+=textureSampleCompareLevel(shadowMap,shadowSamp,uv+r,c,q.z-select(.000025,.00008,c==1));}
 return vec2f(s/6.,smoothstep(.005,.12,e));}
fn objShadow(p:vec3f,nrm:vec3f)->f32{if(pk(2u)){return 1.;}let a=shTap6(p,nrm,0);if(a.y>=.999){return a.x;}let b=shTap6(p,nrm,1);return mix(mix(1.,b.x,b.y),a.x,a.y);}
// Sky radiance from the per-frame sky-view LUT (Hillaire 2020): x = azimuth from the sun, y = sqrt-mapped elevation.
fn shTap4(p:vec3f,c:i32)->vec2f{let q=F.shadowVP[c]*vec4f(p+vec3f(0,select(.015,.1,c==1),0),1.);let uv=vec2f(q.x*.5+.5,.5-q.y*.5);
 let e=min(min(uv.x,uv.y),min(1.-uv.x,1.-uv.y));if(e<.005||q.z>=1.||q.z<=0.){return vec2f(1.,0.);}
 let o=select(1.2,1.4,c==1)/${BUDGET.shadow}.;let b=q.z-select(.000025,.00008,c==1);
 let s=(textureSampleCompareLevel(shadowMap,shadowSamp,uv+vec2f(o,o),c,b)+textureSampleCompareLevel(shadowMap,shadowSamp,uv+vec2f(-o,o),c,b)+textureSampleCompareLevel(shadowMap,shadowSamp,uv+vec2f(o,-o),c,b)+textureSampleCompareLevel(shadowMap,shadowSamp,uv-vec2f(o,o),c,b))*.25;
 return vec2f(s,smoothstep(.005,.12,e));}
// cascades cross-fade over a wide band so the split never reads as a ring
fn objShadowOne(p:vec3f)->f32{let q=F.shadowVP[1]*vec4f(p,1.);let uv=vec2f(q.x*.5+.5,.5-q.y*.5);if(any(uv<vec2f(.01))||any(uv>vec2f(.99))||q.z>=1.||q.z<=0.){return 1.;}return textureSampleCompareLevel(shadowMap,shadowSamp,uv,1,q.z-.0002);}
fn objShadowFast(p:vec3f)->f32{if(pk(2u)){return 1.;}let a=shTap4(p,0);if(a.y>=.999){return a.x;}let b=shTap4(p,1);return mix(mix(1.,b.x,b.y),a.x,a.y);}
fn terrainShadowFast(p:vec3f)->f32{let s=F.sunDir.xyz;var t=2.;var sh=1.;for(var i=0;i<14;i++){let q=p+s*t;sh=min(sh,clamp((q.y-groundH(q.xz))/(t*.08)+.5,0.,1.));t*=1.5;if(t>900.){break;}}return sh;}
fn skyUV(d:vec3f)->vec2f{let s=F.sunDir.xyz;let az=atan2(d.z,d.x)-atan2(s.z,s.x);let u=fract(az/(2.*PI)+1.);let e=asin(clamp(d.y,-1.,1.));
 let v=select(.5-.5*sqrt(-e/(PI*.5)),.5+.5*sqrt(e/(PI*.5)),e>=0.);return vec2f(u,1.-v);}
fn skyColor(d:vec3f)->vec3f{return textureSampleLevel(skyLUT,linSamp,skyUV(d),0.).rgb;}
// Sky irradiance: cosine-weighted sum of the sky dome (zenith + four low horizon lobes incl. the bright sun-side glow)
fn ambL(i:u32)->vec3f{let w=2u*i;let a=F.skyAmbH[w/4u][w%4u];let b=F.skyAmbH[(w+1u)/4u][(w+1u)%4u];return vec3f(unpack2x16float(a),unpack2x16float(b).x);}
fn ambientSky(n:vec3f)->vec3f{return ambientSkyOcc(n,1.);}
// sky dome with the sun-side horizon lobe (the brightest part of a low-sun sky) scaled by sv: when the terrain hides the sun it hides that glow too
fn ambientSkyOcc(n:vec3f,sv:f32)->vec3f{let sd=normalize(vec3f(F.sunDir.x,0.,F.sunDir.z)+vec3f(1e-4,0.,0.));let sp=vec3f(-sd.z,0.,sd.x);
 let e=.26;let ce=cos(e);let se=sin(e);
 let d0=vec3f(0.,1.,0.);let d1=sd*ce+vec3f(0.,se,0.);let d2=-sd*ce+vec3f(0.,se,0.);let d3=sp*ce+vec3f(0.,se,0.);let d4=-sp*ce+vec3f(0.,se,0.);
 let w0=max(dot(n,d0)*.5+.5,0.)*1.2;let w1=max(dot(n,d1)*.5+.5,0.);let w2=max(dot(n,d2)*.5+.5,0.);let w3=max(dot(n,d3)*.5+.5,0.);let w4=max(dot(n,d4)*.5+.5,0.);
 let occ=mix(sv,1.,smoothstep(.12,.45,F.sunDir.y));let side=mix(1.,occ,.5);
 let L=array<vec3f,5>(ambL(0u),ambL(1u),ambL(2u),ambL(3u),ambL(4u));   // = skyColor(d0..d4), precomputed (uniform: no texture loads per pixel)
 return (L[0]*w0+L[1]*w1*occ+L[2]*w2+L[3]*w3*side+L[4]*w4*side)*.85;}
fn cloudDensityRaw(xz:vec2f,t:f32)->f32{let p=xz*.00042+vec2f(t*.0016,t*.0005);let base=fbm(p)*1.1+fbm(p*2.7+3.1)*.35;return smoothstep(.62,.96,base);}
fn cloudDensity(xz:vec2f)->f32{return textureSampleLevel(cloudMap,linSamp,(xz-F.box.xy-F.box.z*.5)/CLOUD_SPAN+.5,0.).r;}
fn hg(mu:f32,g:f32)->f32{let g2=g*g;return (1.-g2)/(4.*PI*pow(max(1.+g2-2.*g*mu,1e-4),1.5));}
// Cinematic cloud deck: Beer-powder self shadowing, dual-lobe phase (bright silver linings toward the sun, soft back-glow),
// dark storm bellies, sun-tinted edges at golden hour.
fn clouds(d:vec3f,c0:vec3f)->vec3f{if(d.y<=.005){return c0;}let h=1600.;let hit=F.camPos.xz+d.xz/d.y*(h-F.camPos.y);
 let cov=F.skyZenith.w;let raw=cloudDensity(hit);let dens=clamp(raw*(.55+cov*.9),0.,1.);if(dens<=.002){return c0;}
 let sd=normalize(F.sunDir.xz+vec2f(1e-4));var od=0.;for(var k=1;k<=4;k++){od+=cloudDensity(hit+sd*f32(k*k)*28.);}
 let thick=dens*(1.5+cov*2.);let beer=exp(-od*(1.1+cov)*.9);let powder=1.-exp(-thick*2.4);
 let mu=dot(d,F.sunDir.xyz);let ph=mix(hg(mu,-.25),hg(mu,.82),.62)*4.*PI;
 let edge=(1.-smoothstep(.15,.7,dens));let silver=pow(max(mu,0.),6.)*edge*3.5;
 let sunL=F.sunColor.rgb*(beer*powder*ph*.8+silver*beer*1.2);
 let amb=ambientSky(vec3f(0.,1.,0.))*.35*mix(.95,.45,smoothstep(.3,1.,dens)*cov)+skyColor(normalize(vec3f(d.x,.02,d.z)))*.25;
 var col=sunL+amb*(.5+.5*powder);
 // distance haze into the horizon
 let far=1.-smoothstep(.0,.22,d.y);col=mix(col,c0,far*.85);
 let a=(1.-exp(-thick*3.))*smoothstep(.005,.06,d.y);
 return mix(c0,col,a);}
// Cloud shadows drift across the land.
fn cloudShadow(p:vec3f)->f32{if(pk(4u)){return 1.;}let s=F.sunDir.xyz;let hit=p.xz+s.xz/max(s.y,.05)*(1600.-p.y);return 1.-cloudDensity(hit)*.4;}
// Aerial perspective: analytic exponential height fog (broad atmosphere + a thin low-lying mist layer) lit by the sky
// and by the sun through a strongly forward-scattering Mie lobe -> the glowing, light-soaked distance of a film frame.
fn fogInscatter(v:vec3f)->vec3f{let mu=dot(v,F.sunDir.xyz);let hz=F.sunColor.w;
 let sky=skyColor(normalize(vec3f(v.x,max(v.y,.02)*.35+.02,v.z)));
 let mie=(hg(mu,.72)*.9+hg(mu,.2)*.1)*4.*PI;
 let skyN=mix(sky,vec3f(dot(sky,vec3f(.3,.5,.2)))*vec3f(.95,1.,1.08),.5);
 return skyN*.8+F.sunColor.rgb*mie*(.01+.014*hz)*max(smoothstep(-.12,.08,F.sunDir.y),0.);}
fn fogOD(p:vec3f,d:f32)->f32{let hz=F.sunColor.w;let c=F.camPos.xyz;let base=F.box.w;
 let dy=p.y-c.y;
 // broad haze, 900 m scale height
 let H1=900.;let b1=(.00003+.00026*hz*hz)*exp(-(c.y-base)/H1);let f1=select((1.-exp(-dy/H1))/(dy/H1),1.,abs(dy)<.01);
 // ground mist, 18 m scale height, strongest at low sun and with haze
 let H2=18.;let mist=F.skyHorizon.w;let b2=mist*.0022*exp(-max(c.y-base,0.)/H2)*mix(.35,1.7,smoothstep(.3,.75,tn(p.xz*.0025).r));   /* patchy banks, like the valley mist in the refs */let f2=select((1.-exp(-dy/H2))/(dy/H2),1.,abs(dy)<.01);
 return d*(b1*f1+b2*clamp(f2,0.,1.));}
// haze as (in-scatter * (1 - T), T): colour * T + in-scatter. The deferred haze pass blends exactly this over the lit ground.
fn fogParts(p:vec3f)->vec4f{let d=length(p-F.camPos.xyz);let v=(p-F.camPos.xyz)/max(d,1e-3);
 let T=exp(-fogOD(p,d));
 // near-field sun scattering is rendered (shadowed) by the volumetric shaft pass; keep only the distant part here
 let mu=dot(v,F.sunDir.xyz);let sunPart=F.sunColor.rgb*(hg(mu,.72)*.9+hg(mu,.2)*.1)*4.*PI*(.01+.014*F.sunColor.w)*max(smoothstep(-.12,.08,F.sunDir.y),0.);
 /* distant haze is lit by the sun only where the terrain lets it through: average sun visibility along the view ray */
 var rv=0.;let farW=smoothstep(300.,650.,d);if(farW>0.){for(var k=0;k<select(2,0,fastLit());k++){let q=F.camPos.xyz+v*d*(f32(k)*.4+.45);let gh=groundH(q.xz);rv+=mix(1.,terrainShadowCached(vec3f(q.x,gh,q.z)),1.-smoothstep(4.,60.,q.y-gh));}rv=select(rv*.5,terrainShadowCached(p),fastLit());}   /* it only weighs in past 300 m: nearer pixels skip the two 20-tap height lookups */
 let ins=fogInscatter(v)-sunPart*(1.-farW*rv);return vec4f(ins*(1.-T),T);}
fn fogApply(c:vec3f,p:vec3f)->vec3f{return c;}   // haze removed from the game: surfaces take no aerial-perspective fog (the sky keeps its own horizon glow)
// fogApply without the per-pixel terrain-shadow march along the view ray (sea floor / flat water: the haze over open sea
// sees no terrain between it and the sun except at the point itself)
fn fogApplyLite(c:vec3f,p:vec3f)->vec3f{return c;}
fn aces(x:vec3f)->vec3f{let a=x*(x+.0245786)-.000090537*(1.-exp(-x/.0037));let b=x*(.983729*x+.4329510)+.238081;return clamp(a/b,vec3f(0),vec3f(1));}

// =====================================================================================================================
// LIGHTING ENGINE - one physically based model for every surface in the game (terrain, bunker sand, lip soil, mown turf,
// rough & native grass blades, plants, rocks, buildings). Direct sun through a layered visibility term, sky dome
// irradiance gated by each point's own sky visibility, ground-bounced light, GGX specular with sky reflection, and
// canopy / thin-leaf transmission for vegetation. Nothing is lit by anything but the sun and the sky.
// =====================================================================================================================
struct LitSurf{p:vec3f,n:vec3f,alb:vec3f,rough:f32,f0:f32,canopy:f32,trans:f32,ao:f32,vis:f32}
// shaped ground height as it is drawn: terrain + relief, minus bunker bowls and the seabed drop
fn bunkerDepth(xz:vec2f)->f32{if(!bunkerNew(xz)){return bunkerSink(xz);}let u=(xz-F.maskBox.xy)/F.maskBox.z;
 let sd=(textureSampleLevel(maskDetail,linSamp,u,0.).g-.5)*1.2;if(sd<=0.){return 0.;}let x=min(sd/1.6,1.);return .0508+.28*(1.-(1.-x)*(1.-x));}
fn shapeH(xz:vec2f)->f32{return groundH(xz)-bunkerDepth(xz)-seabedDrop(xz);}
// cheaper variant for the marches (bilinear relief, no seabed term): the same surface to within millimetres on land
fn shapeHF(xz:vec2f)->f32{return groundH0(xz)+textureSampleLevel(reliefMap,linSamp,boxUV(xz),0.).r-bunkerDepth(xz);}
// the same surface from the terrain height cache (clipmap: the finished ground incl. relief and old-bunker sink, 12.5 cm near
// the camera, bilinear 4 taps) plus the new-engine sand bowl, which the cache doesn't carry. ~6 texture taps instead of ~20-50.
fn shapeHC(xz:vec2f)->f32{if(F.clip[0].w<.5){return shapeHF(xz);}
 // one clipmap level per sample (the finest whose window holds xz with a 4 m margin), no cross-level blend: a contact march
 // only needs the height, and the seam blend's loop and smoothsteps cost more than the 4 taps themselves
 let dc=max(abs(xz.x-F.camPos.x),abs(xz.y-F.camPos.z));let l=clamp(i32(ceil(log2(max(dc/28.,1.)))),0,CM_L-1);
 var h=0.;if(F.clip[l].w>.5){h=cmHl(l,xz)*F.clip[7].w;}else{h=terrainH(xz)*F.clip[7].w;}
 if(bunkerNew(xz)){let u=(xz-F.maskBox.xy)/F.maskBox.z;let sd=(textureSampleLevel(maskDetail,linSamp,u,0.).g-.5)*1.2;if(sd>0.){let x=min(sd/1.6,1.);h-=.0508+.28*(1.-(1.-x)*(1.-x));}}return h;}
// contact shadows: a fine march over the shaped height field toward the sun (bunker lips onto sand, mounds, swales,
// knobs smaller than the cached terrain-shadow texel). Penumbra = sun disc widened near the horizon.
fn sunCone()->f32{return .0047+.02*(1.-smoothstep(.02,.25,F.sunDir.y));}
// Fast lighting (Visual debug toggle): cheaper contact march, near AO, object shadow and haze visibility
fn fastLit()->bool{return F.skyHorizon.y>=50.;}
fn contactShadow(p:vec3f,n:vec3f)->f32{if(pk(0u)){return 1.;}let d=distance(p,F.camPos.xyz);if(d>70.){return 1.;}let s=F.sunDir.xyz;if(s.y<=-.02){return 0.;}
 let fl=fastLit()||d>20.;   /* beyond 20 m the short form (7 longer steps, same reach), as the grass blades' contact march already does: a pixel there spans several cm, finer steps add nothing */
 let cone=sunCone()*select(1.,1.35,fl);var o=p+n*.015+vec3f(0.,.005,0.);o.y=max(o.y,shapeHC(p.xz)+.02);   /* march from the heightfield's own surface: a drawn surface sitting a few cm under it (sand, lips) must not self-shadow */var t=select(.025,.045,fl);var sh=1.;
let steps=select(10,7,fl);let gr=select(1.95,2.6,fl);   /* fast: fewer, longer steps but the same ~15-40 m reach, so long lip/bank shadows survive */
 for(var i=0;i<steps;i++){let q=o+s*t;let h=shapeHC(q.xz);sh=min(sh,clamp((q.y-h)/(t*cone+.008)+.5,0.,1.));t*=gr;}   /* no early exit: every step's taps are independent, so the GPU issues them together instead of one round trip per step */
 return mix(sh,1.,smoothstep(50.,70.,d));}
// near-field sky occlusion from the shaped ground (bunker bowls, swales, the foot of a bank) at decimetre scale
fn nearAO(p:vec3f)->f32{if(pk(1u)){return 1.;}let d=distance(p,F.camPos.xyz);if(d>30.){return 1.;}var occ=0.;let rot=hash21(floor(p.xz*7.))*1.57;let fl=fastLit();
 for(var k=0;k<4;k++){let an=f32(k)*1.5708+rot;let dir=vec2f(cos(an),sin(an));var mx=0.;
  for(var j=0;j<select(2,1,fl);j++){let r=select(.35*pow(3.2,f32(j)),.75,fl);let dh=shapeHC(p.xz+dir*r)-p.y;mx=max(mx,dh/sqrt(dh*dh+r*r));}occ+=max(mx,0.);}   /* the height cache: same shaped surface (relief, bunker bowls) in ~6 taps instead of the full B-spline's ~20-50 */
 return mix(clamp(1.-occ*.3,.2,1.),1.,smoothstep(20.,30.,d));}
// the complete sun visibility for a surface point
fn sunVis(p:vec3f,n:vec3f)->f32{var o=1.;if(fastLit()){o=objShadowFast(p+n*.03);}else{o=objShadow(p,n);}return terrainShadowCached(p)*o*cloudShadow(p)*contactShadow(p,n);}
fn sunVisFast(p:vec3f)->f32{return terrainShadowCached(p)*objShadowFast(p)*cloudShadow(p)*contactShadow(p,vec3f(0.,1.,0.));}
// Geometric specular anti-aliasing (Kaplanyan & Hill 2016 / Tokuyoshi 2019, as in UE's material pipeline): the spread of the
// shading normal across one pixel is added to the GGX roughness, so a pixel shows the averaged highlight instead of a random
// sample of it. Removes sparkle on thin, fast-turning surfaces (grass blades, leaves, raked sand). Fragment stage only.
fn specAARough(n:vec3f,rough:f32)->f32{let du=dpdx(n);let dv=dpdy(n);let v2=.25*(dot(du,du)+dot(dv,dv));
 let a=max(rough*rough,.002);let a2=clamp(a*a+min(2.*v2,.3),0.,1.);return sqrt(sqrt(a2));}
fn dGGX(nh:f32,a:f32)->f32{let a2=a*a;let d=nh*nh*(a2-1.)+1.;return a2/(PI*d*d);}
fn vSmith(nv:f32,nl:f32,a:f32)->f32{let k=a*.5;return .25/((nv*(1.-k)+k)*(nl*(1.-k)+k));}
fn fSchlick(f0:f32,vh:f32)->f32{let m=1.-vh;let m2=m*m;return f0+(1.-f0)*m2*m2*m;}
// Lighting split into an albedo-weighted diffuse response and an additive specular part, so passes with heavy overdraw
// (grass blades, turf shells) can evaluate the engine per vertex and multiply by albedo per pixel - exactly equivalent.
struct LitOut{d:vec3f,s:vec3f}
fn shadeSplit(S:LitSurf)->LitOut{let s=F.sunDir.xyz;let v=normalize(F.camPos.xyz-S.p);let n=S.n;let h=normalize(v+s);
 let nl=dot(n,s);let nv=max(dot(n,v),.02);let sunUp=smoothstep(-.02,.02,s.y);
 // vegetation canopy: leaves stand at every angle (spherical leaf-angle distribution, G=.5): half Lambert on the ground
 // normal, half independent of it
 let lam=mix(max(nl,0.),.5*max(nl,0.)+.5*max(s.y,0.),S.canopy);
 let a=max(S.rough*S.rough,.02);let F0=fSchlick(S.f0,max(dot(v,h),0.));let tb=max(dot(-v,s),0.);
 let spec=dGGX(max(dot(n,h),0.),a)*vSmith(nv,max(nl,0.),a)*F0*max(nl,0.)*PI;
 let sun=F.sunColor.rgb*S.vis*sunUp;
 var o:LitOut;
 o.d=sun*lam*(1.-F0)+sun*S.trans*(tb*tb*tb*.6+max(-nl,0.)*.35)+skyLightOcc(n,S.ao,select(mix(glowVisCached(S.p),S.vis,smoothstep(.015,.06,F.sunDir.y)),S.vis,F.sunDir.y>=.06))+   /* twilight (sun held at the horizon): what hides the glow band; sun up: the sun's own shadow */bounceLight(n)*S.ao*mix(.3,1.,S.vis);
 let r=reflect(-v,n);let mv=1.-nv;let mv2=mv*mv;let fr=S.f0+(max(1.-S.rough,S.f0)-S.f0)*mv2*mv2*mv;
 if(pk(13u)){o.s=vec3f(0.);return o;}
 // a vegetation canopy is not a glossy sheet: blades at every angle shadow and mask each other, so the macro surface's GGX
 // lobe (turf, rough ground, far blades) keeps ~30% of its energy. Unscaled it laid a silver sheen over every sunward lawn.
 // canopy surfaces keep 3% of the sky reflection: the sky-view LUT lookup (2 atan2 + asin) is replaced there by the ambient lobes
 let rs=normalize(vec3f(r.x,max(r.y,.02),r.z));var sk:vec3f;if(S.canopy>.99){sk=mix((ambL(1u)+ambL(2u)+ambL(3u)+ambL(4u))*.25,ambL(0u),sqrt(rs.y));}else{sk=skyColor(rs);}
 o.s=sun*spec*mix(1.,.3,S.canopy)+sk*fr*S.ao*(1.-S.rough*.7)*.5*(1.-.97*S.canopy)*mix(.15,1.,S.vis);
 return o;}
fn shade(S:LitSurf)->vec3f{let o=shadeSplit(S);return S.alb*o.d+o.s;}
`;
