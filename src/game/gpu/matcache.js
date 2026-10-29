// Ground material cache: a runtime virtual texture for the terrain (the approach of Unreal's Runtime Virtual Texturing /
// Far Cry's terrain "virtual texture").
//
//  The ground material is expensive per pixel, but most of it depends only on world xz: the painted surface map, the aerial
//  photo blend with its collar / bunker-surround corrections, the wet beach, the rough's matted patches (9 value-noise
//  octaves), the native-cover lookup and the per-surface reflectance. Those are baked here into MC_L nested camera-centred
//  windows of MC_N x MC_N texels (level l: MC_T0 * 2^l metres per texel), stored toroidally like the height cache: when the
//  camera moves only the newly exposed rows/columns are re-baked, when it is still nothing is. The pixel shader then reads
//  two filtered taps (matCache() in shaders-common.js) and keeps only the camera-dependent terms (near fibre, distance haze
//  tint, sand, footprint-filtered grain, matting sheen lobe, clump mottle, lighting).
//
//  Everything baked is low-frequency (>= ~0.3 m features: the source textures are 0.15-1 m per texel), so the 12.5 cm
//  finest level reproduces it; at distance the window texel grows with range, like the pixel footprint.
//  A full rebuild (new course data, textures, first frame) is spread over frames, coarsest level first; until a level is
//  ready the ground shader falls back to the exact per-pixel path for the pixels that need it.
import {FRAME,COMMON} from './shaders-common.js';
import {GA} from './shaders.js';

export const MC_N=1024,MC_L=7,MC_T0=.125,MC_SNAP=16;
const BUDGET=1<<20;   // texels baked per frame at most (one full level)

export const MC_GEN='diagnostic(off,derivative_uniformity);\n'+FRAME+COMMON+/*wgsl*/`
var<private> gDX:vec2f;var<private> gDY:vec2f;
struct Reg{o:vec4i,w:vec4i,t:vec4f}   // o: region x0,z0,w,h (lattice); w: window x0,z0,level; t.x: texel size (m)
@group(1) @binding(0) var<uniform> R:Reg;
@group(1) @binding(1) var outA:texture_storage_2d_array<rgba8unorm,write>;
@group(1) @binding(2) var outB:texture_storage_2d_array<rgba8unorm,write>;
`+GA+/*wgsl*/`
fn mcWrap(i:vec2i)->vec2i{return ((i%vec2i(MC_N))+vec2i(MC_N))%vec2i(MC_N);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(i32(id.x)>=R.o.z||i32(id.y)>=R.o.w){return;}
 let li=R.o.xy+vec2i(id.xy);let xz=vec2f(li)*R.t.x;let sm=surfMask(xz);
 let S=groundAlbedoStatic(xz,sm,R.t.x);
 // native cover weight: the same jittered kind lookup the ground shader and the blades use
 let jw=(tn(xz*.23).rg-.5)*4.+(tn(xz*1.7).ba-.5)*1.4;let nat=select(0.,1.,kindAt(xz+jw)==8.)*(1.-smoothstep(.3,.6,sm.r));
 let mf=matField(xz);
 textureStore(outA,mcWrap(li),R.w.z,vec4f(sqrt(max(S,vec3f(0.))),nat));
 textureStore(outA,mcWrap(li),R.w.z+MC_L,clamp(sm,vec4f(0.),vec4f(1.)));   // surface mask for the lean terrain G-buffer (fsGT)
 textureStore(outB,mcWrap(li),R.w.z,vec4f(mf.x/MAT_STRENGTH,mf.yz*.5+.5,surfGain(xz)*.5));}
`;

export class MatCache{
 constructor(dev){this.dev=dev;const U=GPUTextureUsage;
  const tex=(label,n=MC_L)=>dev.createTexture({label,size:[MC_N,MC_N,n],format:'rgba8unorm',usage:U.STORAGE_BINDING|U.TEXTURE_BINDING});
  this.aTex=tex('material cache A (albedo, native; layers MC_L+: surface mask)',MC_L*2);this.bTex=tex('material cache B (matting, gain)');
  this.dummy=dev.createTexture({size:[1,1,1],format:'rgba8unorm',usage:U.TEXTURE_BINDING});
  this.win=Array.from({length:MC_L},()=>({x:0,z:0,valid:false,ready:false}));this.key=null;this.regions=[];this.pending=[];
  this.regBuf=dev.createBuffer({label:'material cache regions',size:64*256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.stats={texels:0,ready:0};}
 build(frameLayout,mod){const d=this.dev;
  this.L=d.createBindGroupLayout({entries:[{binding:0,visibility:4,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:48}},
   {binding:1,visibility:4,storageTexture:{access:'write-only',format:'rgba8unorm',viewDimension:'2d-array'}},{binding:2,visibility:4,storageTexture:{access:'write-only',format:'rgba8unorm',viewDimension:'2d-array'}}]});
  this.pipe=d.createComputePipeline({layout:d.createPipelineLayout({bindGroupLayouts:[frameLayout,this.L]}),compute:{module:mod(MC_GEN),entryPoint:'main'}});
  this.BG=d.createBindGroup({layout:this.L,entries:[{binding:0,resource:{buffer:this.regBuf,size:48}},{binding:1,resource:this.aTex.createView({dimension:'2d-array'})},{binding:2,resource:this.bTex.createView({dimension:'2d-array'})}]});}
 // windows for this camera; out = 32 floats for F.mclip ([l] = origin xy, texel, ready; [7].x = enabled)
 plan(cam,key,out,enabled=true){this.regions=[];
  if(key!==this.key){this.key=key;for(const w of this.win){w.valid=false;w.ready=false;}this.pending=[];}
  for(let l=0;l<MC_L;l++){const t=MC_T0*2**l,w=this.win[l];const nx=Math.round((cam.x/t-MC_N/2)/MC_SNAP)*MC_SNAP,nz=Math.round((cam.z/t-MC_N/2)/MC_SNAP)*MC_SNAP;
   if(!w.valid||Math.abs(nx-w.x)>=MC_N||Math.abs(nz-w.z)>=MC_N){w.ready=false;this.pending=this.pending.filter(p=>p.l!==l);this.pending.push({l,x:nx,z:nz});}
   else if(w.ready){const dx=nx-w.x,dz=nz-w.z;
    if(dx)this.regions.push([l,dx>0?w.x+MC_N:nx,nz,Math.abs(dx),MC_N,nx,nz]);
    if(dz)this.regions.push([l,nx,dz>0?w.z+MC_N:nz,MC_N,Math.abs(dz),nx,nz]);}
   else{const p=this.pending.find(p=>p.l===l);if(p){p.x=nx;p.z=nz;}}
   w.x=nx;w.z=nz;w.valid=true;}
  // full-level rebuilds, coarsest first, within the per-frame budget (a level that is still pending reads as not ready)
  this.pending.sort((a,b)=>b.l-a.l);let budget=BUDGET;
  while(this.pending.length&&budget>=MC_N*MC_N){const p=this.pending.shift();this.regions.push([p.l,p.x,p.z,MC_N,MC_N,p.x,p.z]);this.win[p.l].ready=true;budget-=MC_N*MC_N;}
  let ready=0;for(let l=0;l<MC_L;l++){const w=this.win[l];out.set([w.x,w.z,MC_T0*2**l,w.ready?1:0],l*4);if(w.ready)ready++;}
  out.set([enabled&&ready>0?1:0,0,0,0],28);this.stats.ready=ready;return this.regions.length;}
 encode(enc,frameBG){if(!this.regions.length||!this.pipe){this.stats.texels=0;return;}const R=this.regions.slice(0,64),d=this.dev,data=new ArrayBuffer(R.length*256);let texels=0;
  R.forEach(([l,x0,z0,w,h,wx,wz],i)=>{const b=i*256;new Int32Array(data,b,8).set([x0,z0,w,h,wx,wz,l,0]);new Float32Array(data,b+32,4).set([MC_T0*2**l,0,0,0]);texels+=w*h;});
  d.queue.writeBuffer(this.regBuf,0,data);
  const cp=enc.beginComputePass();cp.setBindGroup(0,frameBG);cp.setPipeline(this.pipe);
  R.forEach(([,, ,w,h],i)=>{cp.setBindGroup(1,this.BG,[i*256]);cp.dispatchWorkgroups(Math.ceil(w/8),Math.ceil(h/8));});cp.end();this.stats.texels=texels;}
}
