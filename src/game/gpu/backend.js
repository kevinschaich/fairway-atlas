import {asset} from '../asset.js';
import {splineGrid} from '../ground-contact.js';
import {BUDGET,LOWMEM} from './budget.js';
// Fairway Atlas WebGPU renderer backend.
// Draws the course from the scene database (dist/core) and the world data, with its own passes:
// sky -> meshes (ground mode for terrain/turf) -> compute-scattered grass blades -> water -> post.
import {LEAF_BAKE,LEAF_SIZE,SKY,MESH,HEIGHT,POST,SHADOW,BLOOM,SKYLUT,SKYAMB,TRACER} from './shaders.js';
import {GRASS_CS,GRASS_RS,CHUNK,MAX_BLADES,MAX_NEAR,MAX_MID,MAX_FAR,NEAR_PP_MAX} from './grass.js';
import {mul,invert,perspectiveRZ,frustum,lookAt,ortho} from './mat.js';
import {MAPS} from './maps.js';
import {FRAME,COMMON} from './shaders-common.js';
import {TURF_SHELLS,TURF_RINGS,turfShader} from './turf.js';
import {GpuTimer,GpuMemory} from './timing.js';
import {Terrain} from './terrain.js';
import {fastLoad} from '../fast-load.js';
import {MatCache} from './matcache.js';
import {LIP,lipGeometry,bunkerGeometry} from './lip.js';
// Colour grade targets from 8 Ghost of Tsushima 4K frames (dist/…/ghost-of-tsushima-lighting): mean chroma ~8, L* p5 ~7 / p50 ~32.
import {DEFAULT_KEYS,gradeAt,wbGains,dayPos} from './grade.js';
// Colour grade: keyframed over the time of day (gpu/grade.js); backend.gradeKeys is set by Visual debug > Grade.
import {VOL,VOLCOMP,VOLFILT} from './volumetrics.js';
import {TAA,LUMA} from './taa.js';
import {OCEAN_N,OCEAN_INIT,OCEAN_ROWS,OCEAN_COLS,OCEAN_RS} from './ocean.js';
import {generateMips,mipCount} from './mips.js';
import {placeFlora,pickLocale,LOCALES,fescueField} from './flora.js';
import {FLORA,IMPOSTOR_WGSL} from './flora-shader.js';
import {bakeFoliageAtlas,ATLAS_PX} from './foliage-atlas.js';

const KIND={rough:1,fairway:2,green:3,tee:4,bunker:5,water:6,wood:7,scrub:8,bare_rock:9,sand:10};
// effects whose shading runs inside the terrain pass, as their kill bits (renderer.applyGpuEffects); the timing probe
// measures each one by drawing the terrain once without it
export const GpuProbeBits={surfaceDetail:(1<<6)|(1<<7)|(1<<8)|(1<<10),ao:(1<<1)|(1<<9),shadows:(1<<0)|(1<<2),terrainShadows:1<<3,clouds:1<<4,atmosphere:1<<5};
const SPECIAL={ball:1,cloth:2,divot:3,carbon:4,milled:5,brushed:6,cup:7,grid:8};   // Mat.pad.z in the MESH shader
// grass draw lists: [segments, lit per vertex, count slot]. Count slots: 1 near (per-pixel, within ~4 m), 13 near beyond that
// (per-vertex lit, stored from the top of the near range), 3 mid, 9 far (grass.js scatter)
export const GRASS_SEGS=[[7,false,1],[4,true,13],[2,true,3],[1,true,9]];   // near-pv 4 segs (blades 30-100 px tall, <2.5 px wide), mid 2, far a single tapered triangle: indistinguishable at their size (A/B crops), ~25% fewer vertices
const DRAW_STRIDE=256,MAX_DRAWS=2048,FRAME_SIZE=864,SHADOW_SIZE=BUDGET.shadow;

// Exact Euclidean distance transform (Felzenszwalb–Huttenlocher). Returns distance (texels) from each pixel to the nearest
// pixel whose mask value == target.
function edt(mask,N,target){const INF=1e20,f=new Float64Array(N*N);for(let i=0;i<N*N;i++)f[i]=mask[i]===target?0:INF;
 const d1=(g,n,out)=>{const v=new Int32Array(n),z=new Float64Array(n+1);let k=0;v[0]=0;z[0]=-INF;z[1]=INF;
  for(let q=1;q<n;q++){let s;while(true){const p=v[k];s=((g[q]+q*q)-(g[p]+p*p))/(2*q-2*p);if(s<=z[k]){k--;if(k<0){k=0;break}}else break}k++;v[k]=q;z[k]=s;z[k+1]=INF}
  k=0;for(let q=0;q<n;q++){while(z[k+1]<q)k++;const p=v[k];out[q]=(q-p)*(q-p)+g[p]}};
 const col=new Float64Array(N),res=new Float64Array(N);for(let x=0;x<N;x++){for(let y=0;y<N;y++)col[y]=f[y*N+x];d1(col,N,res);for(let y=0;y<N;y++)f[y*N+x]=res[y]}
 const row=new Float64Array(N);for(let y=0;y<N;y++){for(let x=0;x<N;x++)row[x]=f[y*N+x];d1(row,N,res);for(let x=0;x<N;x++)f[y*N+x]=Math.sqrt(res[x])}return f;}
export class GpuBackend{
 constructor(owner){this.o=owner;this.geo=new WeakMap();this.inst=new WeakMap();this.tex=new Map();this.ready=false;this.stats={};}
 async init(){
  if(!navigator.gpu)throw Error('WebGPU unavailable');
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw Error('No WebGPU adapter');
  this.hasTimestamps=adapter.features.has('timestamp-query');const dev=this.dev=await adapter.requestDevice({requiredFeatures:[...(this.hasTimestamps?['timestamp-query']:[]),...(adapter.features.has('rg11b10ufloat-renderable')?['rg11b10ufloat-renderable']:[])],requiredLimits:{maxSampledTexturesPerShaderStage:Math.min(adapter.limits.maxSampledTexturesPerShaderStage,32),maxStorageBufferBindingSize:Math.min(adapter.limits.maxStorageBufferBindingSize,256<<20),maxBufferSize:Math.min(adapter.limits.maxBufferSize,256<<20)}});this.sceneFmt=dev.features.has('rg11b10ufloat-renderable')&&/[?&]hdr11/.test(location.search)?'rg11b10ufloat':'rgba16float';   /* scene colour: rgba16float (R11G11B10 measured slower on Apple: fp16 targets get lossless compression); ?hdr11 to compare */this.mem=new GpuMemory(dev);
  // every pipeline reports its own creation error with its entry points (an invalid pipeline otherwise only shows up as an
  // anonymous 'Invalid RenderPipeline' on every frame)
  {const cr=dev.createRenderPipeline.bind(dev);dev.createRenderPipeline=desc=>{dev.pushErrorScope('validation');dev.pushErrorScope('internal');const p=cr(desc);Promise.all([dev.popErrorScope(),dev.popErrorScope()]).then(es=>{for(const e of es)if(e){(this.pipeErrors??=[]).push([desc.vertex?.entryPoint,desc.fragment?.entryPoint,e.message.slice(0,600)]);console.error('render pipeline failed:',desc.vertex?.entryPoint,'/',desc.fragment?.entryPoint,desc.label||'',e.message.slice(0,400));}});return p;};}if(this.hasTimestamps)this.timer=new GpuTimer(dev);   /* perf HUD 'Detailed timing' (gpu/timing.js) */
  dev.lost.then(i=>console.error('WebGPU device lost',i.message));this.errors=[];dev.onuncapturederror=e=>{if(this.errors.length<20){this.errors.push(e.error.message);console.error('WebGPU:',e.error.message)}};
  const c=this.canvas=this.o.canvas,host=this.o.container;   // the renderer's canvas (shared across engine hot reloads)
  this.ctx=c.getContext('webgpu');this.format=navigator.gpu.getPreferredCanvasFormat();try{this.hdrOut=localStorage.getItem('fa-hdr')==='1'}catch{}this.configureCanvas();
  this.frameBuf=dev.createBuffer({size:FRAME_SIZE,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.frameData=new Float32Array(FRAME_SIZE/4);this.terrain=new Terrain(dev);this.leafTex=dev.createTexture({label:'turf leaf tile',size:[LEAF_SIZE,LEAF_SIZE,4],format:'rgba8unorm',mipLevelCount:mipCount(LEAF_SIZE,LEAF_SIZE),usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});this.clipData=new Float32Array(32);
  this.drawBuf=dev.createBuffer({size:DRAW_STRIDE*MAX_DRAWS,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.drawData=new Float32Array(DRAW_STRIDE*MAX_DRAWS/4);
  this.linSamp=dev.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',addressModeU:'repeat',addressModeV:'repeat',maxAnisotropy:8});
  this.clampSamp=dev.createSampler({magFilter:'linear',minFilter:'linear'});
  const px=(fmt,data,w=1,h=1)=>{const t=dev.createTexture({size:[w,h],format:fmt,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});dev.queue.writeTexture({texture:t},data,{bytesPerRow:w*(fmt==='r32float'?4:fmt==='r8unorm'?1:4)},[w,h]);return t;};
  this.white=px('rgba8unorm',new Uint8Array([255,255,255,255]));this.base=px('rgba8unorm-srgb',new Uint8Array([90,110,60,255]));this.sat=px('rgba8unorm-srgb',new Uint8Array([90,110,60,255]));
  this.height=px('r32float',new Float32Array([0]));this.kind=px('r8unorm',new Uint8Array([1]));this.heightSize=1;
  // dummy vertex streams for meshes lacking normals/uvs/colors: zero-stride instance-rate trick not allowed, so per-geometry fill
  this.identity=dev.createBuffer({size:64,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});dev.queue.writeBuffer(this.identity,0,new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]));
  this.shadowTex=dev.createTexture({size:[SHADOW_SIZE,SHADOW_SIZE,2],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.cmpSamp=dev.createSampler({compare:'less',magFilter:'linear',minFilter:'linear'});
  this.shadowUBO=[0,1].map(()=>dev.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));
  this.skyLUT=dev.createTexture({size:[192,108],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.skyAmb=dev.createTexture({label:'sky ambient lobes',size:[8,1],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});this.skyLUTBuf=dev.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const st=(n)=>dev.createTexture({size:[n,n],format:'rgba16float',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});this.tshadow=st(2048);this.cloudTex=st(1024);this.relief=dev.createTexture({size:[2048,2048],format:'rgba16float',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});this.black=px('rgba8unorm',new Uint8Array([0,0,0,0]));this.aoTex=st(2048);
  {const P=GpuBackend.prototype,key='noise:'+await fastLoad.hash(P.makeNoise+'|'+P.makeNoiseGrad);const hit=await fastLoad.getDerived(key);   // CPU-generated tiles (~0.8 s): cached
   this.noise=this.makeNoise(hit?.n);this.noiseGrad=this.makeNoiseGrad(hit?.g);if(!hit)fastLoad.putDerived(key,{n:this._noiseData,g:this._noiseGradData});}
  this.buildPipelines();this.buildGrass();this.buildOcean();
  {const m=dev.createShaderModule({code:MAPS});m.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL maps',x.lineNum,x.message)});
   this.mapsBGL=dev.createBindGroupLayout({entries:[{binding:0,visibility:4,storageTexture:{access:'write-only',format:'rgba16float'}},{binding:1,visibility:4,buffer:{type:'uniform'}}]});
   this.mapsPipe=dev.createComputePipeline({layout:dev.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.mapsBGL]}),compute:{module:m,entryPoint:'build'}});
   this.mapsU=[0,1,2,3].map(()=>dev.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));
   this.mapsBG=[[this.tshadow,0],[this.cloudTex,1],[this.relief,2],[this.aoTex,3]].map(([t,i])=>dev.createBindGroup({layout:this.mapsBGL,entries:[{binding:0,resource:t.createView()},{binding:1,resource:{buffer:this.mapsU[i]}}]}));}
  {const m=dev.createShaderModule({code:SKYLUT});m.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL skylut',x.lineNum,x.message)});this.skyLUTPipe=dev.createRenderPipeline({layout:'auto',vertex:{module:m,entryPoint:'vs'},fragment:{module:m,entryPoint:'fs',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}});this.skyLUTBG=dev.createBindGroup({layout:this.skyLUTPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.skyLUTBuf}}]});}
  {const m=dev.createShaderModule({code:SKYAMB});m.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL skyamb',x.lineNum,x.message)});this.skyAmbPipe=dev.createRenderPipeline({layout:'auto',vertex:{module:m,entryPoint:'vs'},fragment:{module:m,entryPoint:'fs',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}});
   this.skyAmbBuf=dev.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.skyAmbBG=dev.createBindGroup({layout:this.skyAmbPipe.getBindGroupLayout(0),entries:[{binding:0,resource:this.skyLUT.createView()},{binding:1,resource:this.linSamp},{binding:2,resource:{buffer:this.skyAmbBuf}}]});}this.ready=true;this.resize();new ResizeObserver(()=>{this._rect=null;this.resize()}).observe(host);
 }
 // gradient of the noise tile per uv unit (central differences, wrapped), 2 layers: (dr, dg), (db, da); mipmapped so a tap
 // at the pixel's footprint is the derivative of the filtered noise (analytic bump normals, e.g. sand grain)
 makeNoiseGrad(cached){const N=512,src=this._noiseData,out=cached||new Uint16Array(N*N*4*2);this._noiseGradData=out;const f=v=>{const b=new Float32Array([v]),i=new Uint32Array(b.buffer)[0],sg=(i>>>16)&0x8000;let e=((i>>>23)&0xff)-112,m=i&0x7fffff;if(e<=0)return sg;if(e>=31)return sg|0x7c00;return sg|(e<<10)|(m>>>13);};
  const at=(x,y,c)=>src[((((y%N)+N)%N)*N+(((x%N)+N)%N))*4+c]/255;
  if(!cached)for(let y=0;y<N;y++)for(let x=0;x<N;x++)for(let c=0;c<4;c++){const gx=(at(x+1,y,c)-at(x-1,y,c))*.5*N,gy=(at(x,y+1,c)-at(x,y-1,c))*.5*N;const L=c>>1,o=L*N*N*4+(y*N+x)*4+(c&1)*2;out[o]=f(gx);out[o+1]=f(gy);}
  const t=this.dev.createTexture({label:'noise gradient',size:[N,N,2],mipLevelCount:mipCount(N,N),format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  this.dev.queue.writeTexture({texture:t},out,{bytesPerRow:N*8,rowsPerImage:N},[N,N,2]);generateMips(this.dev,t,2);return t;}
 makeNoise(cached){const N=512,out=cached||new Uint8Array(N*N*4);if(!cached){const h=(x,y,s)=>{let n=(x*374761393+y*668265263+s*1442695041)|0;n=(n^(n>>>13))*1274126177|0;return((n^(n>>>16))>>>0)/4294967295;};
  const vn=(x,y,p,s)=>{const xi=Math.floor(x),yi=Math.floor(y),fx=x-xi,fy=y-yi,u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy),w=(a,b)=>h(((a%p)+p)%p,((b%p)+p)%p,s);return (w(xi,yi)*(1-u)+w(xi+1,yi)*u)*(1-v)+(w(xi,yi+1)*(1-u)+w(xi+1,yi+1)*u)*v;};
  const fbm=(x,y,s)=>{let a=.5,t=0,p=8,f=1;for(let o=0;o<5;o++){t+=a*vn(x*f,y*f,p*f,s+o);a*=.5;f*=2;}return t/.97;};
  for(let y=0;y<N;y++)for(let x=0;x<N;x++){const u=x/N*8,v=y/N*8,i=(y*N+x)*4;out[i]=fbm(u,v,1)*255;out[i+1]=fbm(u,v,7)*255;out[i+2]=fbm(u,v,13)*255;out[i+3]=vn(x/N*64,y/N*64,64,31)*255;}}
  this._noiseData=out;const t=this.dev.createTexture({size:[N,N],mipLevelCount:mipCount(N,N),format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});this.dev.queue.writeTexture({texture:t},out,{bytesPerRow:N*4},[N,N]);generateMips(this.dev,t);return t;}
 // Read the relief/sink field back once per course so ball physics rolls over the same ground that is drawn.
 async readRelief(key){this.reliefReading=true;try{const d=this.dev,N=2048,bpr=N*8,buf=d.createBuffer({size:bpr*N,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const e=d.createCommandEncoder();e.copyTextureToBuffer({texture:this.relief},{buffer:buf,bytesPerRow:bpr},[N,N]);d.queue.submit([e.finish()]);await buf.mapAsync(GPUMapMode.READ);
  const h=new Uint16Array(buf.getMappedRange()),g=new Float32Array(N*N);const f16=x=>{const s=x>>15,ex=(x>>10)&31,m=x&1023;const v=ex===0?m/1024*2**-14:ex===31?0:(1+m/1024)*2**(ex-15);return s?-v:v;};
  for(let i=0;i<N*N;i++)g[i]=f16(h[i*4+1]);buf.unmap();buf.destroy();
  const box=this.o.terrainBox,w=this.o.world;if(!w||this.reliefKey!==key)return;
  /* same cubic B-spline the shaders use (reliefAt = cubicTex), so CPU ground == drawn ground */w.__relief=(x,z)=>splineGrid(N,box,(a,b)=>g[b*N+a],x,z);this.reliefRead=key;const tg=this.o.terrain?.geometry;if(tg)tg.userData.relief=w.__relief;this.o.onReliefReady?.();}catch(err){console.warn('relief readback',err);}finally{this.reliefReading=false;}}
 buildOcean(){const d=this.dev,N=OCEAN_N,US=GPUTextureUsage;
  const T=(fmt)=>d.createTexture({size:[N,N],format:fmt,usage:US.STORAGE_BINDING|US.TEXTURE_BINDING|US.COPY_SRC});
  const mod=(c,n)=>{const m=d.createShaderModule({code:c});m.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL '+n,x.lineNum,x.message)});return m;};
  const pInit=d.createComputePipeline({layout:'auto',compute:{module:mod(OCEAN_INIT,'ocean-init'),entryPoint:'main'}});
  const pRows=d.createComputePipeline({layout:'auto',compute:{module:mod(OCEAN_ROWS,'ocean-rows'),entryPoint:'main'}});
  const pCols=d.createComputePipeline({layout:'auto',compute:{module:mod(OCEAN_COLS,'ocean-cols'),entryPoint:'main'}});
  // cascade 0: long swell (420 m tile), cascade 1: chop (47 m tile) - disjoint wavenumber bands
  const L=[420,47],kcut=2*Math.PI/47*6;
  this.ocean={L,cascades:L.map((len,i)=>{const u=d.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
   const h0=T('rgba32float'),A=T('rgba32float'),B=T('rgba32float'),disp=T('rgba16float'),slope=T('rgba16float');
   const bg=(p,e)=>d.createBindGroup({layout:p.getBindGroupLayout(0),entries:e.map((r,j)=>({binding:j,resource:r}))});
   return{len,u,kmin:i===0?0:kcut,kmax:i===0?kcut:1e9,seed:11+i*7,
    init:bg(pInit,[{buffer:u},h0.createView()]),rows:bg(pRows,[{buffer:u},h0.createView(),A.createView(),B.createView()]),cols:bg(pCols,[{buffer:u},A.createView(),B.createView(),disp.createView(),slope.createView()]),disp,slope};}),
   pInit,pRows,pCols,ready:false};
  this.oceanU=d.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const rm=mod(OCEAN_RS,'ocean-rs');this.oceanBGL=d.createBindGroupLayout({entries:[0,1,2,3].map(b=>({binding:b,visibility:3,texture:{sampleType:'float'}})).concat([{binding:4,visibility:3,buffer:{type:'uniform'}},{binding:5,visibility:2,texture:{sampleType:'unfilterable-float'}},{binding:6,visibility:2,texture:{sampleType:'unfilterable-float'}}])});
  this.oceanPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.oceanBGL]}),vertex:{module:rm,entryPoint:'vs'},fragment:{module:rm,entryPoint:'fs',targets:[{format:this.sceneFmt}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'greater',depthWriteEnabled:true}});
  // water SSR marches a 1/4-res depth (nearest of each 4x4 block): 1/16 of the texels, so the 28 dependent depth reads per
  // water pixel stay in cache; the reflected colour is still read at full resolution on a hit
  {const m=mod(`@group(0) @binding(0) var dep:texture_depth_2d;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));return vec4f(p*2.-1.,0.,1.);}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{let dm=vec2i(textureDimensions(dep))-1;let b=vec2i(floor(p.xy))*4;var m=0.;
 for(var y=0;y<4;y++){for(var x=0;x<4;x++){m=max(m,textureLoad(dep,min(b+vec2i(x,y),dm),0));}}return vec4f(m,0.,0.,1.);}`,'ssr-depth');
   this.ssrDepthPipe=d.createRenderPipeline({layout:'auto',vertex:{module:m,entryPoint:'vs'},fragment:{module:m,entryPoint:'fs',targets:[{format:'r32float'}]},primitive:{topology:'triangle-list'}});}
  {const m=mod(`@group(0) @binding(0) var src:texture_2d<f32>;@group(0) @binding(1) var sm:sampler;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));return vec4f(p*2.-1.,0.,1.);}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{let d=vec2f(textureDimensions(src));return vec4f(textureSampleLevel(src,sm,floor(p.xy)*2./d+1./d,0.).rgb,1.);}`,'ssr-colour');
   this.ssrColPipe=d.createRenderPipeline({layout:'auto',vertex:{module:m,entryPoint:'vs'},fragment:{module:m,entryPoint:'fs',targets:[{format:this.sceneFmt}]},primitive:{topology:'triangle-list'}});}
  this.oceanBGFor=()=>{if(this.oceanBGKey===this.hdrCopy&&this.oceanBG)return this.oceanBG;this.oceanBGKey=this.hdrCopy;const c=this.ocean.cascades;return this.oceanBG=d.createBindGroup({layout:this.oceanBGL,entries:[c[0].disp,c[0].slope,c[1].disp,c[1].slope].map((t,b)=>({binding:b,resource:t.createView()})).concat([{binding:4,resource:{buffer:this.oceanU}},{binding:5,resource:this.hdrCopy.createView()},{binding:6,resource:this.ssrDepth.createView()}])});};}
 oceanStep(enc,time){const oc=this.ocean,d=this.dev,wv=this.o.world?.wind||{x:.8,z:.35};const wl=Math.hypot(wv.x||.8,wv.z||.35)||1;const dir=[(wv.x||.8)/wl,(wv.z||.35)/wl];
  const wind=9.5,key=dir.map(v=>v.toFixed(2)).join(',');
  for(const c of oc.cascades)d.queue.writeBuffer(c.u,0,new Float32Array([c.len,time,1.1,wind,dir[0],dir[1],c.kmin,c.kmax,.3,c.seed,0,0]));
  const cp=enc.beginComputePass();
  if(oc.key!==key){oc.key=key;cp.setPipeline(oc.pInit);for(const c of oc.cascades){cp.setBindGroup(0,c.init);cp.dispatchWorkgroups(OCEAN_N/8,OCEAN_N/8);}}
  cp.setPipeline(oc.pRows);for(const c of oc.cascades){cp.setBindGroup(0,c.rows);cp.dispatchWorkgroups(OCEAN_N);}
  cp.setPipeline(oc.pCols);for(const c of oc.cascades){cp.setBindGroup(0,c.cols);cp.dispatchWorkgroups(OCEAN_N);}
  cp.end();d.queue.writeBuffer(this.oceanU,0,new Float32Array([oc.L[0],oc.L[1],1,time]));}
 frameLayout(){return this.frameBGL??=this.dev.createBindGroupLayout({entries:[
  {binding:0,visibility:7,buffer:{type:'uniform'}},{binding:1,visibility:7,texture:{sampleType:'float'}},{binding:2,visibility:7,texture:{sampleType:'float'}},
  {binding:3,visibility:7,texture:{sampleType:'unfilterable-float'}},{binding:4,visibility:7,texture:{sampleType:'float'}},{binding:5,visibility:7,sampler:{type:'filtering'}},{binding:6,visibility:7,texture:{sampleType:'depth',viewDimension:'2d-array'}},{binding:7,visibility:7,sampler:{type:'comparison'}},{binding:8,visibility:7,texture:{sampleType:'float'}},{binding:9,visibility:7,texture:{sampleType:'float'}},{binding:10,visibility:7,texture:{sampleType:'float'}},{binding:11,visibility:7,texture:{sampleType:'float'}},{binding:12,visibility:7,texture:{sampleType:'float'}},{binding:13,visibility:7,texture:{sampleType:'float'}},{binding:14,visibility:7,texture:{sampleType:'float'}},{binding:15,visibility:7,texture:{sampleType:'float'}},{binding:16,visibility:7,texture:{sampleType:'unfilterable-float',viewDimension:'2d-array'}},{binding:17,visibility:7,texture:{sampleType:'float',viewDimension:'2d-array'}},{binding:18,visibility:7,texture:{sampleType:'float',viewDimension:'2d-array'}},{binding:19,visibility:7,texture:{sampleType:'float'}},{binding:20,visibility:7,texture:{sampleType:'float',viewDimension:'2d-array'}},{binding:21,visibility:7,texture:{sampleType:'float',viewDimension:'2d-array'}},{binding:22,visibility:7,texture:{sampleType:'float',viewDimension:'2d-array'}}]});}
 frameGroup(forMaps=false,forShadow=false,noRelief=false,noAO=false,noCache=false){const TR=this.terrain;return this.dev.createBindGroup({layout:this.frameLayout(),entries:[{binding:0,resource:{buffer:this.frameBuf}},{binding:1,resource:this.base.createView()},{binding:2,resource:this.sat.createView()},{binding:3,resource:this.height.createView()},{binding:4,resource:this.kind.createView()},{binding:5,resource:this.linSamp},{binding:6,resource:(forShadow?(this.dummyShadow??=this.dev.createTexture({size:[1,1,2],format:'depth32float',usage:GPUTextureUsage.TEXTURE_BINDING})):this.shadowTex).createView({dimension:'2d-array'})},{binding:7,resource:this.cmpSamp},{binding:8,resource:this.skyLUT.createView()},{binding:9,resource:(this.mask||this.white).createView()},{binding:10,resource:(forMaps?this.white:this.tshadow).createView()},{binding:11,resource:(forMaps?this.white:this.cloudTex).createView()},{binding:12,resource:this.noise.createView()},{binding:13,resource:(noRelief?this.black:this.relief).createView()},{binding:14,resource:(noAO||forMaps?this.white:this.aoTex).createView()},{binding:15,resource:(this.maskDetail??this.mask).createView()},{binding:16,resource:(noCache?TR.dummyH:TR.hTex).createView({dimension:'2d-array'})},{binding:17,resource:(noCache?TR.dummyN:TR.nTex).createView({dimension:'2d-array'})},{binding:18,resource:this.leafTex.createView({dimension:'2d-array'})},{binding:19,resource:this.skyAmb.createView()},{binding:20,resource:(noCache||!this.mat?(this.mcDummy??=this.dev.createTexture({size:[1,1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING})):this.mat.aTex).createView({dimension:'2d-array'})},{binding:21,resource:(noCache||!this.mat?this.mcDummy??=this.dev.createTexture({size:[1,1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING}):this.mat.bTex).createView({dimension:'2d-array'})},{binding:22,resource:this.noiseGrad.createView({dimension:'2d-array'})}]});}
 buildPipelines(){const d=this.dev,hdr=this.sceneFmt,depth={format:'depth32float',depthCompare:'greater',depthWriteEnabled:true};
  const mod=code=>{const m=d.createShaderModule({code});m.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL',x.lineNum,x.message)});return m;};
  const fl=this.frameLayout();
  this.skyPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[fl]}),vertex:{module:mod(SKY),entryPoint:'vs'},fragment:{module:mod(SKY),entryPoint:'fs',targets:[{format:hdr}]},primitive:{topology:'triangle-list'},depthStencil:{format:'depth32float',depthCompare:'equal',depthWriteEnabled:false}});
  this.matBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:3,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:128}},{binding:1,visibility:2,texture:{sampleType:'float'}}]});
  const vb=[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]},{arrayStride:12,attributes:[{shaderLocation:1,offset:0,format:'float32x3'}]},{arrayStride:8,attributes:[{shaderLocation:2,offset:0,format:'float32x2'}]},{arrayStride:16,attributes:[{shaderLocation:3,offset:0,format:'float32x4'}]},
   {arrayStride:64,stepMode:'instance',attributes:[0,1,2,3].map(i=>({shaderLocation:4+i,offset:i*16,format:'float32x4'}))}];
  const mm=mod(MESH);
  this.meshPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[fl,this.matBGL]}),vertex:{module:mm,entryPoint:'vs',buffers:vb},fragment:{module:mm,entryPoint:'fs',targets:[{format:hdr}],constants:{GROUND:0}},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:depth});
  // translucent unlit overlays (map layers, overview tiles): straight alpha over the scene, no depth writes
  this.meshPipeBlend=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[fl,this.matBGL]}),vertex:{module:mm,entryPoint:'vs',buffers:vb},fragment:{module:mm,entryPoint:'fs',targets:[{format:hdr,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}],constants:{GROUND:0}},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{...depth,depthWriteEnabled:false}});
  // opaque variant without the alpha-test discard so the GPU keeps early depth rejection for terrain and solids
  {const om=mod(MESH.replace('if(M.params.y>0.&&a<M.params.y){discard;}',''));this.meshPipeOpaque=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[fl,this.matBGL]}),vertex:{module:om,entryPoint:'vs',buffers:vb},fragment:{module:om,entryPoint:'fs',targets:[{format:hdr}],constants:{GROUND:0}},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:depth});
   // CDLOD terrain (gpu/terrain.js): [no bunker-outline discard, with discard, sea floor]
   const tvb=[{arrayStride:8,attributes:[{shaderLocation:0,offset:0,format:'float32x2'}]},{arrayStride:16,stepMode:'instance',attributes:[{shaderLocation:4,offset:0,format:'float32x4'}]}];
   const terrDesc=(k,fx)=>({layout:d.createPipelineLayout({bindGroupLayouts:[fl,this.matBGL]}),vertex:{module:om,entryPoint:'vsT',buffers:tvb},fragment:{module:om,entryPoint:'fs',targets:[{format:hdr}],constants:{CUT:k===1?1:0,SEA:k===2?1:0,FX:fx}},primitive:{topology:'triangle-list',cullMode:this.terrCull||'back'},depthStencil:depth});
   const sandDesc=fx=>({layout:d.createPipelineLayout({bindGroupLayouts:[fl,this.matBGL]}),vertex:{module:om,entryPoint:'vs',buffers:vb},fragment:{module:om,entryPoint:'fs',targets:[{format:hdr}],constants:{FX:fx}},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:depth});
   // the full ground shader takes seconds to compile: every ground pipeline is built in the background, one at a time
   // (a burst of them at start-up has crashed the Metal compiler service); the terrain appears when they are ready
   this.terrPipes=null;   // forward terrain pipelines come per effect set from groundPipesFor (compiling the all-effects
   // uber-shader for a start-up fallback took so long the Metal compiler service kept crashing)
   // ground permutations per effect set, compiled in the background the first time a set is used (the generic pipelines
   // draw meanwhile), then cached for the session
   this.fxPipes=new Map();this.groundPipesFor=mask=>{let e=this.fxPipes.get(mask);if(!e){e={ready:false};this.fxPipes.set(mask,e);
     const A0=(desc)=>(this._cq=(this._cq||Promise.resolve()).catch(()=>{}).then(()=>d.createRenderPipelineAsync(desc)));
     Promise.all([...[0,1,2].map(k=>A0(terrDesc(k,mask))),A0(sandDesc(mask))]).then(p=>{e.terr=p.slice(0,3);e.sand=p[3];e.ready=true;}).catch(err=>{console.warn('ground permutation: retrying',mask,err?.message);setTimeout(()=>this.fxPipes.delete(mask),3000);});
     // deferred terrain passes for this effect set (see render: 'Deferred terrain')
     // compiled one at a time: launching ~20 big compiles at once has crashed the Metal compiler service (XPC interrupted)
     const DL=this.gBGL,A=(desc)=>(this._cq=(this._cq||Promise.resolve()).catch(()=>{}).then(()=>d.createRenderPipelineAsync(desc))),L=(...g)=>d.createPipelineLayout({bindGroupLayouts:g});
     const pre=k=>({layout:L(fl,this.matBGL),vertex:{module:om,entryPoint:'vsT',buffers:tvb},...(k===1?{fragment:{module:om,entryPoint:'fsDepthCut',targets:[],constants:{FX:mask}}}:{}),primitive:{topology:'triangle-list',cullMode:this.terrCull||'back'},depthStencil:depth});
     const gp=k=>({layout:L(fl,this.matBGL),vertex:{module:om,entryPoint:'vsT',buffers:tvb},fragment:{module:om,entryPoint:'fsG',targets:GT3,constants:{CUT:0,SEA:k===2?1:0,FX:mask}},primitive:{topology:'triangle-list',cullMode:this.terrCull||'back'},depthStencil:eq});
     const GT=[{format:'rgba16float'},{format:'rgba16float'}],GT3=[...GT,{format:'rgba8unorm'}],eq={format:'depth32float',depthCompare:'equal',depthWriteEnabled:false},ls={format:'depth32float',depthCompare:'less',depthWriteEnabled:false};
          const full=(entry,targets,bgl)=>({layout:L(fl,this.gEmptyBGL,bgl),vertex:{module:om,entryPoint:'vsFull'},fragment:{module:om,entryPoint:entry,targets,constants:{FX:mask}},primitive:{topology:'triangle-list'},depthStencil:ls});
     const W=GPUColorWrite;
     Promise.all([...[0,1,2].map(k=>A(pre(k))),A({layout:L(fl,this.matBGL),vertex:{module:om,entryPoint:'vs',buffers:vb},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:depth}),
      ...[0,1,2].map(k=>A(gp(k))),A({layout:L(fl,this.matBGL),vertex:{module:om,entryPoint:'vs',buffers:vb},fragment:{module:om,entryPoint:'fsG',targets:GT3,constants:{CUT:0,FX:mask}},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:eq}),
      A(full('fsDetail',GT,DL.full)),A(full('fsLight',[{format:hdr}],DL.full)),A(full('fsFog',[{format:hdr,blend:{color:{operation:'add',srcFactor:'one',dstFactor:'src-alpha'},alpha:{operation:'add',srcFactor:'zero',dstFactor:'one'}}}],DL.full)),
      A({...full('fsShLo',[{format:'rgba16float'}],DL.depth),depthStencil:undefined}),A(full('fsShTerr',[{format:'rgba8unorm',writeMask:W.GREEN}],DL.depth)),A(full('fsShCloud',[{format:'rgba8unorm',writeMask:W.BLUE}],DL.depth)),A({...full('fsAO',[{format:'rgba16float'}],DL.depth),depthStencil:undefined}),A(full('fsDetailLight',[{format:hdr}],DL.full)),...[0,1].map(k=>A({...gp(k),fragment:{module:om,entryPoint:'fsGT',targets:GT3,constants:{FX:mask}}})),A({...full('fsTerrainLit',[{format:hdr}],DL.full),fragment:{module:om,entryPoint:'fsTerrainLit',targets:[{format:hdr}],constants:{FX:mask,DETAIL:(mask&GpuProbeBits.surfaceDetail)!==GpuProbeBits.surfaceDetail?1:0}}}),A({layout:L(fl,this.matBGL,DL.full),vertex:{module:om,entryPoint:'vs',buffers:vb},fragment:{module:om,entryPoint:'fsStripLit',targets:[{format:hdr}],constants:{FX:mask,DETAIL:(mask&GpuProbeBits.surfaceDetail)!==GpuProbeBits.surfaceDetail?1:0}},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:eq}),A({...full('fsTerrainLit',[{format:hdr}],DL.full),fragment:{module:om,entryPoint:'fsTerrainLit',targets:[{format:hdr}],constants:{FX:mask,DETAIL:0}}}),A({layout:L(fl,this.matBGL,DL.full),vertex:{module:om,entryPoint:'vsT',buffers:tvb},fragment:{module:om,entryPoint:'fsTerrainLitM',targets:[{format:hdr}],constants:{FX:mask,DETAIL:(mask&GpuProbeBits.surfaceDetail)!==GpuProbeBits.surfaceDetail?1:0}},primitive:{topology:'triangle-list',cullMode:this.terrCull||'back'},depthStencil:eq})])
      .then(p=>{e.def={pre:p.slice(0,3),preStrip:p[3],g:p.slice(4,7),gStrip:p[7],detail:p[8],light:p[9],fog:p[10],shSun:p[11],shTerr:p[12],shCloud:p[13],ao:p[14],detailLight:p[15],gT:[p[16],p[17],p[6]],terrLit:p[18],stripLit:p[19],terrLitND:p[20],terrLitM:p[21]};}).catch(err=>{console.warn('deferred ground pipelines: retrying',mask,err?.message);setTimeout(()=>this.fxPipes.delete(mask),3000);});}
    return e.ready?e:{terr:null,sand:null,ready:false,def:e.def||null};};
   {const F2=2,tex=(b,t)=>({binding:b,visibility:F2,texture:{sampleType:t}}),mk=e=>d.createBindGroupLayout({entries:e});
    this.gBGL={full:mk([tex(0,'depth'),tex(1,'float'),tex(2,'float'),tex(3,'float'),tex(4,'float'),tex(6,'float'),tex(7,'float')]),depth:mk([tex(0,'depth')]),ao:mk([tex(4,'float')])};this.gEmptyBGL=mk([]);this.gEmptyBG=d.createBindGroup({layout:this.gEmptyBGL,entries:[]});}
   this.terrain.build(fl,mod);this.mat=new MatCache(d);this.mat.build(fl,mod);this.mcData=new Float32Array(32);
   // bake the turf leaf tile once (4 grain directions, 0/45/90/135 deg), then its mips
   {const lm=mod(LEAF_BAKE);const enc=d.createCommandEncoder();for(let k=0;k<4;k++){const pp=d.createRenderPipeline({layout:'auto',vertex:{module:lm,entryPoint:'vs'},fragment:{module:lm,entryPoint:'fs',targets:[{format:'rgba8unorm'}],constants:{ANG:k*Math.PI/4}},primitive:{topology:'triangle-list'}});
    const lp=enc.beginRenderPass({colorAttachments:[{view:this.leafTex.createView({dimension:'2d',baseArrayLayer:k,arrayLayerCount:1,baseMipLevel:0,mipLevelCount:1}),loadOp:'clear',storeOp:'store'}]});lp.setPipeline(pp);lp.draw(3);lp.end();}
    d.queue.submit([enc.finish()]);generateMips(d,this.leafTex,4);}}
  this.heightBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:1,buffer:{type:'uniform'}}]});const hm=mod(HEIGHT);
  this.heightPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.heightBGL]}),vertex:{module:hm,entryPoint:'vs',buffers:[vb[0],vb[4]]},fragment:{module:hm,entryPoint:'fs',targets:[{format:'r32float'}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'less',depthWriteEnabled:true}});
  this.shadowBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:1,buffer:{type:'uniform'}}]});const sm=mod(SHADOW);
  this.shadowPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.shadowBGL]}),vertex:{module:sm,entryPoint:'vs',buffers:[vb[0],vb[4]]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'less',depthWriteEnabled:true,depthBias:2,depthBiasSlopeScale:2.5}});
  this.shadowBG=this.shadowUBO.map(b=>d.createBindGroup({layout:this.shadowBGL,entries:[{binding:0,resource:{buffer:b}}]}));
  {const tm=mod(TRACER);this.tracerBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:3,buffer:{type:'uniform'}}]});
   this.tracerPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[d.createBindGroupLayout({entries:[]}),this.tracerBGL]}),vertex:{module:tm,entryPoint:'vs',buffers:[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]},{arrayStride:12,attributes:[{shaderLocation:1,offset:0,format:'float32x3'}]},{arrayStride:4,attributes:[{shaderLocation:2,offset:0,format:'float32'}]},{arrayStride:4,attributes:[{shaderLocation:3,offset:0,format:'float32'}]}]},
    fragment:{module:tm,entryPoint:'fs',targets:[{format:hdr,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'greater',depthWriteEnabled:false}});
   this.tracerBuf=d.createBuffer({size:160,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.tracerBG=d.createBindGroup({layout:this.tracerBGL,entries:[{binding:0,resource:{buffer:this.tracerBuf}}]});this.emptyBG=d.createBindGroup({layout:this.tracerPipe.getBindGroupLayout(0),entries:[]});}
  const pm=mod(POST);this.postBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:2,texture:{sampleType:'float'}},{binding:1,visibility:2,sampler:{type:'filtering'}},{binding:2,visibility:2,buffer:{type:'uniform'}},{binding:3,visibility:2,texture:{sampleType:'float'}},{binding:5,visibility:2,texture:{sampleType:'float'}},{binding:6,visibility:2,texture:{sampleType:'float'}},{binding:7,visibility:2,texture:{sampleType:'float'}},{binding:8,visibility:2,texture:{sampleType:'depth'}},{binding:9,visibility:2,buffer:{type:'uniform'}}]});
  {const lm=mod(LUMA,'luma');this.lumaBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:2,texture:{sampleType:'float'}},{binding:1,visibility:2,sampler:{type:'filtering'}}]});this.lumaPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.lumaBGL]}),vertex:{module:lm,entryPoint:'vs'},fragment:{module:lm,entryPoint:'fs',targets:[{format:'r16float'}]},primitive:{topology:'triangle-list'}});}
  {this.volBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:2,texture:{sampleType:'depth'}},{binding:1,visibility:2,texture:{sampleType:'float'}},{binding:2,visibility:2,texture:{sampleType:'float'}},{binding:3,visibility:2,buffer:{type:'uniform'}}]});this.volU=d.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});const vm=mod(VOL);vm.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL vol',x.lineNum,x.message)});
   this.volPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.volBGL]}),vertex:{module:vm,entryPoint:'vs'},fragment:{module:vm,entryPoint:'fs',targets:[{format:'rgba16float'},{format:'rgba16float'}]},primitive:{topology:'triangle-list'}});
   {const fm=mod(VOLFILT);this.filtBGL=d.createBindGroupLayout({entries:[0,1].map(b=>({binding:b,visibility:2,texture:{sampleType:'float'}}))});
    this.volFiltPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.filtBGL]}),vertex:{module:fm,entryPoint:'vs'},fragment:{module:fm,entryPoint:'fs',targets:[{format:'rgba16float'},{format:'rgba16float'}]},primitive:{topology:'triangle-list'}});}
   this.compBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:2,texture:{sampleType:'float'}},{binding:1,visibility:2,texture:{sampleType:'float'}},{binding:2,visibility:2,texture:{sampleType:'depth'}},{binding:3,visibility:2,sampler:{type:'filtering'}},{binding:4,visibility:2,buffer:{type:'uniform'}}]});const cm2=mod(VOLCOMP);this.compU=d.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
   this.compPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.compBGL]}),vertex:{module:cm2,entryPoint:'vs'},fragment:{module:cm2,entryPoint:'fs',targets:[{format:this.sceneFmt,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'zero',dstFactor:'one'}}}]},primitive:{topology:'triangle-list'}});
   }
  const bm=mod(BLOOM);this.bloomBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:2,texture:{sampleType:'float'}},{binding:1,visibility:2,sampler:{type:'filtering'}},{binding:2,visibility:2,buffer:{type:'uniform'}},{binding:6,visibility:2,texture:{sampleType:'float'}},{binding:7,visibility:2,texture:{sampleType:'float'}},{binding:9,visibility:2,buffer:{type:'uniform'}}]});
  const bl=d.createPipelineLayout({bindGroupLayouts:[this.bloomBGL]});this.bloomDown=d.createRenderPipeline({layout:bl,vertex:{module:bm,entryPoint:'vs'},fragment:{module:bm,entryPoint:'fs',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}});
  this.bloomUp=d.createRenderPipeline({layout:bl,vertex:{module:bm,entryPoint:'vs'},fragment:{module:bm,entryPoint:'fs',targets:[{format:'rgba16float',blend:{color:{srcFactor:'one',dstFactor:'one'},alpha:{srcFactor:'one',dstFactor:'one'}}}]},primitive:{topology:'triangle-list'}});
  this.postPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.postBGL]}),vertex:{module:pm,entryPoint:'vs'},fragment:{module:pm,entryPoint:'fs',targets:[{format:this.format}]},primitive:{topology:'triangle-list'}});
  this.postPipeHDR=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.postBGL]}),vertex:{module:pm,entryPoint:'vs'},fragment:{module:pm,entryPoint:'fs',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}});
  this.postBuf=d.createBuffer({size:192,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  {const tm=mod(TAA,'taa');this.taaBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:2,texture:{sampleType:'unfilterable-float'}},{binding:1,visibility:2,texture:{sampleType:'depth'}},{binding:2,visibility:2,texture:{sampleType:'float'}},{binding:3,visibility:2,sampler:{type:'filtering'}},{binding:4,visibility:2,buffer:{type:'uniform'}}]});
   this.taaPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.taaBGL]}),vertex:{module:tm,entryPoint:'vs'},fragment:{module:tm,entryPoint:'fs',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}});
   this.taaU=d.createBuffer({size:176,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.taaFrame=0;}
 }
 buildGrass(){const d=this.dev;
  this.blades=d.createBuffer({size:MAX_BLADES*64,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});this.bladeLit=d.createBuffer({label:'grass blade lighting',size:MAX_BLADES*32,usage:GPUBufferUsage.STORAGE});
  this.counter=d.createBuffer({size:64,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
  this.indirect=d.createBuffer({size:160,usage:GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST});
  this.rings=[0,1,2,3].map(()=>d.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));
  const gl=d.createBindGroupLayout({entries:[{binding:0,visibility:4,buffer:{type:'storage'}},{binding:1,visibility:4,buffer:{type:'storage'}},{binding:2,visibility:4,buffer:{type:'uniform'}},{binding:3,visibility:4,buffer:{type:'storage'}}]});
  const cm=d.createShaderModule({code:GRASS_CS});cm.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL grass cs',x.lineNum,x.message)});
  const layout=d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),gl]});
  this.scatterPipe=d.createComputePipeline({layout,compute:{module:cm,entryPoint:'scatter'}});this.finishPipe=d.createComputePipeline({layout,compute:{module:cm,entryPoint:'finish'}});
  this.grassCS=this.rings.map(r=>d.createBindGroup({layout:gl,entries:[{binding:0,resource:{buffer:this.blades}},{binding:1,resource:{buffer:this.counter}},{binding:2,resource:{buffer:r}},{binding:3,resource:{buffer:this.bladeLit}}]}));
  const rl=d.createBindGroupLayout({entries:[{binding:0,visibility:3,buffer:{type:'read-only-storage'}},{binding:1,visibility:3,buffer:{type:'read-only-storage'}},{binding:2,visibility:3,buffer:{type:'read-only-storage'}}]});
  const mk=(seg,pv=false,cnt=-1,rev=false)=>{const ch=cnt>=0;const rm=d.createShaderModule({code:GRASS_RS.replace('const SEG=7u;',`const SEG=${seg}u;`).replace('const CNT=1u;',`const CNT=${Math.max(cnt,1)}u;`).replace('const REV=0u;',`const REV=${rev?1:0}u;`)});rm.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL grass rs',x.lineNum,x.message)});
      return d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),rl]}),vertex:{module:rm,entryPoint:ch?(pv?'vsLitC':'vsC'):(pv?'vsLit':'vs')},fragment:{module:rm,entryPoint:pv?'fsLit':'fs',targets:[{format:this.sceneFmt}]},primitive:{topology:ch?'triangle-list':'triangle-strip',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'greater',depthWriteEnabled:true}});};
  this.buildTurf=(full)=>{this.turfFull=full;this.turfPipes=(full?TURF_RINGS:TURF_RINGS.slice(0,1)).map((ring,i)=>{const tm=d.createShaderModule({code:turfShader(ring,full)});tm.getCompilationInfo().then(inf=>{for(const x of inf.messages)if(x.type==='error')console.error('WGSL turf',i,x.lineNum,x.message)});
   return {n:ring.grid*ring.grid*6,pipe:d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout()]}),vertex:{module:tm,entryPoint:'vs'},fragment:{module:tm,entryPoint:'fs',targets:[{format:this.sceneFmt}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'greater-equal',depthWriteEnabled:true}})}})};
  this.buildTurf(this.turfFullWanted??true);   // high-quality turf everywhere (Visual debug toggle: backend.setTurfFull)
  {const lm=d.createShaderModule({code:LIP});lm.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL lip',x.lineNum,x.message)});
   this.soilBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{}}]});
   this.soilSamp=d.createSampler({addressModeU:'repeat',addressModeV:'repeat',magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',maxAnisotropy:8});
   {const t=d.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});d.queue.writeTexture({texture:t},new Uint8Array([60,55,48,128]),{bytesPerRow:4},[1,1]);this.soilBG=d.createBindGroup({layout:this.soilBGL,entries:[{binding:0,resource:t.createView()},{binding:1,resource:this.soilSamp}]});}
   fetch(asset('textures/soil.png')).then(r=>r.blob()).then(b=>createImageBitmap(b,{premultiplyAlpha:'none',colorSpaceConversion:'none'})).then(bmp=>{const t=this.imageTexture(bmp,false,null);this.soilBG=d.createBindGroup({layout:this.soilBGL,entries:[{binding:0,resource:t.createView()},{binding:1,resource:this.soilSamp}]});}).catch(e=>console.warn('soil texture',e));
   this.lipPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.soilBGL]}),vertex:{module:lm,entryPoint:'vs',buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x2'}]}]},fragment:{module:lm,entryPoint:'fs',targets:[{format:this.sceneFmt}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'greater',depthWriteEnabled:true}});}
  /* three distance lists, each drawn as chunked indexed triangle lists: near 7 segments (per-pixel shading), mid 3 and
     far 1 segment (a single tapered triangle, 3 vertices) lit per vertex */
  this.setGrassSegs=(segs)=>{this.grassSegsNow=segs;this.grassLOD=segs.map(([seg,pv,cnt])=>{const tri=[];for(let b=0;b<CHUNK;b++){const o=b*(2*seg+1);for(let s=0;s<seg;s++){const a=o+2*s;tri.push(a,a+1,a+2);if(s<seg-1)tri.push(a+1,a+3,a+2);}}
   const ib=d.createBuffer({size:tri.length*4,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(ib,0,new Uint32Array(tri));const list=[1,3,9,13].indexOf(cnt);return {pipe:mk(seg,pv,cnt,cnt===13),ib,n:tri.length,list};});this.gKey=null;this.gScat=null;};this.setGrassSegs(this.grassSegs||GRASS_SEGS);this.grassMk=mk;
  this.grassRS=d.createBindGroup({layout:rl,entries:[{binding:0,resource:{buffer:this.blades,offset:0,size:MAX_NEAR*64}},{binding:1,resource:{buffer:this.counter}},{binding:2,resource:{buffer:this.bladeLit,offset:0,size:MAX_NEAR*32}}]});
  this.grassRSFar=d.createBindGroup({layout:rl,entries:[{binding:0,resource:{buffer:this.blades,offset:MAX_NEAR*64,size:MAX_MID*64}},{binding:1,resource:{buffer:this.counter}},{binding:2,resource:{buffer:this.bladeLit,offset:MAX_NEAR*32,size:MAX_MID*32}}]});
  this.grassRSFar2=d.createBindGroup({layout:rl,entries:[{binding:0,resource:{buffer:this.blades,offset:(MAX_NEAR+MAX_MID)*64,size:MAX_FAR*64}},{binding:1,resource:{buffer:this.counter}},{binding:2,resource:{buffer:this.bladeLit,offset:(MAX_NEAR+MAX_MID)*32,size:MAX_FAR*32}}]});
 }
 // dynamic resolution: hold ~45 fps by scaling the internal pixel budget (2.4-6.5 Mpx); the canvas is upscaled by the compositor
 dynRes(now){if(this.fixedRes)return;const t=now??performance.now();if(this._dl!=null){const dt=Math.min(.2,(t-this._dl)/1000);this._fdt=this._fdt==null?dt:this._fdt*.93+dt*.07;}this._dl=t;
  if(!this._dresT)this._dresT=t;if(t-this._dresT<2000||this._fdt==null)return;this._dresT=t;const fps=1/this._fdt;let b=this.pxBudget??BUDGET.pxMax;
  if(fps<40)b=Math.max(BUDGET.pxMin,b*Math.min(.92,Math.pow(fps/45,2)));else if(fps>55)b=Math.min(BUDGET.pxMax,b*1.08);else return;if(Math.abs(b-(this.pxBudget??BUDGET.pxMax))>1e5){this.pxBudget=b;}}
 // HDR output (WebGPU 129+: canvas toneMapping 'extended'): 16-bit float canvas, values above 1.0 light the display above SDR white
 configureCanvas(){const hdr=!!this.hdrOut;try{this.ctx.configure({device:this.dev,format:hdr?'rgba16float':this.format,alphaMode:'opaque',colorSpace:'srgb',toneMapping:{mode:hdr?'extended':'standard'}});}catch(e){console.warn('HDR canvas not supported',e);this.hdrOut=false;this.ctx.configure({device:this.dev,format:this.format,alphaMode:'opaque'});}}
 setHDR(on){this.hdrOut=!!on;this.configureCanvas();}
 resize(){if(!this.ready)return;const r=this._rect??=this.o.container.getBoundingClientRect(),   /* layout read only after the container resized (it forced a ~0.17 ms reflow every frame) */dpr=Math.min(devicePixelRatio||1,Math.sqrt((this.pxBudget??BUDGET.pxMax)/Math.max(1,r.width*r.height)));
  // TAAU: the canvas / post / bloom run at the OUTPUT size (up to 6.5 Mpx); the scene renders at the internal size
  // (pixel budget), and the TAA resolve reconstructs output detail from the jittered history. Without TAA both are equal.
  const taa=!!this.taaOn;const od=Math.min(devicePixelRatio||1,Math.sqrt(BUDGET.pxMax/Math.max(1,r.width*r.height)));
  const ow=taa?Math.max(1,Math.round(r.width*od)):Math.max(1,Math.round(r.width*dpr)),oh=taa?Math.max(1,Math.round(r.height*od)):Math.max(1,Math.round(r.height*dpr));
  const rsc=taa?Math.min(1,Math.max(.5,Math.sqrt((this.pxBudget??BUDGET.pxMax)/(ow*oh)))):1;
  const w=Math.max(1,Math.round(ow*rsc)),h=Math.max(1,Math.round(oh*rsc));
  if(this.w===w&&this.h===h&&this.ow===ow&&this.oh===oh&&this.taaKey===taa)return;this.w=w;this.h=h;this.ow=ow;this.oh=oh;this.taaKey=taa;this.taaReset=true;this.canvas.width=ow;this.canvas.height=oh;
  this.taaTex?.forEach(t=>t.destroy());this.taaTex=null;this.taaOut=null;
  if(taa){const U=GPUTextureUsage;this.taaTex=[0,1].map(()=>this.dev.createTexture({size:[ow,oh],format:'rgba16float',usage:U.RENDER_ATTACHMENT|U.TEXTURE_BINDING}));this.taaOut=this.taaTex[0];this.taaPing=0;}   /* ping-pong: this frame's resolve is next frame's history, no copy */
  this.hdr?.destroy();this.depth?.destroy();this.hdr=this.dev.createTexture({size:[w,h],format:this.sceneFmt,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});this.hdrCopy?.destroy();this.depthCopy?.destroy();this.hdrCopy=this.dev.createTexture({label:'water SSR colour (half res)',size:[Math.ceil(w/2),Math.ceil(h/2)],format:this.sceneFmt,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.ssrColBG=null;this.depthCopy=null;this.ssrDepth?.destroy();this.ssrDepth=this.dev.createTexture({label:'water SSR depth (1/4 res, nearest of 4x4)',size:[Math.ceil(w/4),Math.ceil(h/4)],format:'r32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.ssrDepthBG=null;
  this.depth=this.dev.createTexture({size:[w,h],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
  // deferred terrain G-buffer + term targets (internal size)
  {const U=GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING,T=(f,l)=>this.dev.createTexture({label:'ground '+l,size:[w,h],format:f,usage:U});if(this.gbuf)for(const t of Object.values(this.gbuf))t.destroy();
   this.gbuf={g0a:T('rgba16float','G0'),g1a:T('rgba16float','G1'),g0b:T('rgba16float','G0 detailed'),g1b:T('rgba16float','G1 detailed'),g2:T('rgba8unorm','G2 mask/gain'),vis:T('rgba8unorm','sun visibility'),ao:this.dev.createTexture({label:'ground AO (half res)',size:[Math.ceil(w/2),Math.ceil(h/2)],format:'rgba16float',usage:U})};this.gbuf.shLo=this.dev.createTexture({label:'contact shadow (half res)',size:[Math.ceil(w/2),Math.ceil(h/2)],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.gbufBG=null;}
  {const hw=Math.max(1,w>>2),hh=Math.max(1,h>>2);for(const t of [...(this.volRaysP||[]),...(this.volCloudP||[])])t.destroy();this.volReset=true;this.volRaysF?.destroy();this.volCloudF?.destroy();const U=GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING;
   this.volRaysP=[0,1].map(()=>this.dev.createTexture({size:[hw,hh],format:'rgba16float',usage:U}));this.volCloudP=[0,1].map(()=>this.dev.createTexture({size:[hw,hh],format:'rgba16float',usage:U}));this.volRaysF=this.dev.createTexture({size:[hw,hh],format:'rgba16float',usage:U});this.volCloudF=this.dev.createTexture({size:[hw,hh],format:'rgba16float',usage:U});
   this.filtBGP=[0,1].map(i=>this.dev.createBindGroup({layout:this.filtBGL,entries:[{binding:0,resource:this.volRaysP[i].createView()},{binding:1,resource:this.volCloudP[i].createView()}]}));
   this.volBGP=[0,1].map(i=>this.dev.createBindGroup({layout:this.volBGL,entries:[{binding:0,resource:this.depth.createView()},{binding:1,resource:this.volRaysP[1-i].createView()},{binding:2,resource:this.volCloudP[1-i].createView()},{binding:3,resource:{buffer:this.volU}}]}));
   this.compBG=this.dev.createBindGroup({layout:this.compBGL,entries:[{binding:0,resource:this.volRaysF.createView()},{binding:1,resource:this.volCloudF.createView()},{binding:2,resource:this.depth.createView()},{binding:3,resource:this.clampSamp},{binding:4,resource:{buffer:this.compU}}]});
}
  if(taa){this.taaBGs=[0,1].map(i=>this.dev.createBindGroup({layout:this.taaBGL,entries:[{binding:0,resource:this.hdr.createView()},{binding:1,resource:this.depth.createView()},{binding:2,resource:this.taaTex[1-i].createView()},{binding:3,resource:this.clampSamp},{binding:4,resource:{buffer:this.taaU}}]}));}
  // post + first bloom step read this frame's resolve target: two variants when ping-ponging
  const srcV=(i=0)=>taa?this.taaTex[i].createView():this.hdr.createView();
  {const w=ow,h=oh;
  // bloom chain starts at 1/4 res (was 1/2): glare is a wide, soft lobe, and the first downsample + last upsample at half res were
  // most of its cost at 6.5 Mpx. One level fewer keeps the same coarsest (1/64) blur radius.
  const L=4;this.bloomTex?.destroy();this.bloomTex=this.dev.createTexture({size:[Math.max(1,w>>2),Math.max(1,h>>2)],mipLevelCount:L,format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
  this.bloomSteps=[];const ub=(x,y,mode,k)=>{const b=this.dev.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.dev.queue.writeBuffer(b,0,new Float32Array([x,y,mode,k]));return b;};
  const lv=i=>this.bloomTex.createView({baseMipLevel:i,mipLevelCount:1});const size=i=>[Math.max(1,(w>>2)>>i),Math.max(1,(h>>2)>>i)];
  for(let i=0;i<L;i++){const src=i===0?srcV():lv(i-1),ss=i===0?[w,h]:size(i-1);const mk=sv=>this.dev.createBindGroup({layout:this.bloomBGL,entries:[{binding:0,resource:sv},{binding:1,resource:this.clampSamp},{binding:2,resource:{buffer:ub(1/ss[0],1/ss[1],i===0?0:1,1)}},{binding:6,resource:this.volRaysF.createView()},{binding:7,resource:this.volCloudF.createView()},{binding:9,resource:{buffer:this.compU}}]});this.bloomSteps.push({pipe:this.bloomDown,target:lv(i),load:'clear',bg:mk(src),bg1:i===0&&taa?mk(srcV(1)):null});}
  for(let i=L-1;i>0;i--){const ss=size(i);this.bloomSteps.push({pipe:this.bloomUp,target:lv(i-1),load:'load',bg:this.dev.createBindGroup({layout:this.bloomBGL,entries:[{binding:0,resource:lv(i)},{binding:1,resource:this.clampSamp},{binding:2,resource:{buffer:ub(1/ss[0],1/ss[1],2,1)}},{binding:6,resource:this.volRaysF.createView()},{binding:7,resource:this.volCloudF.createView()},{binding:9,resource:{buffer:this.compU}}]})});}
  this.lumTex?.destroy();this.lumTex=this.dev.createTexture({size:[Math.max(1,Math.ceil(w/16)),Math.max(1,Math.ceil(h/16))],format:'r16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
  const lg=sv=>this.dev.createBindGroup({layout:this.lumaBGL,entries:[{binding:0,resource:sv},{binding:1,resource:this.clampSamp}]});this.lumaBG=lg(srcV(0));this.lumaBG1=taa?lg(srcV(1)):null;
  const pg=sv=>this.dev.createBindGroup({layout:this.postBGL,entries:[{binding:0,resource:sv},{binding:1,resource:this.clampSamp},{binding:2,resource:{buffer:this.postBuf}},{binding:3,resource:lv(0)},{binding:5,resource:this.lumTex.createView()},{binding:6,resource:this.volRaysF.createView()},{binding:7,resource:this.volCloudF.createView()},{binding:8,resource:this.depth.createView()},{binding:9,resource:{buffer:this.compU}}]});this.postGroup=pg(srcV(0));this.postGroup1=taa?pg(srcV(1)):null;}}
 // ------------------------------------------------------------------ world resources
 syncWorld(){const o=this.o,w=o.world;if(!w||!o.terrainBox)return;
  const box=o.terrainBox,key=[box.x,box.z,box.size,o.generation].join('|');
  const baseImg=o.terrain?.material?.map?.image;
  const baseVer=o.terrain?.material?.map?.version;if(baseImg&&(this.baseSrc!==baseImg||this.baseVer!==baseVer)){this.baseSrc=baseImg;this.baseVer=baseVer;this.base=this.imageTexture(baseImg,true,this.base);this.frameBG=null;}
  if(this.worldKey!==key){this.worldKey=key;this.paintKinds();{this.strip=null;this.bunkerRibbon=null;const bx=this.sdfInfo?.box;if(bx){const bg=bunkerGeometry(w,bx);if(bg.sand.count){const mk=(arr)=>{const b=this.dev.createBuffer({size:arr.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});this.dev.queue.writeBuffer(b,0,arr);return b;};
   const es=bg.sand;this.strip={pos:mk(es.pos),nrm:mk(es.nrm),uv:mk(es.uv),col:mk(es.col),inst:mk(new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])),count:es.count};}this.bunkerRibbon=bg.ribbon;this.terrain.setBunkers(bg.sand.count?bg.sand.pos:null,this.maskBox);}else this.terrain.setBunkers(null);}
  {const g0=lipGeometry(w,this.sdfInfo),rb=this.bunkerRibbon;const g=rb&&rb.length?(()=>{const o=new Float32Array(g0.length+rb.length);o.set(g0);o.set(rb,g0.length);return o})():g0;this.lipCount=g.length/6;if(g.length){this.lipBuf=this.dev.createBuffer({size:g.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});this.dev.queue.writeBuffer(this.lipBuf,0,g);}}this.loadSatellite();this.heightDirty=true;this.frameBG=null;}
  const groundCount=this.groundMeshes().length;if(groundCount!==this.groundCount){this.groundCount=groundCount;this.heightDirty=true;}
 }
 groundMeshes(){const out=[];this.o.group?.traverse(m=>{if(m.isMesh&&m.material?.kind==='ground'&&m.geometry?.attributes?.position)out.push(m)});return out;}
 imageTexture(img,srgb,old,mips=true){const d=this.dev;{const k=BUDGET.maxImage/Math.max(img.width,img.height);if(k<1&&!img.data){const c=new OffscreenCanvas(Math.max(1,Math.round(img.width*k)),Math.max(1,Math.round(img.height*k)));c.getContext('2d').drawImage(img,0,0,c.width,c.height);img=c;}}   /* LOWMEM: cap aerial/base-map textures */const w=img.width,h=img.height;const t=d.createTexture({size:[w,h],mipLevelCount:mips?mipCount(w,h):1,format:srgb?'rgba8unorm-srgb':'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  if(img.data&&!(img instanceof ImageBitmap)&&!(img instanceof HTMLCanvasElement)){let data=img.data;if(!(data instanceof Uint8Array||data instanceof Uint8ClampedArray)){const f=data,b=new Uint8Array(w*h*4);const ch=f.length/(w*h);for(let i=0;i<w*h;i++)for(let c=0;c<4;c++)b[i*4+c]=c<ch?Math.max(0,Math.min(255,f[i*ch+c]*255)):255;data=b;}else if(data.length===w*h*3){const b=new Uint8Array(w*h*4);for(let i=0;i<w*h;i++){b[i*4]=data[i*3];b[i*4+1]=data[i*3+1];b[i*4+2]=data[i*3+2];b[i*4+3]=255;}data=b;}d.queue.writeTexture({texture:t},data,{bytesPerRow:w*4},[w,h]);}
  else d.queue.copyExternalImageToTexture({source:img},{texture:t},[w,h]);
  if(mips&&t.mipLevelCount>1)generateMips(d,t);if(old&&old!==this.white)setTimeout(()=>old.destroy(),500);return t;}
 paintKinds(){this.paintMask();const o=this.o,w=o.world,box=o.terrainBox,N=2048,c=new OffscreenCanvas(N,N),g=c.getContext('2d',{willReadFrequently:true});const sc=N/box.size;
  g.fillStyle='rgb(1,1,1)';g.fillRect(0,0,N,N);g.setTransform(sc,0,0,sc,-box.x*sc,-box.z*sc);
  for(const kind of ['wood','scrub','bare_rock','sand','rough','fairway','bunker','tee','green','water'])for(const f of w.features.filter(f=>f.kind===kind&&f.closed)){const v=KIND[kind];g.beginPath();f.points.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();for(const ring of f.innerPoints||[]){ring.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();}g.fillStyle=`rgb(${v},${v},${v})`;g.fill('evenodd');}
  const src=g.getImageData(0,0,N,N).data,r=new Uint8Array(N*N);for(let i=0;i<N*N;i++)r[i]=src[i*4];this.terrain.setWater(r,N,box,KIND.water);

   // rough -> fescue (kind 8) where the native-grass field wins
  const t=this.dev.createTexture({size:[N,N],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});this.dev.queue.writeTexture({texture:t},r,{bytesPerRow:N},[N,N]);this.kind=t;this.frameBG=null;this.upgradeKinds(r,N,box,sc,t);}
 // rough -> native fescue (kind 8): ~1 s of CPU (fescue field + two distance transforms), so it comes from the derived cache when
 // it can. Frames before it lands draw plain rough; then the kind texture is rewritten and the mask-dependent maps rebuild.
 async upgradeKinds(r,N,box,sc,t){const w=this.o.world,wk=this.worldKey,P=GpuBackend.prototype;
  const feat=JSON.stringify(w.features.filter(f=>f.closed).map(f=>[f.kind,f.points,f.innerPoints||0]));
  const key='fescue:'+await fastLoad.hash([P.paintKinds,P.fescueKinds,fescueField,edt,JSON.stringify(KIND),box.x,box.z,box.size,N,this.floraLocale(),feat].join('|'));
  const hit=await fastLoad.getDerived(key);if(wk!==this.worldKey||this.kind!==t)return;
  if(hit){const f=hit.f;for(let i=0;i<f.length;i++)if(f[i]&&r[i]===1)r[i]=8;this.fescueStats=hit.stats;this._kindCPU=r;}   /* only the rough->fescue decision is cached; the polygon raster is this run's */
  else{const r0=r.slice();this.fescueKinds(r,N,box,sc);const f=new Uint8Array(r.length);for(let i=0;i<r.length;i++)f[i]=r[i]!==r0[i]?1:0;fastLoad.putDerived(key,{f,stats:this.fescueStats});}
  this.dev.queue.writeTexture({texture:t},r,{bytesPerRow:N},[N,N]);this.maskStamp=(this.maskStamp||0)+1;this.frameBG=null;}
 fescueKinds(r,N,box,sc){const w=this.o.world;
  {/* unmapped = outside every mapped polygon; a separate white-on-black coverage pass, because anti-aliased edges in the kind
    canvas would blend a marker value into other kind codes */
   const c2=new OffscreenCanvas(N,N),g2=c2.getContext('2d',{willReadFrequently:true});g2.fillStyle='#000';g2.fillRect(0,0,N,N);g2.setTransform(sc,0,0,sc,-box.x*sc,-box.z*sc);g2.fillStyle='#fff';
   for(const f of w.features)if(f.closed&&f.kind!=='building'&&KIND[f.kind]){g2.beginPath();f.points.forEach((p,i)=>i?g2.lineTo(p[0],p[1]):g2.moveTo(p[0],p[1]));g2.closePath();g2.fill();}
   const cd=g2.getImageData(0,0,N,N).data,um=new Uint8Array(N*N);for(let i=0;i<N*N;i++)um[i]=cd[i*4]<128?1:0;const fes=fescueField(w,box,N,this.floraLocale(),um);/* keep native grass well clear of every mown surface (tee, fairway, green): exact distance to their mapped edges, 8-16 m wobbling */
   const mown=new Uint8Array(N*N),fw=new Uint8Array(N*N);for(let i=0;i<N*N;i++){mown[i]=(r[i]===3||r[i]===4)?1:0;fw[i]=r[i]===2?1:0;}const md=edt(mown,N,1),fd=edt(fw,N,1),px=box.size/N;
   let nf=0,nu=0;for(let i=0;i<N*N;i++){if(um[i])nu++;if(r[i]!==1||fes[i]<=.5)continue;const x=i%N,y=(i/N)|0;const buf=8+8*(.5+.5*Math.sin(x*.021+y*.013)*Math.cos(x*.011-y*.017));if(md[i]*px<buf||fd[i]*px<buf*.35)continue;   /* tees/greens keep a wide mown collar; along fairways the native bank can come within a few metres */r[i]=8;nf++;}this._kindCPU=r;this._mownDist=md;this.fescueStats={fescuePx:nf,unmappedPx:nu,m2PerPx:(box.size/N)**2};}}
 maskData(box,N,sdf=false){const o=this.o,w=o.world,c=new OffscreenCanvas(N,N),g=c.getContext('2d');const sc=N/box.size;g.fillStyle='#000';g.fillRect(0,0,N,N);g.setTransform(sc,0,0,sc,-box.x*sc,-box.z*sc);  // opaque base: on a transparent canvas edge coverage lives only in alpha and RGB reads back as hard 0/255 steps
  const draw=(kinds,style,op='source-over')=>{g.globalCompositeOperation=op;g.fillStyle=style;for(const f of w.features.filter(f=>kinds.includes(f.kind)&&f.closed)){g.beginPath();f.points.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();for(const ring of f.innerPoints||[]){ring.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();}g.fill('evenodd');}};
  // channels are painted separately with 'lighter' so they don't overwrite each other
  draw(['fairway','tee','green'],'rgba(255,0,0,1)','lighter');draw(['bunker','sand'],'rgba(0,255,0,1)','lighter');draw(['water'],'rgba(0,0,255,1)','lighter');
  const img=g.getImageData(0,0,N,N).data;const gc=new OffscreenCanvas(N,N).getContext('2d');gc.setTransform(sc,0,0,sc,-box.x*sc,-box.z*sc);gc.fillStyle='#fff';
  for(const f of w.features.filter(f=>f.kind==='green'&&f.closed)){gc.beginPath();f.points.forEach((p,i)=>i?gc.lineTo(p[0],p[1]):gc.moveTo(p[0],p[1]));gc.closePath();gc.fill('evenodd');}
  const gi=gc.getImageData(0,0,N,N).data;
  // fringe/collar: a 2 ft (0.61 m) band outside every green, stroked straight from the polygon (no dither/noise)
  const fc=new OffscreenCanvas(N,N).getContext('2d');fc.setTransform(sc,0,0,sc,-box.x*sc,-box.z*sc);fc.strokeStyle='#fff';fc.lineWidth=1.22;fc.lineJoin='round';
  for(const f of w.features.filter(f=>f.kind==='green'&&f.closed)){fc.beginPath();f.points.forEach((p,i)=>i?fc.lineTo(p[0],p[1]):fc.moveTo(p[0],p[1]));fc.closePath();fc.stroke();}
  const fi=fc.getImageData(0,0,N,N).data;
  // alpha: 1 = green, .5 = fringe, 0 = neither;  fringe also counts as short turf (R) unless it is sand/water
  const out=new Uint8Array(N*N*4);for(let i=0;i<N*N;i++){const gr=gi[i*4+3]/255,fr=fi[i*4+3]/255,sd=Math.max(img[i*4+1],img[i*4+2])/255;const fe=fr*(1-gr)*(1-sd);
   out[i*4]=Math.max(img[i*4],Math.round(fe*255));out[i*4+1]=img[i*4+1];out[i*4+2]=img[i*4+2];out[i*4+3]=Math.round((gr+fe*.5)*255);}
  if(sdf){// bunker edge as an exact signed distance (±R m around the sand line), measured to the polygon segments themselves
   // (not to a thresholded raster, whose half-texel steps made the lip stair-step), so shaders and the lip wall share one edge.
   // OSM outlines are polygons with sharp corners; a raked bunker edge is a smooth curve. Round them (Chaikin, 3 passes) so the
   // edge strip / wall never meets a cusp (where rows can't fan out and the lip would notch).
   const chaikin=r=>{let q=r;for(let it=0;it<3;it++){const o2=[];for(let i=0;i<q.length;i++){const a=q[i],b=q[(i+1)%q.length];o2.push([a[0]*.75+b[0]*.25,a[1]*.75+b[1]*.25],[a[0]*.25+b[0]*.75,a[1]*.25+b[1]*.75]);}q=o2;}return q;};
   const bunkers=w.features.filter(f=>(f.kind==='bunker'||f.kind==='sand')&&f.closed).map(f=>[f.points,...(f.innerPoints||[])].filter(r=>r.length>2).map(chaikin));
   const sc2=new OffscreenCanvas(N,N).getContext('2d');sc2.setTransform(sc,0,0,sc,-box.x*sc,-box.z*sc);sc2.fillStyle='#fff';
   for(const rings of bunkers){sc2.beginPath();for(const r of rings){r.forEach((p,i)=>i?sc2.lineTo(p[0],p[1]):sc2.moveTo(p[0],p[1]));sc2.closePath();}sc2.fill('evenodd');}
   const inS=sc2.getImageData(0,0,N,N).data;
   const R=.6,mpp=box.size/N,sdA=new Float32Array(N*N);for(let i=0;i<N*N;i++)sdA[i]=inS[i*4+3]>127?R:-R;
   const Rp=Math.ceil(R/mpp)+1;
   const fid=new Int32Array(N*N).fill(-1);bunkers.forEach((rings,fi)=>{for(const ring of rings)for(let s=0;s<ring.length;s++){
    const a=ring[s],c=ring[(s+1)%ring.length];const ax=(a[0]-box.x)/mpp-.5,az=(a[1]-box.z)/mpp-.5,cx=(c[0]-box.x)/mpp-.5,cz=(c[1]-box.z)/mpp-.5;
    const x0=Math.max(0,Math.floor(Math.min(ax,cx))-Rp),x1=Math.min(N-1,Math.ceil(Math.max(ax,cx))+Rp),z0=Math.max(0,Math.floor(Math.min(az,cz))-Rp),z1=Math.min(N-1,Math.ceil(Math.max(az,cz))+Rp);
    if(x0>x1||z0>z1)continue;const dx=cx-ax,dz=cz-az,L2=dx*dx+dz*dz||1e-9;
    for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++){let t=((x-ax)*dx+(z-az)*dz)/L2;t=t<0?0:t>1?1:t;const ex=x-(ax+dx*t),ez=z-(az+dz*t);const d=Math.sqrt(ex*ex+ez*ez)*mpp;
     const k=z*N+x;if(d<Math.abs(sdA[k])){sdA[k]=(inS[k*4+3]>127?1:-1)*d;fid[k]=fi;}}}});
   // the raster's inside/outside is only half-texel accurate: right at the edge redo the sign with an exact point-in-polygon test
   // against the nearest bunker, so the zero line has no one-texel dents
   {const pip=(rings,x,z)=>{let c=false;for(const r of rings)for(let i=0,j=r.length-1;i<r.length;j=i++){const [xi,zi]=r[i],[xj,zj]=r[j];if((zi>z)!==(zj>z)&&x<(xj-xi)*(z-zi)/(zj-zi)+xi)c=!c;}return c;};
    for(let k=0;k<N*N;k++){if(fid[k]<0||Math.abs(sdA[k])>1.5*mpp)continue;const x=box.x+((k%N)+.5)*mpp,z=box.z+(Math.floor(k/N)+.5)*mpp;sdA[k]=(pip(bunkers[fid[k]],x,z)?1:-1)*Math.abs(sdA[k]);}}
   for(let i=0;i<N*N;i++)out[i*4+1]=Math.round(Math.min(1,Math.max(0,.5+sdA[i]/(2*R)))*255);this.sdfInfo={box:{...box},N,sd:sdA,mpp};}
  return out;}
 paintMask(){this.maskStamp=(this.maskStamp||0)+1;const o=this.o,w=o.world,box=o.terrainBox,d=this.dev;
  const up=(data,N,old)=>{const t=d.createTexture({size:[N,N],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});d.queue.writeTexture({texture:t},data,{bytesPerRow:N*4},[N,N]);old?.destroy?.();return t};
  this.mask=up(this.maskData(box,BUDGET.mask),BUDGET.mask,this.mask);
  // Detail mask: the whole course at 4096² is ~0.57 m/texel, so edges round off and thin bunker fingers vanish.
  // A second 2048² mask over the current hole (+margin) gives ~0.1–0.2 m/texel where the player actually looks.
  const t=w.tee||{x:0,z:0},p=w.pin||t,cx=(t.x+p.x)/2,cz=(t.z+p.z)/2,size0=Math.min(420,Math.max(160,Math.hypot(p.x-t.x,p.z-t.z)+160));
  // A bunker is either wholly new-engine (sand mesh, turf cut, no sink) or wholly old-engine. The shader decides per pixel
  // (inside the box's 7% margin = new) and bunkersInBox per outline, so a trap straddling the margin line got neither: its
  // inner half lost the turf with no sand under it (a black pit) and a sink wall ran along the margin. Grow the box until
  // every bunker that reaches into the new-engine region lies wholly inside it.
  let size=size0;{const bk=w.features.filter(f=>(f.kind==='bunker'||f.kind==='sand')&&f.closed&&f.points?.length>2);
   for(let it=0;it<6;it++){const m=size*.08,x0=cx-size/2+m,x1=cx+size/2-m,z0=cz-size/2+m,z1=cz+size/2-m;let need=size;
    for(const f of bk){if(!f.points.some(q=>q[0]>x0&&q[0]<x1&&q[1]>z0&&q[1]<z1))continue;
     for(const q of f.points){need=Math.max(need,(Math.abs(q[0]-cx)+.5)/(.5-.08),(Math.abs(q[1]-cz)+.5)/(.5-.08));}}
    if(need<=size+1e-3)break;size=Math.min(640,need+2);}}
  this.maskBox=[cx-size/2,cz-size/2,size];this.maskDetail=up(this.maskData({x:cx-size/2,z:cz-size/2,size},BUDGET.maskDetail,true),BUDGET.maskDetail,this.maskDetail);this.frameBG=null;}
 async loadSatellite(){const o=this.o,w=o.world,box=o.terrainBox,key=this.worldKey;this.satReady=0;
  try{const N=4000,sw=w.toGeo({x:box.x,z:box.z+box.size}),ne=w.toGeo({x:box.x+box.size,z:box.z});
   const url='https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?'+new URLSearchParams({bbox:[...sw,...ne].join(','),bboxSR:'4326',imageSR:'4326',size:`${N},${N}`,format:'jpg',f:'image',adjustAspectRatio:'false'});
   const res=await fetch(url,{mode:'cors',credentials:'omit'});if(!res.ok)throw Error('NAIP '+res.status);const bmp=await createImageBitmap(await res.blob());if(key!==this.worldKey)return;
   this.sat=this.imageTexture(bmp,true,this.sat);this.satBox=[box.x,box.z,box.size];this.satReady=1;this.satFade=0;this.frameBG=null;}catch(e){console.warn('GPU satellite:',e.message)}}
 bakeHeight(){const d=this.dev,box=this.o.terrainBox,N=BUDGET.heightBake(box.size),meshes=this.groundMeshes();if(!meshes.length)return;
  const reuse=this.heightSize===N&&this.heightOwned;const tex=reuse?this.height:d.createTexture({size:[N,N],format:'r32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
  if(!this.heightDepth||this.heightDepth.width!==N){this.heightDepth?.destroy();this.heightDepth=d.createTexture({size:[N,N],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT});}const dep=this.heightDepth;
  const u=d.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(u,0,new Float32Array([box.x,box.z,box.size,0]));
  const enc=d.createCommandEncoder(),pass=enc.beginRenderPass({colorAttachments:[{view:tex.createView(),clearValue:[-50,0,0,0],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:dep.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'discard'}});
  pass.setPipeline(this.heightPipe);pass.setBindGroup(0,d.createBindGroup({layout:this.heightBGL,entries:[{binding:0,resource:{buffer:u}}]}));
  /* full-height ground in world units: the build-time 'rise' is applied when drawing (terrain vertex scale), not baked */
  this.identInst??=(()=>{const b=d.createBuffer({size:64,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(b,0,new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]));return b})();
  for(const m of meshes){const g=this.geometry(m.geometry);if(!g)continue;pass.setVertexBuffer(0,g.pos);pass.setVertexBuffer(1,this.identInst);if(g.index){pass.setIndexBuffer(g.index,g.indexFormat);pass.drawIndexed(g.count,1);}else pass.draw(g.count,1);}
  pass.end();d.queue.submit([enc.finish()]);if(!reuse){const old=this.height;this.height=tex;this.heightSize=N;this.heightOwned=true;this.frameBG=null;if(old)setTimeout(()=>old.destroy(),500);}this.heightDirty=false;this.heightStamp=(this.heightStamp||0)+1;}
 // ------------------------------------------------------------------ scene graph → GPU
 // GPU buffers for a scene geometry, rebuilt only when its attribute/index versions change; freed on geometry.dispose()
 geometry(geo){let g=this.geo.get(geo);const pos=geo.attributes.position;if(!pos)return null;const iv=geo.index?geo.index.version:-1;
  if(g&&g.pv===pos.version&&g.iv===iv&&g.n===pos.count)return g;g?.destroy?.();const d=this.dev,n=pos.count;
  const read=(attr,size,fill)=>{if(attr&&attr.itemSize===size&&attr.array instanceof Float32Array)return attr.array;const out=new Float32Array(n*size);if(fill)out.fill(fill);if(!attr)return out;const s=attr.itemSize,a=attr.array;for(let i=0;i<n;i++)for(let c=0;c<size;c++)out[i*size+c]=c<s?a[i*s+c]:1;return out;};
  const buf=(arr,usage)=>{if(arr.byteLength&3){const p=new Uint8Array((arr.byteLength+3)&~3);p.set(new Uint8Array(arr.buffer,arr.byteOffset,arr.byteLength));arr=p;}   // odd uint16 index counts: pad to 4 bytes
   const b=d.createBuffer({size:Math.max(16,arr.byteLength),usage:usage|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(b,0,arr.buffer,arr.byteOffset,arr.byteLength);return b;};
  let N=geo.attributes.normal?read(geo.attributes.normal,3):null;if(!N){N=new Float32Array(n*3);for(let i=0;i<n;i++)N[i*3+1]=1;}
  const ca=geo.attributes.color,col=ca?read(ca,4):null;
  g={pv:pos.version,iv,n,pos:buf(read(pos,3),GPUBufferUsage.VERTEX),nrm:buf(N,GPUBufferUsage.VERTEX),uv:buf(read(geo.attributes.uv,2),GPUBufferUsage.VERTEX),col:buf(col||new Float32Array(n*4).fill(1),GPUBufferUsage.VERTEX),count:n,hasColor:!!col};
  if(geo.index){const a=geo.index.array;const big=a instanceof Uint32Array||n>65535;const arr=big?(a instanceof Uint32Array?a:Uint32Array.from(a)):(a instanceof Uint16Array?a:Uint16Array.from(a));g.index=buf(arr,GPUBufferUsage.INDEX);g.indexFormat=big?'uint32':'uint16';g.count=geo.drawRange&&geo.drawRange.count!==Infinity?Math.min(geo.drawRange.count,arr.length):arr.length;}
  g.destroy=()=>{for(const k of ['pos','nrm','uv','col','index'])g[k]?.destroy();};
  if(!this.geo.has(geo))geo.onDispose?.(()=>{this.geo.get(geo)?.destroy();this.geo.delete(geo);});this.geo.set(geo,g);return g;}
 // per-node instance transforms, re-uploaded only when the node's world matrix (worldVersion) or instance set changed
 instances(m){let r=this.inst.get(m);const iv=m.isInstancedMesh?m.instanceMatrix.version:0,count=m.isInstancedMesh?m.count:1;
  if(r&&r.wv===m.worldVersion&&r.iv===iv&&r.count===count)return r.buf;const e=m.matrixWorld.elements,data=new Float32Array(Math.max(1,count)*16);
  if(m.isInstancedMesh){const im=m.instanceMatrix.array;for(let i=0;i<count;i++)mul(e,im.subarray(i*16,i*16+16),data.subarray(i*16,i*16+16));}else data.set(e);
  if(!r||r.cap<data.byteLength){r?.buf.destroy();r={buf:this.dev.createBuffer({size:data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),cap:data.byteLength};}
  this.dev.queue.writeBuffer(r.buf,0,data);r.wv=m.worldVersion;r.iv=iv;r.count=count;this.inst.set(m,r);return r.buf;}
 texture(t){if(!t?.image)return null;let e=this.tex.get(t.id);if(e&&e.ver===t.version)return e.tex;const img=t.image;if(!img.width||!img.height)return null;
  try{const tex=this.imageTexture(img,t.colorSpace==='srgb',null);e?.tex.destroy();this.tex.set(t.id,{ver:t.version,tex});if(!e)t.onDispose??=()=>{this.tex.get(t.id)?.tex.destroy();this.tex.delete(t.id);};return tex;}catch(err){return null}}
 // ------------------------------------------------------------------ flora / fauna (native; replaces the mirrored three.js woodland)
 buildFloraPipes(){const d=this.dev,m=d.createShaderModule({code:FLORA});
  {const pm=d.createShaderModule({code:FRAME+COMMON+'@group(1) @binding(0) var<storage,read_write> inst:array<vec4f>;@group(1) @binding(1) var<uniform> PC:vec4u;\n@compute @workgroup_size(64) fn plant(@builtin(global_invocation_id) id:vec3u){if(id.x>=PC.x){return;}var a=inst[id.x*2u];a.y=groundH(a.xz)+a.y;inst[id.x*2u]=a;}'});
   pm.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL plant',x.lineNum,x.message)});
   this.plantBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:4,buffer:{type:'storage'}},{binding:1,visibility:4,buffer:{type:'uniform'}}]});
   this.plantPipe=d.createComputePipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.plantBGL]}),compute:{module:pm,entryPoint:'plant'}});}m.getCompilationInfo().then(i=>{for(const x of i.messages)if(x.type==='error')console.error('WGSL flora',x.lineNum,x.message)});
  const vb=[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]},{arrayStride:12,attributes:[{shaderLocation:1,offset:0,format:'float32x3'}]},{arrayStride:16,attributes:[{shaderLocation:2,offset:0,format:'float32x4'}]},{arrayStride:8,attributes:[{shaderLocation:3,offset:0,format:'float32x2'}]},
   {arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:4,offset:0,format:'float32x4'},{shaderLocation:5,offset:16,format:'float32x4'}]}];
  this.floraBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:3,buffer:{type:'uniform'}},{binding:1,visibility:2,texture:{sampleType:'float'}},{binding:2,visibility:2,sampler:{type:'filtering'}}]});
  {const cv=bakeFoliageAtlas();const t=this.floraAtlas=d.createTexture({size:[ATLAS_PX,ATLAS_PX],mipLevelCount:mipCount(ATLAS_PX,ATLAS_PX),format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});d.queue.copyExternalImageToTexture({source:cv},{texture:t,premultipliedAlpha:false},[ATLAS_PX,ATLAS_PX]);generateMips(d,t);this.floraSamp=d.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',maxAnisotropy:8});}
  this.floraPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.floraBGL]}),vertex:{module:m,entryPoint:'vs',buffers:vb},fragment:{module:m,entryPoint:'fs',targets:[{format:this.sceneFmt}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'greater',depthWriteEnabled:true}});
  this.floraDepthPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.floraBGL]}),vertex:{module:m,entryPoint:'vs',buffers:vb},fragment:{module:m,entryPoint:'fsDepth',targets:[{format:this.sceneFmt,writeMask:0}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'greater',depthWriteEnabled:true}});
  this.floraEqPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.floraBGL]}),vertex:{module:m,entryPoint:'vs',buffers:vb},fragment:{module:m,entryPoint:'fs',targets:[{format:this.sceneFmt}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'equal',depthWriteEnabled:false}});
  this.floraShadowPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.floraBGL,this.shadowBGL]}),vertex:{module:m,entryPoint:'vsShadow',buffers:vb},fragment:{module:m,entryPoint:'fsShadow',targets:[]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'less',depthWriteEnabled:true,depthBias:2,depthBiasSlopeScale:2.2}});
  this.floraU=[0,1,2,3,4,5,6,7,8].map(()=>d.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));
  this.floraBG=this.floraU.map(b=>d.createBindGroup({layout:this.floraBGL,entries:[{binding:0,resource:{buffer:b}},{binding:1,resource:this.floraAtlas.createView()},{binding:2,resource:this.floraSamp}]}));
  // near LOD (cards) out to 170 m, hull LOD out to 1.6 km; bird pass
  [[0,170,1600,0],[1,170,504,0],[0,170,1600,1],[0,52,450,0],[1,52,450,0],[0,62,520,0],[1,62,224,0],[1,450,1600,0],[1,200,520,0]].forEach(   /* far LODs hand over to the LOD-2 blobs (7 trees, 8 shrubs) at 450 / 200 m */   /* 5,6: shrubs, whose leaf cards stop paying off beyond ~60 m */(v,i)=>d.queue.writeBuffer(this.floraU[i],0,new Float32Array(v)));}
 floraLocale(){const q=new URLSearchParams(location.search).get('locale');return this.localeOverride||(q&&LOCALES[q]?q:null)||pickLocale(this.o.world,this.o.water?.level??0);}
 syncFlora(){const o=this.o,w=o.world;if(!w||!o.terrainBox||!this.worldKey)return;{const pre=this.worldKey+'|'+(this.localeOverride||'');if(this._floraPre===pre)return;this._floraPre=pre;}   /* locale lookup only when the world or override changes */const locale=this.floraLocale();const key=this.worldKey+'|'+locale;if(this.floraKey===key)return;this.floraKey=key;
  if(!this.floraPipe)this.buildFloraPipes();const d=this.dev;for(const b of this.floraBufs||[])b.destroy();this.floraBufs=[];
  const mk=(arr,u)=>{const b=d.createBuffer({size:Math.max(16,arr.byteLength),usage:u|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(b,0,arr);this.floraBufs.push(b);return b;};
  this.geoCache??=new Map();const upload=g=>{if(!this.geoCache.has(g))this.geoCache.set(g,{pos:mk(g.pos,GPUBufferUsage.VERTEX),nrm:mk(g.nrm,GPUBufferUsage.VERTEX),col:mk(g.col,GPUBufferUsage.VERTEX),uv:mk(g.uv,GPUBufferUsage.VERTEX),count:g.count});return this.geoCache.get(g);};
  this.geoCache.clear();const t0=performance.now();const F=placeFlora(w,o.terrainBox,locale,o.water?.level??0);
  this.flora={locale,counts:F.counts,ms:Math.round(performance.now()-t0),groups:F.groups.map(g=>{const cpu=new Float32Array(g.inst);return{name:g.name,layer:g.layer,mesh:g.mesh,impBuf:mk(cpu,GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE),ni:0,near:upload(g.mesh.near),far:upload(g.mesh.far),cpu,nearBuf:mk(cpu,GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE),farBuf:mk(cpu,GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE),lod2:g.layer!=='grass'&&g.mesh.lod2?.count?upload(g.mesh.lod2):null,lod2Buf:mk(cpu,GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE),n2:0,nn:0,nf:0,n:cpu.length/8}}),
   birds:F.birds.filter(b=>b.inst.length).map(b=>({geo:upload(b.mesh),inst:mk(new Float32Array(b.inst.flat()),GPUBufferUsage.VERTEX),n:b.inst.length}))};
  this.floraAt=null;this.shadowDirty=true;console.info('[flora]',locale,JSON.stringify(F.counts),this.flora.ms+'ms');}
 // CPU LOD split (re-run after the camera moves a few metres): only instances inside the card range pay for the dense mesh
 floraLOD(){const fl=this.flora,cp=this.o.camera.position;if(!fl)return;const gk=(this.heightStamp||0)+'|'+this.reliefKey+'|'+this.reliefAgain;
  // view cone (horizontal): instances behind or beside the camera cost the same vertex work as visible ones, so they are
  // culled here; re-run when the camera moves 4 m or turns 3 degrees
  const cam=this.o.camera,e=cam.matrixWorld.elements,fx=-e[8],fy=-e[9],fz=-e[10],fl2=Math.hypot(fx,fz)||1,fdx=fx/fl2,fdz=fz/fl2,yaw=Math.atan2(fdz,fdx),pitch=Math.asin(Math.max(-1,Math.min(1,fy)));
  const aspect=cam.aspect||(this.w/this.h)||1.7,half=Math.atan(Math.tan((cam.fov||60)*Math.PI/360)*aspect),cull=Math.abs(pitch)<.9;
  if(this.floraAt&&Math.hypot(cp.x-this.floraAt[0],cp.z-this.floraAt[1])<4&&this.floraGK===gk&&Math.abs(((yaw-this.floraAt[2]+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI)<.052&&Math.abs(pitch-this.floraAt[3])<.052)return;
  this.floraAt=[cp.x,cp.z,yaw,pitch];this.floraGK=gk;this.plantQ=[];const coneCos=Math.cos(Math.min(Math.PI,half+.26));
  const d=this.dev,dyc=Math.max(0,cp.y-(this.o.world?.elevation?.(cp.x,cp.z)??0));   // camera height over the ground: LOD distances are 3-D (an overhead camera sees distant crowns)
  for(const g of fl.groups){const gr=g.layer==='grass',sh=g.layer==='shrub';const imp=!!(fl.imp&&!gr);const NEAR=gr?60:imp?(sh?37:97):sh?70:190,FAR0=gr?45:imp?(sh?28:85):sh?55:150,FAR1=gr?450:sh?520:1600,MID=gr?1e9:sh?200:450,IMP0=sh?27:78,FAR2=gr?FAR1:Math.max(FAR1,dyc*1.7+(sh?300:900));   /* LOD-2 reach grows with height: from the map camera the whole course's crowns stay */const src=g.cpu,n=g.n;const nb=new Float32Array(src.length),fb=new Float32Array(src.length),lb=new Float32Array(src.length),ib=imp?new Float32Array(src.length):null;let a=0,b=0,c=0,e=0;
   for(let i=0;i<n;i++){const o=i*8,dx=src[o]-cp.x,dz=src[o+2]-cp.z,dd=Math.hypot(dx,dz),d3=Math.hypot(dd,dyc);if(cull&&dd>(g.layer==="tree"?70:25)){   /* trees behind the camera still throw shadows into view: keep the nearest 70 m */const rad=src[o+3]*(gr?1.5:14)/dd;if((dx*fdx+dz*fdz)/dd<coneCos-rad)continue;}   /* outside the view cone (with the plant's own radius as slack) */
    if(d3<NEAR){nb.set(src.subarray(o,o+8),a*8);a++;}if(d3>FAR0&&d3<Math.min(FAR1,MID*1.12)){fb.set(src.subarray(o,o+8),b*8);b++;}if(d3>MID*.88&&d3<FAR2&&g.lod2&&!imp){lb.set(src.subarray(o,o+8),c*8);c++;}if(imp&&d3>IMP0&&d3<FAR2){ib.set(src.subarray(o,o+8),e*8);e++;}}
   if(a>1){   /* near LOD front-to-back: nearer crowns write depth first, so the leaf cards hidden behind them fail the depth test instead of being shaded */
    const idx=Array.from({length:a},(_,k)=>k),dk=idx.map(k=>(nb[k*8]-cp.x)**2+(nb[k*8+2]-cp.z)**2);idx.sort((p,q)=>dk[p]-dk[q]);const tmp=nb.slice(0,a*8);idx.forEach((k,j)=>nb.set(tmp.subarray(k*8,k*8+8),j*8));}
   if(a){d.queue.writeBuffer(g.nearBuf,0,nb,0,a*8);this.plantQ.push([g.nearBuf,a]);}if(b){d.queue.writeBuffer(g.farBuf,0,fb,0,b*8);this.plantQ.push([g.farBuf,b]);}if(c){d.queue.writeBuffer(g.lod2Buf,0,lb,0,c*8);this.plantQ.push([g.lod2Buf,c]);}if(e){d.queue.writeBuffer(g.impBuf,0,ib,0,e*8);this.plantQ.push([g.impBuf,e]);}g.nn=a;g.nf=b;g.n2=c;g.ni=e;}
  if(fl.imp){for(const g of fl.groups)if(g.imp)d.queue.writeBuffer(g.imp.u,40,new Float32Array([Math.max(g.layer==='shrub'?520:1600,dyc*1.7+(g.layer==='shrub'?300:900))]));}
  d.queue.writeBuffer(this.floraU[7],0,new Float32Array([1,450,Math.max(1600,dyc*1.7+900),0]));d.queue.writeBuffer(this.floraU[8],0,new Float32Array([1,200,Math.max(520,dyc*1.7+300),0]));}
 // Plant the instances just uploaded: ia.y += groundH(xz), once per LOD refresh, on the GPU (same ground function the
 // terrain draws with). The flora vertex shader then reads the planted height instead of evaluating the 16-tap ground
 // B-spline for every vertex of every tree (~15 M vertices a frame on a wooded hole).
 // Impostor atlas: every non-grass species variant rendered once (orthographic) from 8 azimuths x 3 elevations into an
 // albedo+coverage and a normal+leaf texture, then mip-mapped. Drawn beyond 97 m (trees) / 38 m (shrubs) as one lit quad.
 bakeImpostors(){const fl=this.flora,d=this.dev;try{
  const U=GPUTextureUsage,W=2048,EL=[.14,.66,1.26],list=fl.groups.filter(g=>g.layer!=='grass'&&g.mesh?.near?.count);
  let x=0,y=0,rowH=0;const slots=list.map(g=>{const S=BUDGET.impostorCell,bw=8*S,bh=3*S;if(x+bw>W){x=0;y+=rowH;rowH=0;}const o={g,S,x0:x,y0:y};x+=bw;rowH=Math.max(rowH,bh);return o;});
  const H=Math.max(64,y+rowH),lv=6;
  const mkT=f=>d.createTexture({size:[W,H],format:f,mipLevelCount:f==='depth32float'?1:lv,usage:U.RENDER_ATTACHMENT|U.TEXTURE_BINDING});
  const tA=mkT('rgba8unorm'),tB=mkT('rgba8unorm'),tD=mkT('depth32float');
  if(!this.impBakePipe){const m=d.createShaderModule({code:IMPOSTOR_WGSL});m.getCompilationInfo().then(i=>{for(const q of i.messages)if(q.type==='error')console.error('WGSL impostor',q.lineNum,q.message)});
   const vb=[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]},{arrayStride:12,attributes:[{shaderLocation:1,offset:0,format:'float32x3'}]},{arrayStride:16,attributes:[{shaderLocation:2,offset:0,format:'float32x4'}]},{arrayStride:8,attributes:[{shaderLocation:3,offset:0,format:'float32x2'}]},
    {arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:4,offset:0,format:'float32x4'},{shaderLocation:5,offset:16,format:'float32x4'}]}];
   this.bakeBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:3,buffer:{type:'uniform'}}]});
   this.impBakePipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.floraBGL,this.bakeBGL]}),vertex:{module:m,entryPoint:'vsBake',buffers:vb},fragment:{module:m,entryPoint:'fsBake',targets:[{format:'rgba8unorm'},{format:'rgba8unorm'}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'less',depthWriteEnabled:true}});
   this.impBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:3,buffer:{type:'uniform'}},{binding:1,visibility:2,texture:{sampleType:'float'}},{binding:2,visibility:2,texture:{sampleType:'float'}},{binding:3,visibility:2,sampler:{type:'filtering'}}]});
   this.impPipe=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.impBGL]}),vertex:{module:m,entryPoint:'vsImp',buffers:[{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:4,offset:0,format:'float32x4'},{shaderLocation:5,offset:16,format:'float32x4'}]}]},fragment:{module:m,entryPoint:'fsImp',targets:[{format:this.sceneFmt}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'greater',depthWriteEnabled:true}});
   this.impSamp=d.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear'});}
  const dummy=d.createBuffer({size:32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),tmp=[dummy];
  const enc=d.createCommandEncoder(),pass=enc.beginRenderPass({colorAttachments:[tA,tB].map(t=>({view:t.createView({baseMipLevel:0,mipLevelCount:1}),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'})),depthStencilAttachment:{view:tD.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'discard'}});
  pass.setPipeline(this.impBakePipe);pass.setBindGroup(0,this.frameBG);pass.setBindGroup(1,this.floraBG[0]);
  for(const sl of slots){const {g,S,x0,y0}=sl,P=g.mesh.near.pos;let R=.1,y0m=1e9,y1m=-1e9;for(let i=0;i<P.length;i+=3){R=Math.max(R,Math.hypot(P[i],P[i+2]));y0m=Math.min(y0m,P[i+1]);y1m=Math.max(y1m,P[i+1]);}
   const L=Math.max(R,(y1m-y0m)/2)*1.04,yc=(y0m+y1m)/2,Lz=L*1.3;
   const geo=this.geometry?null:null;const gg=g.near;pass.setVertexBuffer(0,gg.pos);pass.setVertexBuffer(1,gg.nrm);pass.setVertexBuffer(2,gg.col);pass.setVertexBuffer(3,gg.uv);pass.setVertexBuffer(4,dummy);
   for(let j=0;j<3;j++)for(let k=0;k<8;k++){const el=EL[j],az=k*Math.PI/4,dir=[Math.cos(el)*Math.cos(az),Math.sin(el),Math.cos(el)*Math.sin(az)];
    let r=[dir[2],0,-dir[0]];const rl=Math.hypot(...r)||1;r=r.map(v=>v/rl);const u=[dir[1]*r[2]-dir[2]*r[1],dir[2]*r[0]-dir[0]*r[2],dir[0]*r[1]-dir[1]*r[0]];   // r = up x dir, u = dir x r
    const M=new Float32Array([r[0]/L,u[0]/L,-dir[0]/(2*Lz),0, r[1]/L,u[1]/L,-dir[1]/(2*Lz),0, r[2]/L,u[2]/L,-dir[2]/(2*Lz),0, -yc*r[1]/L,-yc*u[1]/L,.5+yc*dir[1]/(2*Lz),1]);
    const b=d.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(b,0,M);d.queue.writeBuffer(b,64,new Float32Array([0,yc,0,Math.max(R,(y1m-y0m)/2)]));tmp.push(b);
    pass.setBindGroup(2,d.createBindGroup({layout:this.bakeBGL,entries:[{binding:0,resource:{buffer:b}}]}));pass.setViewport(x0+k*S,y0+j*S,S,S,0,1);pass.draw(gg.count,1);}
   const uB=d.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});const sh=g.layer==='shrub';
   d.queue.writeBuffer(uB,0,new Float32Array([x0/W,y0/H,S/W,S/H, L,yc,0,0, sh?27.5:78,sh?30.5:84,sh?520:1600,0]));
   g.imp={u:uB,bg:d.createBindGroup({layout:this.impBGL,entries:[{binding:0,resource:{buffer:uB}},{binding:1,resource:tA.createView()},{binding:2,resource:tB.createView()},{binding:3,resource:this.impSamp}]})};}
  pass.end();d.queue.submit([enc.finish()]);generateMips(d,tA);generateMips(d,tB);setTimeout(()=>{for(const b of tmp)b.destroy();tD.destroy();},2000);
  // near cards now hand over at 86 m (trees) / 33 m (shrubs)
  d.queue.writeBuffer(this.floraU[0],0,new Float32Array([0,86,1600,0]));d.queue.writeBuffer(this.floraU[5],0,new Float32Array([0,32,520,0]));
  fl.imp={tA,tB,W,H};this.floraAt=null;console.info('[flora] impostors baked',list.length,'species',W+'x'+H);
 }catch(err){console.warn('impostor bake failed',err);fl.impFailed=true;}}
 encodePlant(enc){const q=this.plantQ;if(!q?.length||!this.plantPipe||!this.frameBG)return;this.plantQ=[];this._lbl='flora: plant instances';const pass=enc.beginComputePass();pass.setPipeline(this.plantPipe);pass.setBindGroup(0,this.frameBG);
  for(const [buf,n] of q){const u=this.dev.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.dev.queue.writeBuffer(u,0,new Uint32Array([n,0,0,0]));
   pass.setBindGroup(1,this.dev.createBindGroup({layout:this.plantBGL,entries:[{binding:0,resource:{buffer:buf,size:n*32}},{binding:1,resource:{buffer:u}}]}));pass.dispatchWorkgroups(Math.ceil(n/64));}
  pass.end();}
 drawFlora(pass,shadowBG){const fl=this.flora;if(!fl||this.noFlora||this.o.userEffects?.trees===false)return;const bind=(g)=>{pass.setVertexBuffer(0,g.pos);pass.setVertexBuffer(1,g.nrm);pass.setVertexBuffer(2,g.col);pass.setVertexBuffer(3,g.uv);};
  pass.setPipeline(shadowBG?this.floraShadowPipe:this.floraPipe);pass.setBindGroup(0,shadowBG?this.frameBGShadow:this.frameBG);if(shadowBG)pass.setBindGroup(2,shadowBG);
  const nearPass=(pipe)=>{pass.setPipeline(pipe);for(const g of fl.groups){if(!g.nn)continue;pass.setBindGroup(1,this.floraBG[g.layer==='grass'?3:g.layer==='shrub'?5:0]);bind(g.near);pass.setVertexBuffer(4,g.nearBuf);pass.draw(g.near.count,g.nn);}};
  if(!shadowBG){nearPass(this.floraDepthPipe);nearPass(this.floraEqPipe);pass.setPipeline(this.floraPipe);}   // near cards: depth pre-pass, then shade each pixel once
  for(const g of fl.groups){for(const [lod,geo,buf,cnt] of [[0,g.near,g.nearBuf,shadowBG?g.nn:0],[1,g.far,g.farBuf,g.nf],[2,g.lod2,g.lod2Buf,g.n2]]){if(!cnt||!geo||(shadowBG&&lod===1&&g.layer==='grass')||(shadowBG&&lod===2)||(!shadowBG&&lod>0&&g.imp))continue;pass.setBindGroup(1,this.floraBG[lod===2?(g.layer==='shrub'?8:7):lod+(g.layer==='grass'?3:g.layer==='shrub'?5:0)]);bind(geo);pass.setVertexBuffer(4,buf);pass.draw(geo.count,cnt);}}
  if(!shadowBG){pass.setBindGroup(1,this.floraBG[2]);for(const b of fl.birds){bind(b.geo);pass.setVertexBuffer(4,b.inst);pass.draw(b.geo.count,b.n);}}
  if(!shadowBG&&fl.imp){pass.setPipeline(this.impPipe);pass.setBindGroup(0,this.frameBG);for(const g of fl.groups){if(!g.imp||!g.ni)continue;pass.setBindGroup(1,g.imp.bg);pass.setVertexBuffer(0,g.impBuf);pass.draw(6,g.ni);}}}
 // Lines (scene Line / LineSegments nodes: map boundaries, club score lines): unlit colour x opacity, blended
 drawLines(pass,lines){const d=this.dev,hdr=this.sceneFmt;
  if(!this.linePipes){const m=d.createShaderModule({code:FRAME+COMMON+`struct LU{color:vec4f}
@group(1) @binding(0) var<uniform> L:LU;
@vertex fn vs(@location(0) p:vec3f,@location(4) m0:vec4f,@location(5) m1:vec4f,@location(6) m2:vec4f,@location(7) m3:vec4f)->@builtin(position) vec4f{return F.viewProj*(mat4x4f(m0,m1,m2,m3)*vec4f(p,1.));}
@fragment fn fs()->@location(0) vec4f{return L.color;}`});
   this.lineBGL=d.createBindGroupLayout({entries:[{binding:0,visibility:2,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:16}}]});this.lineBuf=d.createBuffer({size:256*256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.lineBG=d.createBindGroup({layout:this.lineBGL,entries:[{binding:0,resource:{buffer:this.lineBuf,size:16}}]});
   const layout=d.createPipelineLayout({bindGroupLayouts:[this.frameLayout(),this.lineBGL]}),vb=[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]},{arrayStride:64,stepMode:'instance',attributes:[0,1,2,3].map(i=>({shaderLocation:4+i,offset:i*16,format:'float32x4'}))}];
   const mk=(topology,test)=>d.createRenderPipeline({layout,vertex:{module:m,entryPoint:'vs',buffers:vb},fragment:{module:m,entryPoint:'fs',targets:[{format:hdr,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology},depthStencil:{format:'depth32float',depthCompare:test?'greater':'always',depthWriteEnabled:false}});
   this.linePipes={'line-strip1':mk('line-strip',true),'line-strip0':mk('line-strip',false),'line-list1':mk('line-list',true),'line-list0':mk('line-list',false)};}
  const k=Math.min(lines.length,256),u=new Float32Array(k*64);for(let i=0;i<k;i++){const c=lines[i].material.color;u.set([c.r,c.g,c.b,lines[i].material.opacity??1],i*64);}d.queue.writeBuffer(this.lineBuf,0,u);
  for(let i=0;i<k;i++){const l=lines[i],g=this.geometry(l.geometry);if(!g||g.n<2)continue;pass.setPipeline(this.linePipes[(l.isLineSegments?'line-list':'line-strip')+(l.material.depthTest===false?0:1)]);pass.setBindGroup(1,this.lineBG,[i*256]);pass.setVertexBuffer(0,g.pos);pass.setVertexBuffer(1,this.instances(l));pass.draw(g.n);}}
 // visible drawables from the scene database (dist/core Scene.collect: dirty-only transforms, one pass, no allocations).
 // The tracer has its own pass; the aim ring/line are UI state the HUD draws instead.
 collect(){const o=this.o,sk=this._skip??=new Set();sk.clear();for(const n of [o.tracer,o.ring,o.line])if(n)sk.add(n);return o.scene.collect(sk);}
 // ------------------------------------------------------------------ frame
 // green-reading grid state: shown while the ball is at rest on (or next to) the green with the putter or on the putting
 // surface, hidden in flight; eased in and out. 'G' toggles it (renderer.showPuttGrid).
 puttGrid(){const o=this.o,w=o.world,b=o.ball?.position,pin=w?.pin;const st=this._pg??={alpha:0,x:0,z:0,angle:0,t:performance.now()};const now=performance.now(),dt=Math.min(.1,(now-st.t)/1000);st.t=now;
  let want=0;if(w&&b&&pin&&!o.shot&&!o.overview&&!o.courseView&&o.showPuttGrid!==false&&o.ball.visible!==false){const onGreen=w.surface(b.x,b.z)==='green';const near=Math.hypot(pin.x-b.x,pin.z-b.z)<45;
   if(onGreen||(o.clubIndex===5&&near))want=1;st.x=pin.x;st.z=pin.z;const dx=b.x-pin.x,dz=b.z-pin.z;if(dx*dx+dz*dz>1e-4)st.angle=Math.atan2(dz,dx);}
  st.alpha+=(want-st.alpha)*Math.min(1,dt*(want?3:6));return st;}
 render(now){if(!this.ready||!this.o.world)return;const o=this.o,d=this.dev;const c0=performance.now();const T=this.timing&&this.timer&&((this._tfr=((this._tfr||0)+1)%3)===0)?this.timer:null;   /* detailed timing samples every 3rd frame: timestamps, readback and the split main pass cost the frames they're on */if(T)T.begin();this._lbl=null;
  // draw/triangle counters for the perf HUD (every render pass of the frame encoder), + timestamps when detailed timing is on
  const st={draws:0,tris:0};const cnt=p=>{const d0=p.draw.bind(p),di=p.drawIndexed.bind(p),dn=p.drawIndirect.bind(p);p.draw=(v,i=1,...r)=>{st.draws++;st.tris+=v*i/3;return d0(v,i,...r)};p.drawIndexed=(c,i=1,...r)=>{st.draws++;st.tris+=c*i/3;return di(c,i,...r)};p.drawIndirect=(...a)=>{st.draws++;return dn(...a)};return p;};this.drawStats=st;
  const wrapEnc=e=>{const rp=e.beginRenderPass.bind(e),cpp=e.beginComputePass.bind(e);e.beginRenderPass=ds=>cnt(rp(!T||ds.timestampWrites?ds:{...ds,timestampWrites:T.tw(this._lbl||'render (unlabelled)')}));if(T)e.beginComputePass=(ds={})=>cpp(ds.timestampWrites?ds:{...ds,timestampWrites:T.tw(this._lbl||'compute (unlabelled)')});return e};
  this.dynRes(now);this.resize();this.syncWorld();this.syncFlora();this.floraLOD();if(this.heightDirty)this.bakeHeight();const c1=performance.now();
  if(this.satReady&&this.satFade<1)this.satFade=Math.min(1,(this.satFade||0)+.02);
  const cam=o.camera;cam.updateMatrixWorld();let view=cam.matrixWorldInverse.elements;
  // debug/inspection pose: backend.debugPose={eye:[x,y,z],target:[x,y,z]}
  const dbg=this.debugPose;if(dbg)view=lookAt(dbg.eye,dbg.target,[0,1,0]);const proj=perspectiveRZ(cam.fov,this.w/this.h,.05);{const vs=cam.viewShift?.();if(vs){proj[8]+=vs[0];proj[9]+=vs[1];}}   // camera view offset (map panel)
  // TAA: Halton(2,3) sub-pixel jitter (8-phase cycle) applied to the projection; the unjittered matrix is kept for reprojection
  let jx=0,jy=0;const vpU=mul(proj,view);if(this.taaOn){const hal=(i,b)=>{let f=1,r=0;while(i>0){f/=b;r+=f*(i%b);i=Math.floor(i/b);}return r;};const k=(this.taaFrame=(this.taaFrame+1)%8)+1;jx=hal(k,2)-.5;jy=hal(k,3)-.5;proj[8]-=2*jx/this.w;proj[9]-=2*jy/this.h;}
  const vp=mul(proj,view),ivp=invert(vp);
  const f=this.frameData;f.set(vp,0);f.set(ivp,16);const cp=dbg?{x:dbg.eye[0],y:dbg.eye[1],z:dbg.eye[2]}:cam.position,time=now/1000;f.set([cp.x,cp.y,cp.z,time],32);
  const sd0=o.sunState?.direction||[-.68,.42,.6],sl0=Math.hypot(...sd0);const trueElev=sd0[1]/sl0;
  // render with the sun held just above the horizon; below it the light fades out through twilight instead of breaking the maps
  const hl=Math.hypot(sd0[0],sd0[2])/sl0||1,ey=Math.max(trueElev,.012),sd=[sd0[0]/sl0/hl*Math.sqrt(1-ey*ey),ey,sd0[2]/sl0/hl*Math.sqrt(1-ey*ey)],sl=1;const elev=trueElev;
  const twi=Math.min(1,Math.max(0,(trueElev*57.3+9)/10));this.twilight=twi;const exposure=1;   // brightness is the keyframed grade EV (gpu/grade.js); there is no auto exposure
  f.set([sd[0]/sl,sd[1]/sl,sd[2]/sl,exposure],36);
  const hz=0,   /* haze was removed from the game: clear air, no aerial-perspective fog */eDeg=Math.asin(Math.max(-1,Math.min(1,elev)))*180/Math.PI;
  const am=eDeg>-3?1/(Math.max(Math.sin(Math.max(eDeg,-2.9)*Math.PI/180),0)+.50572*Math.pow(eDeg+6.07995,-1.6364)):40;
  const tR=[.046,.108,.265],tO=[.0098,.028,.0013],tM=.02+.13*hz;const E0=[4.4,4.1,3.8];
  const hor=Math.min(1,Math.max(0,(eDeg+2)/3));const sun=E0.map((e,i)=>1.7*e*Math.exp(-(tR[i]+tO[i]+tM)*am*.62)*hor);this.sunRGB=sun;
  f.set([sun[0],sun[1],sun[2],hz],40);
  const mist=Math.min(1,hz*.9*(0.6+0.4*Math.max(0,1-Math.max(eDeg,0)/25)));f.set([0,0,0,this.noClouds?0:(o.lighting?.clouds??.35)],44);f.set([o.grassMode==='hybrid'?1:0,(o.canopyStyle??0)+(this.fastLighting?100:0),this.debugGrass??0,mist],48);
  const box=o.terrainBox||{x:0,z:0,size:1};f.set([box.x,box.z,box.size,o.water?.level??0],52);f.set([this.w,this.h,1/this.w,1/this.h],56);
  const wv=o.world?.wind||{x:.7,z:.3,speed:3};const wd=Math.hypot(wv.x||.7,wv.z||.3)||1;f.set([(wv.x||.7)/wd,(wv.z||.3)/wd,Math.min(1,(o.world?.windSpeed??3.5)/8)*.35+.08,.5+.5*Math.sin(time*.7)],60);
  f.set(frustum(vp),64);const sb=this.satBox||[0,0,1];f.set([sb[0],sb[1],sb[2],this.satReady?1:0],88);
  const w=o.world,pin=w.pin||{x:0,z:-100},tee=w.tee||{x:0,z:0},ax=pin.x-tee.x,az=pin.z-tee.z,al=Math.hypot(ax,az)||1;
  f.set([.72*(this.satFade||0),this.heightSize,ax/al,az/al],92);
  {const fw=[-view[2],-view[6],-view[10]],fl=Math.hypot(fw[0],fw[2])||1,sdir=[sd[0]/sl,sd[1]/sl,sd[2]/sl];this.shadowVP=[];
   for(const [ahead,radius] of [[12,32],[260,760]]){let cx=cp.x+fw[0]/fl*ahead,cz=cp.z+fw[2]/fl*ahead;const cy=o.world.elevation?.(cx,cz)??cp.y;
    const eye=[cx+sdir[0]*1500,cy+sdir[1]*1500,cz+sdir[2]*1500];let lv=lookAt(eye,[cx,cy,cz],[0,1,0]);
    // snap the cascade centre to whole shadow texels so edges don't crawl as the camera moves
    const texel=radius*2/SHADOW_SIZE;const ox=lv[12],oy=lv[13];lv[12]=Math.round(ox/texel)*texel;lv[13]=Math.round(oy/texel)*texel;
    this.shadowVP.push(mul(ortho(-radius,radius,-radius,radius,600,2400),lv));}
   f.set(this.shadowVP[0],96);f.set(this.shadowVP[1],112);{const mb=this.maskBox;f.set(mb?[mb[0],mb[1],mb[2],1]:[0,0,1,0],128);}f.set([(this.perfMask||0)|(this.effectMask||0),this.perfSpec||0,this.taaOn?1:0,Math.round((this.bladeRough??1)*100)+1000*Math.round((this.bladeFescue??1)*100)],132);}
  // CDLOD terrain: height-cache windows for this camera (fills F.clip); a full rebuild only when the ground data changes
  const TR=this.terrain;const useT=this.terrPipes!==undefined&&!o.overview&&!o.courseView&&this.heightSize>1,vScale=o.group?.scale.y??1;this.useTerrain=useT;
  {const bk=this.worldKey+'|'+(this.heightStamp||0);if(TR.boxKey!==bk&&o.terrainBox){TR.boxKey=bk;TR.setWorld(o.terrainBox,(x,z)=>o.world.elevation?.(x,z)??0);}
   if(useT)TR.plan(cp,[this.heightSize,this.worldKey,this.heightStamp||0,this.maskStamp||0,this.reliefKey,this.reliefAgain].join('|'),this.clipData,vScale);f.set(this.clipData,136);
    // ground material cache: rebuilt when anything it bakes changes (textures -> new frame bind group, masks, heights, photo fade)
    if(this.mat){const fading=!!this.satReady&&(this.satFade??0)<1;this.mat.plan(cp,[this.fbStamp||0,this.worldKey,this.heightStamp||0,this.maskStamp||0,this.reliefKey,this.satReady?1:0,fading?0:1].join('|'),this.mcData,useT&&!fading&&!this.noMatCache);f.set(this.mcData,168);}}
  d.queue.writeBuffer(this.frameBuf,0,f,0,200);   /* bytes 800+ (sky ambient lobes) are copied in on the GPU */
  {const g=this.puttGrid();d.queue.writeBuffer(this.frameBuf,848,new Float32Array([g.x,g.z,g.angle,g.alpha]));}
  if(!this.frameBG){this.fbStamp=(this.fbStamp||0)+1;this.frameBG=this.frameGroup();this.frameBGMaps=this.frameGroup(true);this.frameBGShadow=this.frameGroup(true,true);this.frameBGRelief=this.frameGroup(true,false,true);this.frameBGCM=this.frameGroup(false,false,false,false,true);}
  // draws
  const agl0=cp.y-(o.world.elevation?.(cp.x,cp.z)??0);
  const meshes=this.collect();let n=0;const dd=this.drawData,draws=this._draws??=[],lines=this._lines??=[],pool=this._pool??=[];draws.length=0;lines.length=0;
  const fr=frustum(vp);const inView=m=>{const gs=m.geometry;if(!gs.boundingSphere)gs.computeBoundingSphere();const bs=gs.boundingSphere;if(!bs||m.isInstancedMesh)return true;
   const e=m.matrixWorld.elements,c=bs.center,x=e[0]*c.x+e[4]*c.y+e[8]*c.z+e[12],y=e[1]*c.x+e[5]*c.y+e[9]*c.z+e[13],z=e[2]*c.x+e[6]*c.y+e[10]*c.z+e[14];
   const sc=Math.max(Math.hypot(e[0],e[1],e[2]),Math.hypot(e[4],e[5],e[6]),Math.hypot(e[8],e[9],e[10])),r=bs.radius*sc+1;
   for(let i=0;i<6;i++){if(fr[i*4]*x+fr[i*4+1]*y+fr[i*4+2]*z+fr[i*4+3]<-r)return false;}return true;};
  for(const m of meshes){const mat=m.material;if(m.isLine){lines.push(m);continue;}if(n>=MAX_DRAWS)break;if(mat.kind==='tracer'||(mat.transparent&&mat.opacity<.05))continue;const g=this.geometry(m.geometry);if(!g||!g.count)continue;
   const ground=mat.kind==='ground',vis=ground||inView(m),map=mat.map?this.texture(mat.map):null,col=mat.color,basic=mat.kind==='unlit',foliage=!!(mat.alphaTest&&map)&&!mat.special;
   const b=n*DRAW_STRIDE/4;dd[b]=col.r;dd[b+1]=col.g;dd[b+2]=col.b;dd[b+3]=mat.opacity??1;dd[b+4]=map&&!ground?1:0;dd[b+5]=mat.alphaTest||0;dd[b+6]=ground?1:basic?2:foliage?3:m._fx==='buildings'?4:0;dd[b+7]=g.hasColor&&mat.vertexColors?1:0;
   const em=mat.emissive,ei=mat.emissiveIntensity??1;dd[b+8]=em.r*ei;dd[b+9]=em.g*ei;dd[b+10]=em.b*ei;dd[b+11]=mat.roughness??1;dd[b+12]=mat.metalness||0;dd[b+13]=mat.clearcoat||0;dd[b+14]=SPECIAL[mat.special]||0;dd[b+15]=mat.ext?.[0]??0;if(mat.ext)for(let k=1;k<mat.ext.length&&k<16;k++)dd[b+15+k]=mat.ext[k];
   const rec=pool[n]??={};rec.m=m;rec.g=g;rec.n=n;rec.map=map;rec.ground=ground;rec.caster=!basic;rec.alpha=!!mat.alphaTest;rec.blend=basic&&mat.transparent;rec.vis=vis;draws.push(rec);n++;}
  d.queue.writeBuffer(this.drawBuf,0,dd.buffer,0,Math.max(1,n)*DRAW_STRIDE);
  if(useT){const lvl=o.water?.level,ocean=!this.skip?.ocean&&agl0<1200&&lvl!=null&&cp.y>lvl+.5;TR.select(cp,fr,vScale,lvl,!ocean);}
  const c2=performance.now();const enc=wrapEnc(d.createCommandEncoder());
  // sky LUT: re-rendered only when what it depends on changes (sun, haze, camera height in 5 m steps), not every frame
  const lutKey=[sd[0],sd[1],sd[2]].map(v=>v.toFixed(4)).join(',')+'|'+Math.round(Math.max(1,cp.y)/5)+'|'+(0)+'|'+twi.toFixed(3);
  if(this.lutKey!==lutKey){this.lutKey=lutKey;d.queue.writeBuffer(this.skyLUTBuf,0,new Float32Array([sd[0]/sl,sd[1]/sl,sd[2]/sl,Math.max(1,Math.round(Math.max(1,cp.y)/5)*5),1+1.1*(0),24*(.04+.96*twi*twi)]));
  this._lbl='sky LUT';{const lp=enc.beginRenderPass({colorAttachments:[{view:this.skyLUT.createView(),loadOp:'clear',clearValue:[0,0,0,1],storeOp:'store'}]});lp.setPipeline(this.skyLUTPipe);lp.setBindGroup(0,this.skyLUTBG);lp.draw(3);lp.end();}
   d.queue.writeBuffer(this.skyAmbBuf,0,new Float32Array([sd[0]/sl,sd[1]/sl,sd[2]/sl,0]));{const ap=enc.beginRenderPass({colorAttachments:[{view:this.skyAmb.createView(),loadOp:'clear',clearValue:[0,0,0,1],storeOp:'store'}]});ap.setPipeline(this.skyAmbPipe);ap.setBindGroup(0,this.skyAmbBG);ap.draw(3);ap.end();enc.copyTextureToBuffer({texture:this.skyAmb},{buffer:this.frameBuf,offset:800},[5,1,1]);}}
  // cached maps (terrain shadow when sun/terrain changes, clouds every 8th frame). They're sampled by the frame
  // bind group, so they are written in their own submission before this frame's passes.
  {const sunKey=sd.join(',')+'|'+this.heightSize+'|'+this.worldKey+'|'+(this.heightStamp||0);const menc=wrapEnc(d.createCommandEncoder());let any=false;
   {const rk=this.heightSize+'|'+this.worldKey+'|'+(this.heightStamp||0)+'|'+(this.maskStamp||0);if((this.reliefKey!==rk||this.reliefAgain>0)&&this.heightSize>1){if(this.reliefKey!==rk)this.reliefAgain=2;else this.reliefAgain--;this.reliefKey=rk;this.tsAgain=2;
    d.queue.writeBuffer(this.mapsU[2],0,new Float32Array([2,time,0,0]));this._lbl='maps: relief';const cr=menc.beginComputePass();cr.setPipeline(this.mapsPipe);cr.setBindGroup(0,this.frameBGRelief);cr.setBindGroup(1,this.mapsBG[2]);cr.dispatchWorkgroups(256,256);cr.end();
    d.queue.writeBuffer(this.mapsU[3],0,new Float32Array([3,time,0,0]));this._lbl='maps: relief AO';const ca=menc.beginComputePass();ca.setPipeline(this.mapsPipe);ca.setBindGroup(0,this.frameBGMaps);ca.setBindGroup(1,this.mapsBG[3]);ca.dispatchWorkgroups(256,256);ca.end();any=true;}}
   if(this.reliefAgain===0&&this.reliefRead!==this.reliefKey&&!this.reliefReading){this.readRelief(this.reliefKey);}
   if((this.tsKey!==sunKey||this.tsAgain>0)&&this.heightSize>1){if(this.tsKey!==sunKey)this.tsAgain=2;else this.tsAgain--;this.tsKey=sunKey;d.queue.writeBuffer(this.mapsU[0],0,new Float32Array([0,time,0,0]));this._lbl='maps: terrain shadow';const cp2=menc.beginComputePass();cp2.setPipeline(this.mapsPipe);cp2.setBindGroup(0,this.frameBGMaps);cp2.setBindGroup(1,this.mapsBG[0]);cp2.dispatchWorkgroups(256,256);cp2.end();any=true;}
   if(((this.frameNo=(this.frameNo||0)+1)%8)===1&&!this.noClouds){   /* clouds off: the shading term is masked out (perf bit 4), so the map isn't needed */d.queue.writeBuffer(this.mapsU[1],0,new Float32Array([1,time,0,0]));this._lbl='maps: cloud shadow';const cp3=menc.beginComputePass();cp3.setPipeline(this.mapsPipe);cp3.setBindGroup(0,this.frameBGMaps);cp3.setBindGroup(1,this.mapsBG[1]);cp3.dispatchWorkgroups(128,128);cp3.end();any=true;}
   if(any)d.queue.submit([menc.finish()]);}
  if(this.flora&&!this.flora.imp&&!this.flora.impFailed&&this.frameBG)this.bakeImpostors();
  this.encodePlant(enc);
  if(useT){this._lbl='terrain: height cache update';TR.encode(enc,this.frameBGCM);if(this.mat){this._lbl='terrain: material cache bake';this.mat.encode(enc,this.frameBGCM);}}
  // Water costs nothing where none can be seen: every view ray that reaches sea level lands on terrain above it (checked on a
  // 16x16 grid of rays; a descending ray can meet the sea only where it crosses sea level) and none heads over the horizon.
  const waterVis=(()=>{const lvl=o.water?.level,el=o.world?.elevation;if(lvl==null||!el)return true;const m=ivp;
   for(let j=0;j<16;j++)for(let i=0;i<16;i++){const x=i/7.5-1,y=j/7.5-1;const X=m[0]*x+m[4]*y+m[8]*.5+m[12],Y=m[1]*x+m[5]*y+m[9]*.5+m[13],Z=m[2]*x+m[6]*y+m[10]*.5+m[14],W=m[3]*x+m[7]*y+m[11]*.5+m[15];
    const dx=X/W-cp.x,dy=Y/W-cp.y,dz=Z/W-cp.z;if(dy>=-1e-4*Math.hypot(dx,dz))return true;const t=(lvl+3-cp.y)/dy;if(t<=0)return true;
    if(el(cp.x+dx*t,cp.z+dz*t)<lvl+3)return true;}
   return false;})();this.waterVisible=waterVis;
  this._lbl='ocean FFT';if(!o.courseView&&!o.overview&&!this.skip?.ocean&&waterVis)this.oceanStep(enc,time);
  // grass scatter
  const agl=cp.y-(o.world.elevation?.(cp.x,cp.z)??0);const grassOn=!this.noGrass&&!o.courseView&&agl<160&&(o.group?.scale.y??1)>.98;
  /* Re-scatter only when the view has moved enough to matter: >0.2 m, >1.2 deg of turn, a lens change or any scene key.
     The scatter's frustum test keeps a 3 m margin (1.2 deg at 90 m is <2 m), and LOD/sink/list thresholds shift by
     under 1% of distance, so between re-scatters the cached blades stay correct while a slow pan or an aim adjust no
     longer rebuilds ~700k blades every frame. (A moving camera used to cost a full scatter per frame.) */
  const gKey=(grassOn?'on':'off')+'|'+sd.join(',')+'|'+o.grassMode+'|'+(o.lighting?.clouds)+'|'+this.reliefKey+'|'+this.maskStamp+'|'+proj[0].toFixed(4)+','+proj[5].toFixed(4);
  const gF=[-view[2],-view[6],-view[10]],gs0=this.gScat;
  const gFresh=this.gKey!==gKey||!gs0||Math.hypot(cp.x-gs0.p[0],cp.y-gs0.p[1],cp.z-gs0.p[2])>(this.grassMoveTol??.2)||gF[0]*gs0.f[0]+gF[1]*gs0.f[1]+gF[2]*gs0.f[2]<Math.cos((this.grassTurnTol??1.2)*Math.PI/180);
  this.gKey=gKey;if(gFresh)this.gScat={p:[cp.x,cp.y,cp.z],f:gF};
  if(grassOn&&!o.overview&&gFresh){d.queue.writeBuffer(this.counter,0,new Uint32Array(16));
   const gc=1/Math.sqrt(BUDGET.grass),rings=[[0,4.5,.011*gc,40,2],[4.5,14,.02*gc,40,0],[14,30,.038*gc,40,0],[30,90,.06*gc,40,0]];   /* LOWMEM: blade density matched to the smaller pools (else later cells would be dropped whole) */this._lbl='grass scatter (compute)';const cs=enc.beginComputePass();cs.setPipeline(this.scatterPipe);cs.setBindGroup(0,this.frameBG);
   rings.forEach(([inner,outer,cell,shortMax,shortOnly],i)=>{const count=Math.ceil(outer*2/cell);/* ultra ring (mode 2) covers every surface */const origin=[cp.x-outer,cp.z-outer];d.queue.writeBuffer(this.rings[i],0,new Float32Array([origin[0],origin[1],cell,count,inner,outer,shortMax,shortOnly]));cs.setBindGroup(1,this.grassCS[i]);cs.dispatchWorkgroups(Math.ceil(count/8),Math.ceil(count/8));});
   cs.setPipeline(this.finishPipe);cs.setBindGroup(1,this.grassCS[0]);cs.dispatchWorkgroups(1);cs.end();
   }
    // indirect args every frame (a few bytes): the draw lists can change without a re-scatter (A/B tests swap grassLOD)
  if(grassOn&&!o.overview){const ia=new Uint32Array(this.grassLOD.length*5);this.grassLOD.forEach((L,i)=>{ia[i*5]=L.n;});d.queue.writeBuffer(this.indirect,0,ia);this.grassLOD.forEach((L,i)=>enc.copyBufferToBuffer(this.counter,[28,40,44,56][L.list],this.indirect,i*20+4,4));}
  const SK=this.skip||{};this.shadowKeys??=[];
  // the wide cascade only holds static ground/scenery: re-render it only when its (texel-snapped) view changes
  const ballMoving=!!o.shot||!!o.cameraMotion?.active;
  for(let c=0;c<(SK.shadow?0:2);c++){const sk=Array.from(this.shadowVP[c]).map(v=>v.toFixed(4)).join(',')+'|'+this.reliefKey+'|'+(this.worldKey||'');if(c===1&&this.shadowKeys[1]===sk&&!this.shadowDirty)continue;if(c===0&&this.shadowKeys[0]===sk&&!ballMoving&&!this.shadowDirty)continue;this.shadowKeys[c]=sk;d.queue.writeBuffer(this.shadowUBO[c],0,this.shadowVP[c]);this._lbl='shadow map cascade '+c;const sp=enc.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:this.shadowTex.createView({dimension:'2d',baseArrayLayer:c,arrayLayerCount:1}),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
   sp.setPipeline(this.shadowPipe);sp.setBindGroup(0,this.shadowBG[c]);
   /* the ground itself (terrain, camera grid, bunker lips) is NOT an object-shadow caster: its self-shadowing is the terrain horizon march + the heightfield contact march, both on the true shaped surface. Rasterising the coarse ground into the shadow map double-counted it and cast phantom blobs wherever the mesh sits above the drawn sand/turf. */
   sp.setPipeline(this.shadowPipe);sp.setBindGroup(0,this.shadowBG[c]);
   for(const {m,g,ground,caster} of draws){if(ground||!caster)continue;sp.setVertexBuffer(0,g.pos);sp.setVertexBuffer(1,this.instances(m));const ic=this.inst.get(m).count;if(g.index){sp.setIndexBuffer(g.index,g.indexFormat);sp.drawIndexed(g.count,ic);}else sp.draw(g.count,ic);}
   if(!o.overview&&!o.courseView&&vScale>.98)this.drawFlora(sp,this.shadowBG[c]);sp.end();}
  this.shadowDirty=false;
  // ---- Deferred terrain (the production path whenever the CDLOD terrain is drawn and no debug view is up). The ground
  // material is split into its own GPU passes, so every effect that shades the ground has its own timestamp:
  //   depth prepass -> [sun shadows] [terrain shadows] [cloud shadows] [ambient occlusion] (screen passes over the depth)
  //   -> material G-buffer (terrain, then bunker-sand strip; depth-equal, one shade per pixel) -> [ground detail]
  //   -> lighting -> [haze]. Bracketed passes run only while their effect is on. Everything after draws forward as before.
  const gdDef=draws.find(x=>x.ground);const fxm=(this.effectMask||0)>>>0;const GPd=this.groundPipesFor(fxm);
  const DEF=useT&&!SK.mesh&&!SK.ground&&!this.forwardGround&&!(this.debugGrass>0)&&!!gdDef&&!!GPd.def&&!!this.gbuf;
  this.grassFirst=false;
  if(DEF){const D=GPd.def,G=this.gbuf,dv=this.depth.createView(),on=b=>(fxm&b)!==b,st=this.strip,stripOn=!!(st&&!this.noStrip&&vScale>.98);
   if(!this.gbufBG){const L=this.gBGL,mk=(l,e)=>d.createBindGroup({layout:l,entries:e});
    this.gbufBG={A:mk(L.full,[{binding:0,resource:dv},{binding:1,resource:G.g0a.createView()},{binding:2,resource:G.g1a.createView()},{binding:3,resource:G.vis.createView()},{binding:4,resource:G.ao.createView()},{binding:6,resource:G.g2.createView()},{binding:7,resource:G.shLo.createView()}]),
     B:mk(L.full,[{binding:0,resource:dv},{binding:1,resource:G.g0b.createView()},{binding:2,resource:G.g1b.createView()},{binding:3,resource:G.vis.createView()},{binding:4,resource:G.ao.createView()},{binding:6,resource:G.g2.createView()},{binding:7,resource:G.shLo.createView()}]),
     depth:mk(L.depth,[{binding:0,resource:dv}]),ao:mk(L.ao,[{binding:4,resource:G.ao.createView()}])};}
   const SPL=(!!T&&!this.noSplit)||!!this.splitPasses;   // split passes (own timestamps): timed frames, or forced for A/B checks
   const BG=this.gbufBG,mat=()=>[this.matGroup(gdDef.map),[gdDef.n*DRAW_STRIDE]];
   const drawStrip=(q,pipe)=>{q.setPipeline(pipe);q.setBindGroup(1,...mat());q.setVertexBuffer(0,st.pos);q.setVertexBuffer(1,st.nrm);q.setVertexBuffer(2,st.uv);q.setVertexBuffer(3,st.col);q.setVertexBuffer(4,st.inst);q.draw(st.count,1);};
   // screen pass over the ground pixels (full-screen triangle at the far plane, depth 'less' = only where terrain was drawn)
   const screen=(lbl,pipe,targets,bg,clear)=>{this._lbl=lbl;const q=enc.beginRenderPass({colorAttachments:targets.map(t=>({view:t.createView(),loadOp:clear?'clear':'load',clearValue:[0,0,0,1],storeOp:'store'})),depthStencilAttachment:{view:dv,depthReadOnly:true}});
    q.setPipeline(pipe);q.setBindGroup(0,this.frameBG);q.setBindGroup(1,this.gEmptyBG);q.setBindGroup(2,bg);q.draw(3);q.end();};
   // depth prepass (vertex-only, bunker holes discarded): the expensive material then shades each visible pixel exactly once
   {this._lbl='terrain: depth prepass';const q=enc.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:dv,depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}});
    q.setBindGroup(0,this.frameBG);q.setBindGroup(1,...mat());TR.draw(q,D.pre);if(stripOn)drawStrip(q,D.preStrip);q.end();}
   // material G-buffer: terrain, then the bunker-sand strip (its own pass / timestamp), depth-equal over the prepass
   const FUSED=!!(D.terrLit&&D.stripLit)&&!this.legacyG&&this.mcData[28]>.5&&this.mat.stats.ready===7;   // terrain in one screen pass (fsTerrainLit), no G-buffer
   if(!FUSED){this._lbl='terrain material (G-buffer)';const q=enc.beginRenderPass({colorAttachments:[G.g0a,G.g1a,G.g2].map(t=>({view:t.createView(),loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'})),depthStencilAttachment:{view:dv,depthReadOnly:true}});
    q.setBindGroup(0,this.frameBG);q.setBindGroup(1,...mat());TR.draw(q,(D.gT&&!this.noLeanG&&!this.debugGrass&&this.mcData[28]>.5&&this.mat.stats.ready===7)?D.gT:D.g);if(stripOn&&!SPL)drawStrip(q,D.gStrip);q.end();}
   // frames without detailed timing draw the strip inside the terrain pass above (one less load/store of the G-buffer)
   if(!FUSED&&stripOn&&SPL){this._lbl='bunker sand (G-buffer)';const q=enc.beginRenderPass({colorAttachments:[G.g0a,G.g1a,G.g2].map(t=>({view:t.createView(),loadOp:'load',storeOp:'store'})),depthStencilAttachment:{view:dv,depthReadOnly:true}});
    q.setBindGroup(0,this.frameBG);drawStrip(q,D.gStrip);q.end();}
   // sun visibility and AO terms: screen passes over the ground depth
   if(on(GpuProbeBits.shadows)){this._lbl='sun shadows (ground)';const q=enc.beginRenderPass({colorAttachments:[{view:G.shLo.createView(),loadOp:'clear',clearValue:[1,0,0,1],storeOp:'store'}]});q.setPipeline(D.shSun);q.setBindGroup(0,this.frameBG);q.setBindGroup(1,this.gEmptyBG);q.setBindGroup(2,BG.depth);q.draw(3);q.end();}   // contact shadows at half res; object shadows are sampled in the lighting pass
   if(!FUSED&&on(GpuProbeBits.terrainShadows)&&!(on(GpuProbeBits.surfaceDetail)&&!SPL&&D.detailLight))screen('terrain shadows (ground)',D.shTerr,[G.vis],BG.depth);   // merged / fused lighting samples it inline
   if(!FUSED&&on(GpuProbeBits.clouds)&&!(on(GpuProbeBits.surfaceDetail)&&!SPL&&D.detailLight))screen('cloud shadows (ground)',D.shCloud,[G.vis],BG.depth);   // merged frames: evaluated inside the detail+lighting pass
   if(on(GpuProbeBits.ao)){this._lbl='ambient occlusion (ground)';const q=enc.beginRenderPass({colorAttachments:[{view:G.ao.createView(),loadOp:'clear',clearValue:[1,0,1,0],storeOp:'store'}]});q.setPipeline(D.ao);q.setBindGroup(0,this.frameBG);q.setBindGroup(1,this.gEmptyBG);q.setBindGroup(2,BG.depth);q.draw(3);q.end();}   // half res, depth-aware upsample in the lighting pass (aoUp)
   // ground detail + lighting: separate passes (each its own timestamp) on the frames that sample GPU timing, one merged
   // pass otherwise (the detailed G-buffer never goes through memory)
   const detail=on(GpuProbeBits.surfaceDetail);
   if(FUSED){
    // attribution probe (timed frames only, 1 in 6): the same pass without ground detail, into the colour target the real pass
    // then clears. The perf panel splits the merged pass into Terrain (this) and Ground detail (the rest).
    if(T&&detail&&D.terrLitND&&((this._probeN=(this._probeN||0)+1)%6===0))screen('probe: terrain without ground detail',D.terrLitND,[this.hdr],BG.A,true);
    // grass first, then the terrain as a depth-equal mesh pass: ground hidden under blades is never shaded (fsTerrainLitM)
    const GF=!!D.terrLitM&&grassOn&&!o.overview&&!SK.grass&&!this.noGrassFirst;this.grassFirst=GF;
    if(GF){this._lbl='main: grass blades';const gq=enc.beginRenderPass({colorAttachments:[{view:this.hdr.createView(),loadOp:'clear',clearValue:[0,0,0,1],storeOp:'store'}],depthStencilAttachment:{view:dv,depthLoadOp:'load',depthStoreOp:'store'}});
     gq.setBindGroup(0,this.frameBG);this.drawGrass(gq);gq.end();
     this._lbl='terrain: material + lighting';const q=enc.beginRenderPass({colorAttachments:[{view:this.hdr.createView(),loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:dv,depthReadOnly:true}});
     q.setBindGroup(0,this.frameBG);q.setBindGroup(1,...mat());q.setBindGroup(2,BG.A);TR.draw(q,[D.terrLitM,D.terrLitM,D.terrLitM]);q.end();}
    else screen('terrain: material + lighting',D.terrLit,[this.hdr],BG.A,true);
    if(stripOn){this._lbl='bunker sand (lit)';const q=enc.beginRenderPass({colorAttachments:[{view:this.hdr.createView(),loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:dv,depthReadOnly:true}});
     q.setBindGroup(0,this.frameBG);q.setBindGroup(2,BG.A);drawStrip(q,D.stripLit);q.end();}}
   else    if(detail&&!SPL&&D.detailLight)screen('lighting (ground)',D.detailLight,[this.hdr],BG.A,true);
   else{if(detail)screen('ground detail',D.detail,[G.g0b,G.g1b],BG.A);screen('lighting (ground)',D.light,[this.hdr],detail?BG.B:BG.A,true);}
   }
  this._lbl=DEF?'main: sky':'main: ground (CDLOD terrain)';let pass=enc.beginRenderPass({colorAttachments:[{view:this.hdr.createView(),clearValue:[0,0,0,1],loadOp:DEF?'load':'clear',storeOp:'store'}],depthStencilAttachment:{view:this.depth.createView(),depthClearValue:0,depthLoadOp:DEF?'load':'clear',depthStoreOp:'store'}});
  // detailed timing splits the main pass so each layer gets its own GPU timestamps (only while timing is on)
  const seg=(l,on=true)=>{if(!T||!on||this.segOff)return;pass.end();this._lbl=l;pass=enc.beginRenderPass({colorAttachments:[{view:this.hdr.createView(),loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:this.depth.createView(),depthLoadOp:'load',depthStoreOp:'store'}});pass.setBindGroup(0,this.frameBG);};
  pass.setBindGroup(0,this.frameBG);pass.setPipeline(this.meshPipeOpaque);
  {const gd=draws.find(x=>x.ground);if(gd&&useT&&!SK.mesh&&!SK.ground&&!DEF){pass.setBindGroup(1,this.matGroup(gd.map),[gd.n*DRAW_STRIDE]);
   const GP=this.groundPipesFor((this.effectMask||0)>>>0);if(useT&&GP.terr){TR.draw(pass,GP.terr);pass.setPipeline(this.meshPipeOpaque);}
   // bunker sand: same ground material/shader, exact rows along the lip (the terrain's turf is cut out over it)
   seg('main: bunker sand');const st=this.strip;if(GP.sand&&st&&!this.noStrip&&vScale>.98){pass.setPipeline(GP.sand);pass.setBindGroup(1,this.matGroup(gd.map),[gd.n*DRAW_STRIDE]);pass.setVertexBuffer(0,st.pos);pass.setVertexBuffer(1,st.nrm);pass.setVertexBuffer(2,st.uv);pass.setVertexBuffer(3,st.col);pass.setVertexBuffer(4,st.inst);pass.draw(st.count,1);}}}
  // sky AFTER the ground: it sits at the far plane (reverse-Z depth 0) with depthCompare 'equal', so early-Z shades only
  // the pixels no terrain covered (it used to shade the whole screen first and then get overdrawn)
  if(!DEF)seg('main: sky');pass.setPipeline(this.skyPipe);pass.setBindGroup(0,this.frameBG);if(!SK.sky)pass.draw(3);
  // opaque first (front-to-back-ish: ground last is fine with early-z), alpha-tested foliage after
  seg(useT?'main: objects (ball, club, flag, buildings)':'main: map view (course ground + overlays)');pass.setPipeline(this.meshPipeOpaque);
  // opaque objects, then (map view) the course ground mesh, alpha-tested, then blended overlays; one pass over the list each
  const ord=this._ord??=[];ord.length=0;if(!SK.mesh){if(!SK.objects)for(const x of draws)if(x.vis&&!x.alpha&&!x.ground&&!x.blend)ord.push(x);if(!SK.ground&&!useT)for(const x of draws)if(x.vis&&x.ground)ord.push(x);
   if(!SK.objects){for(const x of draws)if(x.vis&&x.alpha&&!x.blend)ord.push(x);for(const x of draws)if(x.vis&&x.blend)ord.push(x);}}
  let cur=this.meshPipeOpaque;
  for(const {m,g,n:i,map,alpha,blend,ground} of ord){const want=ground?this.groundPipesFor((this.effectMask||0)>>>0).sand:blend?this.meshPipeBlend:alpha?this.meshPipe:this.meshPipeOpaque;if(!want)continue;if(want!==cur){pass.setPipeline(want);cur=want;}pass.setBindGroup(1,this.matGroup(map),[i*DRAW_STRIDE]);pass.setVertexBuffer(0,g.pos);pass.setVertexBuffer(1,g.nrm);pass.setVertexBuffer(2,g.uv);pass.setVertexBuffer(3,g.col);const ib=this.instances(m),ic=this.inst.get(m).count;pass.setVertexBuffer(4,ib);
   if(g.index){pass.setIndexBuffer(g.index,g.indexFormat);pass.drawIndexed(g.count,ic);}else pass.draw(g.count,ic);}
  if(lines.length&&!SK.objects&&!SK.mesh)this.drawLines(pass,lines);
  seg('main: bunker lips',!SK.lip&&!!this.lipBuf&&!!this.lipCount&&useT&&vScale>.98);if(!SK.lip&&this.lipBuf&&this.lipCount&&useT&&vScale>.98){pass.setPipeline(this.lipPipe);pass.setBindGroup(0,this.frameBG);pass.setBindGroup(1,this.soilBG);pass.setVertexBuffer(0,this.lipBuf);pass.draw(this.lipCount);}
  seg('main: trees & foliage',!this.noFlora&&!SK.mesh&&!SK.flora&&!o.overview&&!o.courseView&&vScale>.98);if(!SK.mesh&&!SK.flora&&!o.overview&&!o.courseView&&vScale>.98)this.drawFlora(pass,null);
  seg('main: turf shells',!SK.turf&&grassOn&&!o.overview&&!!this.turfShells);if(!SK.turf&&grassOn&&!o.overview&&this.turfShells){if(this.turfFullWanted!=null&&this.turfFullWanted!==this.turfFull)this.buildTurf(this.turfFullWanted);pass.setBindGroup(0,this.frameBG);for(const t of this.turfPipes){pass.setPipeline(t.pipe);pass.draw(t.n,TURF_SHELLS);}}
  const grassHere=!SK.grass&&grassOn&&!o.overview&&!(DEF&&this.grassFirst);seg('main: grass blades',grassHere);if(grassHere)this.drawGrass(pass);
  let pass2=pass;
  if(!SK.ocean&&!o.courseView&&!o.overview&&agl<1200&&waterVis){pass.end();   // snapshot the opaque scene for the water's screen-space reflections
   {const q=enc.beginRenderPass({colorAttachments:[{view:this.hdrCopy.createView(),loadOp:'clear',clearValue:[0,0,0,1],storeOp:'store'}]});q.setPipeline(this.ssrColPipe);q.setBindGroup(0,this.ssrColBG??=d.createBindGroup({layout:this.ssrColPipe.getBindGroupLayout(0),entries:[{binding:0,resource:this.hdr.createView()},{binding:1,resource:this.clampSamp}]}));q.draw(3);q.end();}   // half-res copy for the reflections (a quarter of the copy traffic){const q=enc.beginRenderPass({colorAttachments:[{view:this.ssrDepth.createView(),loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'}]});q.setPipeline(this.ssrDepthPipe);q.setBindGroup(0,this.ssrDepthBG??=d.createBindGroup({layout:this.ssrDepthPipe.getBindGroupLayout(0),entries:[{binding:0,resource:this.depth.createView()}]}));q.draw(3);q.end();}
   this._lbl='ocean (surface + SSR)';pass2=enc.beginRenderPass({colorAttachments:[{view:this.hdr.createView(),loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:this.depth.createView(),depthLoadOp:'load',depthStoreOp:'store'}});
   pass2.setPipeline(this.oceanPipe);pass2.setBindGroup(0,this.frameBG);pass2.setBindGroup(1,this.oceanBGFor());
    // view sector of the outer rings (ocean.js vs): azimuth of the view +- (horizontal half-FOV, widened for pitch) + margin
    {const RINGS=224,SEGS=448,IN=64,fw=[-view[2],-view[6],-view[10]],hl=Math.hypot(fw[0],fw[2]);const halfV=(cam.fov||50)*Math.PI/360,halfH=Math.atan(Math.tan(halfV)*this.w/this.h);
     let s0=0,ns=SEGS;if(hl>.5){const half=Math.min(Math.PI,Math.atan(Math.tan(halfH)/Math.max(hl,.3))+.45);const az=Math.atan2(fw[2],fw[0]);ns=Math.min(SEGS,Math.ceil(half/Math.PI*SEGS)+4);s0=((Math.floor((az-half)/(2*Math.PI)*SEGS)-2)%SEGS+SEGS)%SEGS;}
     d.queue.writeBuffer(this.oceanU,16,new Float32Array([s0,ns,IN,0]));pass2.draw(SEGS*6,IN,0,0);pass2.draw(ns*6,RINGS-IN,0,IN);}}
  const tr=o.tracer;if(tr?.visible&&tr.geometry?.attributes?.ribbonTangent&&tr.material?.uniforms){const tg=this.tracerGeo(tr.geometry);if(tg){const u=tr.material.uniforms;const td=new Float32Array(40);td.set(view,0);td.set(proj,16);td.set([u.headDist.value,u.fade.value,this.h,0],32);const gc=u.glow.value;td.set([gc.r,gc.g,gc.b,1],36);d.queue.writeBuffer(this.tracerBuf,0,td);
   pass2.setPipeline(this.tracerPipe);pass2.setBindGroup(0,this.emptyBG);pass2.setBindGroup(1,this.tracerBG);pass2.setVertexBuffer(0,tg.pos);pass2.setVertexBuffer(1,tg.tan);pass2.setVertexBuffer(2,tg.side);pass2.setVertexBuffer(3,tg.arc);pass2.setIndexBuffer(tg.index,'uint32');pass2.drawIndexed(tg.count);}}
  pass2.end();
  {const sp=[cp.x+sd[0]/sl*1e4,cp.y+sd[1]/sl*1e4,cp.z+sd[2]/sl*1e4];const cx=vp[0]*sp[0]+vp[4]*sp[1]+vp[8]*sp[2]+vp[12],cy=vp[1]*sp[0]+vp[5]*sp[1]+vp[9]*sp[2]+vp[13],cw=vp[3]*sp[0]+vp[7]*sp[1]+vp[11]*sp[2]+vp[15];
   const ux=cx/cw*.5+.5,uy=.5-cy/cw*.5,vis=cw>0?Math.max(0,1-Math.max(Math.abs(ux-.5),Math.abs(uy-.5))*1.2)*Math.min(1,Math.max(0,(elev+.04)*8)):0;const sc=this.sunRGB||[1,1,1];
   const G=gradeAt(dayPos(o.lighting?.hour??12,o.sunWindow),this.gradeKeys||DEFAULT_KEYS);this.gradeNow=G;
   const sLum=.3*sc[0]+.5*sc[1]+.2*sc[2];const se=Math.max(elev,0);const E=sLum*(Math.sqrt(se)*.8+.2)+.9*Math.pow(Math.max(se+.06,.01),.9)*(this.twilight??1);const autoEx=1;d.queue.writeBuffer(this.postBuf,0,new Float32Array([exposure*.8*autoEx,G.vignette,G.saturation,time, ux,uy,vis,.45, sc[0],sc[1],sc[2],0, this.debugPost??0,(()=>{const ed=Math.asin(Math.max(-1,Math.min(1,elev)))*180/Math.PI;const ss=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t)};return ss(-6,2,ed)*(1-ss(2,26,ed))})(),this.taaOn?1:0,this.taaOn?(this.taaSharpen??.55):0, this.hdrOut?G.hdrHeadroom:1,0,0,0]));/* PU[3].y = golden-hour weight */
   {const wb=wbGains(G.temperature,G.tint);d.queue.writeBuffer(this.postBuf,80,new Float32Array([G.ev,0,0,0, G.hueBlend,G.contrast,0,G.shoulderKnee, G.blackPoint,G.gamma,0,G.whitePoint, wb[0],wb[1],wb[2],G.warmHighlights, 0,0,0,G.coolShadows, 1,0,G.liftMax,G.liftStrength, G.bloom,0,0,0]));}}
  // Sky detail costs nothing where it can't be seen: with no sky in view (every frustum edge ray points below the horizon) the
  // cloud deck is hidden and the shafts' in-scatter is bounded by (air density x longest ground ray x peak phase); under
  // ~0.15% of the sun's radiance (bound) the march, filter and composite are skipped.
  const volVisible=(()=>{if(elev<-.03&&this.noClouds)return false;const base=o.water?.level??0,S=[sd[0]/sl,sd[1]/sl,sd[2]/sl];let L=0,ph=0;
   const hg=(mu,g)=>(1-g*g)/(4*Math.PI*Math.pow(Math.max(1+g*g-2*g*mu,1e-4),1.5));
   for(const [x,y] of [[-1,-1],[1,-1],[-1,1],[1,1],[0,1],[0,-1],[-1,0],[1,0],[0,0]]){const m=ivp,X=m[0]*x+m[4]*y+m[8]*.5+m[12],Y=m[1]*x+m[5]*y+m[9]*.5+m[13],Z=m[2]*x+m[6]*y+m[10]*.5+m[14],W=m[3]*x+m[7]*y+m[11]*.5+m[15];
    let dx=X/W-cp.x,dy=Y/W-cp.y,dz=Z/W-cp.z;const n=Math.hypot(dx,dy,dz)||1;dx/=n;dy/=n;dz/=n;if(dy>-.01)return true;
    L=Math.max(L,Math.min(420,(cp.y-base)/-dy));const mu=dx*S[0]+dy*S[1]+dz*S[2];ph=Math.max(ph,(hg(mu,.78)*.7+hg(mu,.2)*.3)*4*Math.PI);}
   const b=L*1.26e-4*ph*1.5*.09;const t=Math.min(1,Math.max(0,(b-1.5e-3)/3e-3));   /* the bound runs ~50x above the measured shafts (turf close-up at b = 3e-4 changes the frame by 0.03/255) */return t*t*(3-2*t);})();   /* faded, not popped, as the view turns */
  const volK=this.volForce??volVisible;this.volVisible=volVisible;if(!o.overview&&!SK.vol&&volK>0){const volFold=!this.taaOn&&!this.noVolFold;this.dev.queue.writeBuffer(this.compU,0,new Float32Array([volK===true?1:volK,volFold?1:0,0,0]));const vi=this.volPing=1-(this.volPing||0);{const u=new Float32Array(20);u.set(this.volPrevVP||vp,0);u.set([(this.volPhase=((this.volPhase??-1)+7)%16),this.volReset||this.volFull||!this.volPrevVP||this.volSkipped?1:0,0,0],16);this.dev.queue.writeBuffer(this.volU,0,u);}this.volReset=false;this.volSkipped=false;this.volPrevVP=vp.slice();
   this._lbl='volumetrics: clouds + light shafts';const vp2=enc.beginRenderPass({colorAttachments:[{view:this.volRaysP[vi].createView(),loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'},{view:this.volCloudP[vi].createView(),loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'}]});
   vp2.setPipeline(this.volPipe);vp2.setBindGroup(0,this.frameBG);vp2.setBindGroup(1,this.volBGP[vi]);vp2.draw(3);vp2.end();
   this._lbl='volumetrics: filter';{const fp=enc.beginRenderPass({colorAttachments:[this.volRaysF,this.volCloudF].map(t=>({view:t.createView(),loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'}))});fp.setPipeline(this.volFiltPipe);fp.setBindGroup(0,this.filtBGP[vi]);fp.draw(3);fp.end();}
   /* without TAA the composite is folded into the post pass (and bloom's first step): one less full-resolution load/store of
       the HDR frame. With TAA it must land before the resolve, so it keeps its own pass. */
    if(!volFold){this._lbl='volumetrics: composite';const cp2=enc.beginRenderPass({colorAttachments:[{view:this.hdr.createView(),loadOp:'load',storeOp:'store'}]});cp2.setPipeline(this.compPipe);cp2.setBindGroup(0,this.compBG);cp2.draw(3);cp2.end();}}else{this.volSkipped=true;this.dev.queue.writeBuffer(this.compU,0,new Float32Array([0,0,0,0]));}   // history is stale after a skipped frame
  if(this.taaOn&&this.taaOut){const tb=new Float32Array(44);tb.set([this.taaKernel??3.2,0,0,0],40);tb.set(ivp,0);tb.set(this.prevVPu||vpU,16);tb.set([this.w,this.h,this.ow,this.oh],32);tb.set([-jx,jy,(this.taaReset||!this.prevVPu)?1:0,this.taaGamma??1.1],36);d.queue.writeBuffer(this.taaU,0,tb);this.taaReset=false;
   this.taaPing=1-(this.taaPing||0);const pi=this.taaPing;
   this._lbl='TAAU';const tp=enc.beginRenderPass({colorAttachments:[{view:this.taaTex[pi].createView(),loadOp:'clear',clearValue:[0,0,0,1],storeOp:'store'}]});tp.setPipeline(this.taaPipe);tp.setBindGroup(0,this.taaBGs[pi]);tp.draw(3);tp.end();}
  this.prevVPu=vpU;
  // (no auto exposure: the EXPO metering pass was removed; brightness is the keyframed grade EV)
  this._lbl='bloom';for(const st of (SK.bloom?[]:this.bloomSteps)){const bp=enc.beginRenderPass({colorAttachments:[{view:st.target,loadOp:st.load,clearValue:[0,0,0,1],storeOp:'store'}]});bp.setPipeline(st.pipe);bp.setBindGroup(0,(st.bg1&&this.taaPing===1)?st.bg1:st.bg);bp.draw(3);bp.end();}
  this._lbl='local exposure (luma)';{const lp=enc.beginRenderPass({colorAttachments:[{view:this.lumTex.createView(),loadOp:'clear',clearValue:[0,0,0,1],storeOp:'store'}]});lp.setPipeline(this.lumaPipe);lp.setBindGroup(0,(this.lumaBG1&&this.taaOn&&this.taaPing===1)?this.lumaBG1:this.lumaBG);lp.draw(3);lp.end();}
  this._lbl='post (tone map, grade, CAS, FXAA)';const out=enc.beginRenderPass({colorAttachments:[{view:this.ctx.getCurrentTexture().createView(),loadOp:'clear',clearValue:[0,0,0,1],storeOp:'store'}]});out.setPipeline(this.hdrOut?this.postPipeHDR:this.postPipe);out.setBindGroup(0,(this.postGroup1&&this.taaOn&&this.taaPing===1)?this.postGroup1:this.postGroup);out.draw(3);out.end();
  // benchmark ballast (__r.gpu.benchLoad = ALU iterations per pixel): a fixed fragment load at the END of the frame that keeps the
  // GPU at full clocks, so per-pass timings are comparable between light and heavy settings (Apple GPUs down-clock hard when a
  // frame has slack, which inflates every pass's milliseconds). Excluded from the pass list.
  if(this.benchLoad>0){if(!this.benchPipe){const m=d.createShaderModule({code:`@group(0) @binding(0) var<uniform> U:vec4f;@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let q=vec2f(f32((i<<1u)&2u),f32(i&2u));return vec4f(q*2.-1.,0.,1.);}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{var x=fract(p.x*.013+p.y*.007);for(var i=0;i<i32(U.x);i++){x=fract(sin(x*12.9898+f32(i))*43758.5);}return vec4f(x);}`});
    this.benchPipe=d.createRenderPipeline({layout:'auto',vertex:{module:m,entryPoint:'vs'},fragment:{module:m,entryPoint:'fs',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list'}});this.benchU=d.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.benchBG=d.createBindGroup({layout:this.benchPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.benchU}}]});this.benchTex=d.createTexture({size:[512,512],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT});}
   d.queue.writeBuffer(this.benchU,0,new Float32Array([this.benchLoad,0,0,0]));this._lbl='benchmark ballast (excluded)';const bp=enc.beginRenderPass({colorAttachments:[{view:this.benchTex.createView(),loadOp:'clear',storeOp:'store'}]});bp.setPipeline(this.benchPipe);bp.setBindGroup(0,this.benchBG);bp.draw(3);bp.end();}
  const c3=performance.now();if(T)T.end(enc);
  if(this.debugCount&&!this.readPending){this.readBuf??=d.createBuffer({size:48,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});enc.copyBufferToBuffer(this.counter,0,this.readBuf,0,48);this.readPending=true;d.queue.submit([enc.finish()]);this.readBuf.mapAsync(GPUMapMode.READ).then(()=>{{const u=new Uint32Array(this.readBuf.getMappedRange());this.bladeCountNow=u[0];this.bladeCounts={near:u[1],mid:u[3],far:u[9]};}this.readBuf.unmap();this.readPending=false;});}
  else d.queue.submit([enc.finish()]);if(T)T.afterSubmit();
  {const c4=performance.now(),a=.1,C=this.cpuT??={};const put=(k,v)=>{C[k]=C[k]==null?v:C[k]*(1-a)+v*a};put('sync scene / flora LOD',c1-c0);put('uniforms + draw list',c2-c1);put('encode passes',c3-c2);put('submit',c4-c3);put('total',c4-c0);}
  this.stats={draws:draws.length};this.frameCount=(this.frameCount||0)+1;}
 tracerGeo(geo){if(this.trGeoSrc===geo)return this.trGeo;this.trGeo?.destroy();const d=this.dev,a=geo.attributes;const buf=(arr,u)=>{const b=d.createBuffer({size:Math.max(16,arr.byteLength),usage:u|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(b,0,arr);return b;};
  const idx=Uint32Array.from(geo.index.array);const g={pos:buf(new Float32Array(a.position.array),GPUBufferUsage.VERTEX),tan:buf(new Float32Array(a.ribbonTangent.array),GPUBufferUsage.VERTEX),side:buf(new Float32Array(a.side.array),GPUBufferUsage.VERTEX),arc:buf(new Float32Array(a.arcDist.array),GPUBufferUsage.VERTEX),index:buf(idx,GPUBufferUsage.INDEX),count:idx.length};
  g.destroy=()=>{for(const k of ['pos','tan','side','arc','index'])g[k].destroy();};this.trGeoSrc=geo;this.trGeo=g;return g;}
 matGroup(tex){const key=tex||this.white;this.matGroups??=new WeakMap();let g=this.matGroups.get(key);if(!g){g=this.dev.createBindGroup({layout:this.matBGL,entries:[{binding:0,resource:{buffer:this.drawBuf,size:128}},{binding:1,resource:key.createView()}]});this.matGroups.set(key,g);}return g;}
 // the blade draw lists (near per-pixel, near per-vertex, mid, far); grassSkip bits (debug) skip lists by index
 drawGrass(pass){const gs=this.grassSkip|0;const BG=[this.grassRS,this.grassRSFar,this.grassRSFar2,this.grassRS];this.grassLOD.forEach((L,i)=>{if(gs&(1<<i))return;pass.setPipeline(L.pipe);pass.setBindGroup(1,BG[L.list]);pass.setIndexBuffer(L.ib,'uint32');pass.drawIndexedIndirect(this.indirect,i*20);});}
 bladeCount(){return this.lastBlades;}
}
