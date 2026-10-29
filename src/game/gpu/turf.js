import {FRAME,COMMON} from './shaders-common.js';
// Mown turf (greens, tees, fairway) as stacked shells over a camera-centred grid.
// Each shell cuts blade cross-sections out of a jittered cell pattern; blades lean with the
// mowing direction so stripes come from real geometry + view angle, not a painted texture.
export const TURF_SHELLS=14,TURF_GRID=200,TURF_SPACING=.45;
// Rings of shells around the eye: the fine ring (0.45 m quads, 90 m square) plus, for "high-quality turf everywhere", a coarse
// ring (1.8 m quads, 360 m square) with the fine ring's square cut out. Blade detail is computed per pixel from world xz and
// retires by pixel footprint, so quad size only sets how closely the shells follow the ground.
export const TURF_RINGS=[{grid:TURF_GRID,spacing:TURF_SPACING,hole:0},{grid:TURF_GRID,spacing:1.8,hole:TURF_GRID*TURF_SPACING*.5-.9}];
export const turfShader=(ring,full)=>FRAME+COMMON+/*wgsl*/`
const NS=${TURF_SHELLS}.;const LOD=5.;   /* high-quality blade range: footprint thresholds x5 (the default camera sits a few feet behind the ball, so x1 retired the blades right around the tee box) */const GN=${ring.grid}u;const SP=${ring.spacing};const HOLE=${ring.hole.toFixed(3)};const FULL=${full?'true':'false'};
struct VO{@builtin(position) pos:vec4f,@location(0) wp:vec3f,@location(1) @interpolate(flat) layer:f32,@location(2) mask:vec2f,@location(3) light:f32,@location(4) macroCol:vec3f,@location(5) gn:vec3f,@location(6) Ld:vec3f,@location(7) Ls:vec3f}
fn turfH(g:f32)->f32{return mix(.018,.009,g);}
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->VO{
 var o:VO;let q=vi/6u;let c=vi%6u;let corner=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[c];
 let qx=f32(q%GN);let qz=f32(q/GN);let org=floor(F.camPos.xz/SP)*SP-f32(GN)*.5*SP;
 let xz=org+(vec2f(qx,qz)+corner)*SP;let qc=org+(vec2f(qx,qz)+.5)*SP;
 // coarse ring: skip quads wholly inside the fine ring's square (measured from the fine ring's own snapped origin)
 if(HOLE>0.){let fo=floor(F.camPos.xz/.45)*.45;let a=abs(org+vec2f(qx,qz)*SP-fo);let b=abs(org+(vec2f(qx,qz)+1.)*SP-fo);if(max(max(a.x,b.x),max(a.y,b.y))<HOLE){o.pos=vec4f(0,0,-2,1);return o;}}
 let layer=f32(ii);let hn=layer/NS;let d=distance(qc,F.camPos.xz);
 // quad has turf?  (max of corner masks so borders are covered)
 let h2=SP*.5;var mr=0.;for(var k=0;k<4;k++){let o2=vec2f(f32(k&1),f32(k>>1))*2.-1.;mr=max(mr,surfMask(qc+o2*h2).r);}
 // upper shells only near the eye; they retire top-first so the transition is gradual
 let reach=select(mix(45.,20.,hn),1e9,FULL);   /* full quality: every shell everywhere, retired only by the per-pixel footprint test */
 if(mr<.01||(ii>0u&&d>reach)){o.pos=vec4f(0,0,-2,1);return o;}
 let m=surfMask(xz);let H=turfH(m.a);
 let y=groundH(xz)+.003+hn*H;let p=vec3f(xz.x,y,xz.y);
 o.pos=F.viewProj*vec4f(p,1.);o.wp=p;o.layer=layer;o.mask=vec2f(m.r,m.a);
 {let e=.25;o.gn=normalize(vec3f(shapeH(xz-vec2f(e,0.))-shapeH(xz+vec2f(e,0.)),2.*e,shapeH(xz-vec2f(0.,e))-shapeH(xz+vec2f(0.,e))));}
 o.light=objShadowFast(p)*terrainShadowCached(p)*cloudShadow(p)*contactShadow(p,o.gn);
 let ground=textureSampleLevel(baseMap,linSamp,boxUV(xz),0.).rgb;let su=(xz-F.satBox.xy)/F.satBox.z;let sat=textureSampleLevel(satMap,linSamp,su,1.).rgb;
 o.macroCol=mix(ground,sat,.6*F.extra.x);
 {var S:LitSurf;S.p=p;S.n=o.gn;S.rough=.6;S.f0=.035;S.canopy=.85;S.trans=.08;S.ao=groundAO(xz).x*nearAO(p);S.vis=o.light;S.alb=vec3f(1.);
  let L=shadeSplit(S);o.Ld=L.d;o.Ls=L.s;}
 return o;}
fn h2(p:vec2f,s:f32)->vec2f{return fract(sin(vec2f(dot(p,vec2f(127.1,311.7)),dot(p,vec2f(269.5,183.3)))+s)*43758.5453);}
@fragment fn fs(v:VO)->@location(0) vec4f{
 let xz=v.wp.xz;let g=v.mask.y;let hn=v.layer/NS;
 if(i32(F.skyHorizon.z+.5)==22){return vec4f(v.Ld,1.);}   /* 22 (turf): diffuse irradiance */
 if(i32(F.skyHorizon.z+.5)==20){return vec4f(v.light,terrainShadowCached(v.wp),contactShadow(v.wp,normalize(v.gn)),1.);}   /* 20 (turf): r=total vis g=terrain b=contact */
 let d=distance(v.wp,F.camPos.xyz);
 let edge=fract(sin(dot(floor(xz*90.),vec2f(12.9898,78.233)))*43758.5);if(v.mask.x<edge*.9+.05){discard;}
 let cell=mix(.0085,.0062,g);let gc=xz/cell;
 let fw=length(fwidth(gc));            // cells per pixel: drives the level of detail, not distance
 var alb=mix(vec3f(.13,.27,.06),vec3f(.2,.36,.08),g);
 alb=mix(alb,v.macroCol*vec3f(1.,1.12,.9),.35)*surfGain(v.wp.xz);   // reflectance calibration (albedo)
 // lighting engine: mown turf is a canopy on the true ground normal, shaded by the same shade() as every other surface
 if(v.layer>.5){
  if(fw>.9*LOD||pk(15u)){discard;}
  // leaning flat leaves: each blade's horizontal slice is a short segment across its width,
  // displaced along its lean direction as it rises (arching), so from above leaves read as crisscross strokes
  let id=floor(gc);var hit=false;var tt=0.;var hue=0.;var face=0.;
  for(var j=-1;j<=1;j++){for(var i=-1;i<=1;i++){for(var b=0;b<2;b++){
   let cid=id+vec2f(f32(i),f32(j));let r=h2(cid+f32(b)*17.31,1.3);let r2=h2(cid+f32(b)*9.7,4.1);
   let hh=.45+.55*r2.x;if(hn>hh){continue;}
   // blades vanish one by one as they get sub-pixel, instead of a whole layer popping
   if(fw*(.55+.9*r2.y)>.55*LOD){continue;}
   let t=hn/hh;let a=r.x*6.2832;let dir=vec2f(cos(a),sin(a));
   let lean=(.35+.75*r2.y)*t*t*1.15;
   let ctr=cid+r*.9+.05+dir*lean;
   let q=gc-ctr;let along=dot(q,dir);let across=dot(q,vec2f(-dir.y,dir.x));
   let half=(.13+.08*r.y)*(1.-pow(t,3.));
   if(abs(across)<half&&abs(along)<.11+.12*t){hit=true;tt=t;hue=r2.x*.6+r.y*.4;face=dot(dir,normalize(F.sunDir.xz+1e-4));}}}}
  if(!hit){discard;}
  var c=alb*(.8+.4*hue);c=mix(c,c*vec3f(1.18,1.14,.78),smoothstep(.65,1.,tt)*.45);
  if(hue>.93){c=mix(c,vec3f(.42,.38,.16),.35);}
  let ao=mix(.3,1.,pow(tt,.7)*.75+hn*.25);
  let lit=1.+.18*face*tt;
  let col=c*ao*lit*v.Ld+v.Ls;
  return vec4f(fogApply(col,v.wp),1.);}
 // base: thatch under the blades close up, the averaged sward once blades are sub-pixel
 let far=smoothstep(.25*LOD,.9*LOD,fw);let nz=tn(xz*.37).r*.5+tn(xz*2.3).g*.5;
 let thatch=alb*vec3f(.6,.55,.42)*.4;
 let top=alb*(.84+.16*nz)*.74;
 let col=mix(thatch,top,far)*v.Ld+v.Ls;
 return vec4f(fogApply(col,v.wp),1.);}
`;
