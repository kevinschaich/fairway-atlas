import {FRAME,COMMON} from './shaders-common.js';
// Cached lighting maps: terrain sun-visibility over the course box (rebuilt when the sun or terrain changes)
// and a world-space cloud density field (rebuilt every few frames as clouds drift).
export const MAPS=FRAME+COMMON+/*wgsl*/`
@group(1) @binding(0) var outTex:texture_storage_2d<rgba16float,write>;
@group(1) @binding(1) var<uniform> M:vec4f; // mode, time
// Course micro-relief (metres) layered over the ~1 m elevation data: flashed bunker faces that rise toward each trap,
// rolling mounds through the rough, gentle undulation in fairways/greens. Everything that samples groundH() sees it.
fn ring(xz:vec2f,r:f32)->vec4f{var a=vec4f(0);for(var k=0;k<10;k++){let an=f32(k)*.6283;a+=surfMask(xz+vec2f(cos(an),sin(an))*r);}return a*.1;}
fn courseRelief(xz:vec2f)->f32{let m=surfMask(xz);let r1=ring(xz,1.1);let r2=ring(xz,2.4);let r3=ring(xz,4.2);let r4=ring(xz,7.);
 let outside=1.-smoothstep(.3,.5,m.g);
 let face=outside*(r1.g*.48+r2.g*.36+r3.g*.22+r4.g*.12)*(1.-m.b);                 // flashed face / berm up to ~0.6 m
 let wet=max(m.b,max(r2.b,r3.b));
 // swells run through the whole hole (softer on mown turf, nearly flat on greens), blended over wide rings so no edge steps
 let roughW=mix(1.,.5,smoothstep(.2,.8,(r3.r+r4.r)*.5))*(1.-.75*max(m.a,r3.a))*(1.-.8*max(r3.g,r4.g))*(1.-wet);
 let n1=tn(xz*.0055).r-.5;let n2=tn(xz*.013+vec2f(.3,.7)).g-.5;let n3=tn(xz*.028).b-.5;   // slow swells: ~180 m, ~75 m, ~35 m
 let mounds=(n1*1.6+n2*.7+n3*.18)*roughW;
 let fair=(tn(xz*.009).a-.5)*.22*m.r*(1.-m.g);
 // tees and greens are built, surveyed surfaces: no synthetic relief on them, feathered back in over ~5 m outside
 let k0=kindAt(xz);var flat=select(0.,1.,k0==3.||k0==4.);var rs=array<f32,4>(1.,2.,3.5,5.);var ws=array<f32,4>(.85,.6,.35,.12);
 for(var k=0;k<8;k++){let an=f32(k)*.7854+.39;let d=vec2f(cos(an),sin(an));
  for(var j=0;j<4;j++){let kk=kindAt(xz+d*rs[j]);if(kk==3.||kk==4.){flat=max(flat,ws[j]);}}}
 return (face+mounds+fair)*(1.-flat);}
@compute @workgroup_size(8,8) fn build(@builtin(global_invocation_id) id:vec3u){let dim=textureDimensions(outTex);if(id.x>=dim.x||id.y>=dim.y){return;}
 let uv=(vec2f(id.xy)+.5)/vec2f(dim);
 if(M.x<.5){let xz=F.box.xy+uv*F.box.z;let p=vec3f(xz.x,groundH(xz)+1.2,xz.y);textureStore(outTex,id.xy,vec4f(terrainShadow(p),terrainShadowDir(p,glowDir()),0.,1.));}
 else if(M.x>2.5){let xz=F.box.xy+uv*F.box.z;let h0=groundH(xz);var occ=0.;var conv=0.;
  // horizon-based sky visibility over the shaped ground (8 directions x 5 steps) + convexity for crest dryness
  for(var k=0;k<8;k++){let an=f32(k)*.7854+.3;let d=vec2f(cos(an),sin(an));var mx=0.;
   for(var j=0;j<7;j++){let r=.6*pow(2.1,f32(j));let dh=groundH(xz+d*r)-h0;mx=max(mx,dh/sqrt(dh*dh+r*r));}
   conv+=groundH(xz+d*14.)-h0;
   occ+=max(mx,0.);}
  let ao=clamp(1.-occ/8.*1.35,.25,1.);let dry=smoothstep(.05,.45,-conv/8.);
  textureStore(outTex,id.xy,vec4f(ao,dry,0.,1.));}
 else if(M.x>1.5){let xz=F.box.xy+uv*F.box.z;let r=courseRelief(xz);var land=0.;for(var k=0;k<8;k++){let an=f32(k)*.785+.2;let dv=vec2f(cos(an),sin(an));
   land+=(1.-seabedDrop(xz+dv*5.)/5.)*.5+(1.-seabedDrop(xz+dv*14.)/5.)*.33+(1.-seabedDrop(xz+dv*30.)/5.)*.17;}
  textureStore(outTex,id.xy,vec4f(r,r-bunkerSink(xz),clamp(land/8.*1.8,0.,1.),1.));}
 else{let xz=F.box.xy+F.box.z*.5+(uv-.5)*CLOUD_SPAN;textureStore(outTex,id.xy,vec4f(cloudDensityRaw(xz,M.y),0.,0.,1.));}}
`;
