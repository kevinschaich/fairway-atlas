// Terrain: CDLOD quadtree over a cached height/normal clipmap (the approach of Unreal's landscape / Far Cry / CDLOD).
//
//  Height cache ("clipmap"): CM_L nested camera-centred windows of CM_N x CM_N samples. Level l samples the finished ground
//  surface (bicubic height + course relief - bunker sink - seabed drop, i.e. exactly what the old camera grid computed per
//  vertex) on the world lattice x = i * T0 * 2^l, stored toroidally (lattice i lives in texel i mod CM_N). When the camera
//  moves, only the newly exposed rows/columns are recomputed; while it is still, nothing is. Normals are central differences
//  of the cached heights, in a filterable texture so the pixel shader reads the exact surface normal with one tap.
//
//  Geometry: one shared P x P patch (and a P/2 half patch for quarter nodes), instanced over the quadtree nodes selected for
//  this view: fine near the camera, doubling in spacing with distance (LOD k covers up to R0 * 2^k metres), frustum-culled
//  against per-node height bounds, drawn front to back. Vertices geo-morph to the next LOD's lattice before the LOD boundary,
//  so there are no cracks and no popping. Every vertex reads its height from the cache (bilinear of 4 loads), and lattice
//  points are exact samples in every level, so neighbouring nodes always agree.
//
//  Nodes that contain no new-engine bunker use a pipeline compiled without the bunker-outline discard (discard switches off
//  the GPU's hidden-surface removal / early depth for the whole draw). Nodes entirely under the sea use a pipeline that
//  shades them as flat deep water at once (material LOD) instead of running the ground material.
import {FRAME,COMMON} from './shaders-common.js';

export const CM_N=512,CM_L=7,CM_T0=.125,PATCH=32,LEAF=PATCH*CM_T0,CM_SNAP=16;
const MAX_NODES=4096;

const GEN_HEAD=FRAME+COMMON+/*wgsl*/`
struct Reg{o:vec4i,w:vec4i,t:vec4f}   // o: region x0,z0,w,h (lattice); w: window x0,z0,level; t.x: texel size (m)
@group(1) @binding(0) var<uniform> R:Reg;
`;
export const CM_GENH=GEN_HEAD+/*wgsl*/`
@group(1) @binding(1) var outH:texture_storage_2d_array<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(i32(id.x)>=R.o.z||i32(id.y)>=R.o.w){return;}
 let li=R.o.xy+vec2i(id.xy);let xz=vec2f(li)*R.t.x;let h=groundH(xz)-bunkerSink(xz)-seabedDrop(xz);
 textureStore(outH,cmWrap(li),R.w.z,vec4f(h,0.,0.,0.));}
`;
export const CM_GENN=GEN_HEAD+/*wgsl*/`
@group(1) @binding(1) var inH:texture_2d_array<f32>;
@group(1) @binding(2) var outN:texture_storage_2d_array<rgba16float,write>;
fn hAt(li:vec2i)->f32{let c=clamp(li,R.w.xy,R.w.xy+vec2i(CM_N-1));return textureLoad(inH,cmWrap(c),R.w.z,0).r;}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(i32(id.x)>=R.o.z||i32(id.y)>=R.o.w){return;}
 let li=R.o.xy+vec2i(id.xy);let t=R.t.x;
 let n=normalize(vec3f(hAt(li-vec2i(1,0))-hAt(li+vec2i(1,0)),2.*t,hAt(li-vec2i(0,1))-hAt(li+vec2i(0,1))));
 textureStore(outN,cmWrap(li),R.w.z,vec4f(n,0.));}
`;

export class Terrain{
 constructor(dev){this.dev=dev;const U=GPUTextureUsage;
  this.hTex=dev.createTexture({label:'terrain height cache',size:[CM_N,CM_N,CM_L],format:'r32float',usage:U.STORAGE_BINDING|U.TEXTURE_BINDING});
  this.nTex=dev.createTexture({label:'terrain normal cache',size:[CM_N,CM_N,CM_L],format:'rgba16float',usage:U.STORAGE_BINDING|U.TEXTURE_BINDING});
  this.dummyH=dev.createTexture({size:[1,1,1],format:'r32float',usage:U.TEXTURE_BINDING});
  this.dummyN=dev.createTexture({size:[1,1,1],format:'rgba16float',usage:U.TEXTURE_BINDING});
  this.win=Array.from({length:CM_L},()=>({x:0,z:0,valid:false}));this.key=null;this.R0=16;this.regions=[];
  this.regBuf=dev.createBuffer({label:'terrain cache regions',size:256*64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  // patches: grid coords only (x,z in 0..P); the vertex shader places them
  const mk=(arr,u)=>{const b=dev.createBuffer({size:arr.byteLength,usage:u|GPUBufferUsage.COPY_DST});dev.queue.writeBuffer(b,0,arr);return b;};
  const patch=P=>{const v=new Float32Array((P+1)*(P+1)*2);for(let j=0;j<=P;j++)for(let i=0;i<=P;i++){const k=j*(P+1)+i;v[k*2]=i;v[k*2+1]=j;}
   const idx=new Uint16Array(P*P*6);let q=0;for(let j=0;j<P;j++)for(let i=0;i<P;i++){const a=j*(P+1)+i,b=a+1,c=a+P+1,e=c+1;idx.set([a,c,b,b,c,e],q);q+=6;}   /* one diagonal direction everywhere: a fully morphed 2x2 block collapses to exactly the next LOD's quad */
   return {pos:mk(v,GPUBufferUsage.VERTEX),index:mk(idx,GPUBufferUsage.INDEX),count:idx.length};};
  this.full=patch(PATCH);this.half=patch(PATCH/2);
  this.instBuf=dev.createBuffer({label:'terrain nodes',size:MAX_NODES*16,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});this.instData=new Float32Array(MAX_NODES*4);
  this.stats={nodes:0,tris:0,cacheTexels:0};}
 // compute pipelines (need the frame bind group layout from the backend)
 build(frameLayout,mod){const d=this.dev;
  this.ghL=d.createBindGroupLayout({entries:[{binding:0,visibility:4,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:48}},{binding:1,visibility:4,storageTexture:{access:'write-only',format:'r32float',viewDimension:'2d-array'}}]});
  this.gnL=d.createBindGroupLayout({entries:[{binding:0,visibility:4,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:48}},{binding:1,visibility:4,texture:{sampleType:'unfilterable-float',viewDimension:'2d-array'}},{binding:2,visibility:4,storageTexture:{access:'write-only',format:'rgba16float',viewDimension:'2d-array'}}]});
  this.genH=d.createComputePipeline({layout:d.createPipelineLayout({bindGroupLayouts:[frameLayout,this.ghL]}),compute:{module:mod(CM_GENH),entryPoint:'main'}});
  this.genN=d.createComputePipeline({layout:d.createPipelineLayout({bindGroupLayouts:[frameLayout,this.gnL]}),compute:{module:mod(CM_GENN),entryPoint:'main'}});
  const hv=this.hTex.createView({dimension:'2d-array'}),nv=this.nTex.createView({dimension:'2d-array'});
  this.ghBG=d.createBindGroup({layout:this.ghL,entries:[{binding:0,resource:{buffer:this.regBuf,size:48}},{binding:1,resource:hv}]});
  this.gnBG=d.createBindGroup({layout:this.gnL,entries:[{binding:0,resource:{buffer:this.regBuf,size:48}},{binding:1,resource:hv},{binding:2,resource:nv}]});}
 // --- height cache windows: call once per frame before the frame uniforms are written; fills F.clip (32 floats)
 plan(cam,key,out,vScale=1){this.regions=[];if(key!==this.key){this.key=key;for(const w of this.win)w.valid=false;}
  for(let l=0;l<CM_L;l++){const t=CM_T0*2**l,w=this.win[l];const nx=Math.round((cam.x/t-CM_N/2)/CM_SNAP)*CM_SNAP,nz=Math.round((cam.z/t-CM_N/2)/CM_SNAP)*CM_SNAP;
   if(!w.valid||Math.abs(nx-w.x)>=CM_N||Math.abs(nz-w.z)>=CM_N)this.regions.push([l,nx,nz,CM_N,CM_N,nx,nz]);
   else{const dx=nx-w.x,dz=nz-w.z;
    if(dx)this.regions.push([l,dx>0?w.x+CM_N:nx,nz,Math.abs(dx),CM_N,nx,nz]);
    if(dz)this.regions.push([l,nx,dz>0?w.z+CM_N:nz,CM_N,Math.abs(dz),nx,nz]);}
   w.x=nx;w.z=nz;w.valid=true;out.set([nx,nz,t,1],l*4);}
  out.set([CM_N,CM_L,this.R0,vScale],28);return this.regions.length;}
 // record the cache updates for this frame's regions (heights, then normals over the region grown by one texel)
 encode(enc,frameBG){if(!this.regions.length)return;const R=this.regions.slice(0,32),d=this.dev,data=new ArrayBuffer(R.length*2*256);let texels=0;
  R.forEach(([l,x0,z0,w,h,wx,wz],i)=>{const t=CM_T0*2**l;const put=(slot,ox,oz,ow,oh)=>{const b=slot*256;new Int32Array(data,b,8).set([ox,oz,ow,oh,wx,wz,l,0]);new Float32Array(data,b+32,4).set([t,0,0,0]);};
   put(i*2,x0,z0,w,h);const gx0=Math.max(wx,x0-1),gz0=Math.max(wz,z0-1),gx1=Math.min(wx+CM_N,x0+w+1),gz1=Math.min(wz+CM_N,z0+h+1);put(i*2+1,gx0,gz0,gx1-gx0,gz1-gz0);texels+=w*h;});
  d.queue.writeBuffer(this.regBuf,0,data);
  const cp=enc.beginComputePass();cp.setBindGroup(0,frameBG);cp.setPipeline(this.genH);
  R.forEach(([,, ,w,h],i)=>{cp.setBindGroup(1,this.ghBG,[i*2*256]);cp.dispatchWorkgroups(Math.ceil(w/8),Math.ceil(h/8));});cp.end();
  const cn=enc.beginComputePass();cn.setBindGroup(0,frameBG);cn.setPipeline(this.genN);
  R.forEach(([,, ,w,h],i)=>{cn.setBindGroup(1,this.gnBG,[(i*2+1)*256]);cn.dispatchWorkgroups(Math.ceil((w+2)/8),Math.ceil((h+2)/8));});cn.end();
  this.stats.cacheTexels=texels;}
 // --- per-node height bounds (for frustum culling): 16 m cells over the quadtree root, min/max pyramid
 setWorld(box,elev){const root=LEAF*2**Math.ceil(Math.log2(box.size/LEAF+1));const al=CM_T0*2**Math.round(Math.log2(root/LEAF));   /* root aligned to its coarsest vertex spacing */
  this.box=box;this.root={x:Math.floor(box.x/al)*al,z:Math.floor(box.z/al)*al,size:root};this.D=Math.round(Math.log2(root/LEAF));
  if(this.root.x+root<box.x+box.size||this.root.z+root<box.z+box.size){this.root.size*=2;this.D++;}
  const C=16,n=Math.ceil(this.root.size/C),S=new Float32Array((n+1)*(n+1));for(let j=0;j<=n;j++)for(let i=0;i<=n;i++){let h=0;try{h=elev(this.root.x+i*C,this.root.z+j*C)}catch{}S[j*(n+1)+i]=isFinite(h)?h:0;}
  const lv=[];let mn=new Float32Array(n*n),mx=new Float32Array(n*n);for(let j=0;j<n;j++)for(let i=0;i<n;i++){const a=S[j*(n+1)+i],b=S[j*(n+1)+i+1],c=S[(j+1)*(n+1)+i],e=S[(j+1)*(n+1)+i+1];mn[j*n+i]=Math.min(a,b,c,e)-8;mx[j*n+i]=Math.max(a,b,c,e)+4;}
  lv.push({n,mn,mx,C});let m=n;while(m>1){const k=m>>1,a=lv[lv.length-1],mn2=new Float32Array(k*k),mx2=new Float32Array(k*k);
   for(let j=0;j<k;j++)for(let i=0;i<k;i++){let lo=1e9,hi=-1e9;for(const [di,dj] of [[0,0],[1,0],[0,1],[1,1]]){const q=(j*2+dj)*m+i*2+di;lo=Math.min(lo,a.mn[q]);hi=Math.max(hi,a.mx[q]);}mn2[j*k+i]=lo;mx2[j*k+i]=hi;}
   lv.push({n:k,mn:mn2,mx:mx2,C:a.C*2});m=k;}
  this.mm=lv;
  // unpadded 8 m maximum of the source ground (before the seabed drop), for "entirely under the sea" nodes
  {const C2=8,n2=Math.ceil(this.root.size/C2),Q=new Float32Array((n2+1)*(n2+1));for(let j=0;j<=n2;j++)for(let i=0;i<=n2;i++){let h=0;try{h=elev(this.root.x+i*C2,this.root.z+j*C2)}catch{}Q[j*(n2+1)+i]=isFinite(h)?h:1e9;}
   let m2=n2,mx=new Float32Array(n2*n2);for(let j=0;j<n2;j++)for(let i=0;i<n2;i++)mx[j*n2+i]=Math.max(Q[j*(n2+1)+i],Q[j*(n2+1)+i+1],Q[(j+1)*(n2+1)+i],Q[(j+1)*(n2+1)+i+1]);
   const rl=[{n:n2,mx,C:C2}];while(m2>1){const k=m2>>1,a=rl[rl.length-1],o=new Float32Array(k*k);for(let j=0;j<k;j++)for(let i=0;i<k;i++)o[j*k+i]=Math.max(a.mx[(j*2)*m2+i*2],a.mx[(j*2)*m2+i*2+1],a.mx[(j*2+1)*m2+i*2],a.mx[(j*2+1)*m2+i*2+1]);rl.push({n:k,mx:o,C:a.C*2});m2=k;}
   this.rawMax=rl;}}
 // true when every point of the node lies in the sea: its ground sits below sea level + 0.2 m, so the engine drops it to the
 // sea floor and shades it as flat deep water (the cheap SEA pipeline), 0.3 m margin for relief between the 8 m samples
 // mapped water (kind raster, 1 = water) as a summed-area table of NON-water texels: a node is inside water when its
 // rectangle grown by 3 m holds none (the ground shader's water mask is fully saturated there)
 setWater(kinds,N,box,code){const W=N+1,t=new Uint32Array(W*W);for(let z=0;z<N;z++){let r=0;for(let x=0;x<N;x++){r+=kinds[z*N+x]===code?0:1;t[(z+1)*W+x+1]=t[z*W+x+1]+r;}}this.wsat={t,N,box};}
 allWater(x,z,size){const w=this.wsat;if(!w)return false;const k=w.N/w.box.size,m=3;
  const x0=Math.floor((x-m-w.box.x)*k),z0=Math.floor((z-m-w.box.z)*k),x1=Math.ceil((x+size+m-w.box.x)*k),z1=Math.ceil((z+size+m-w.box.z)*k);if(x0<0||z0<0||x1>w.N||z1>w.N)return false;
  const W=w.N+1;return w.t[z1*W+x1]-w.t[z0*W+x1]-w.t[z1*W+x0]+w.t[z0*W+x0]===0;}
 submerged(x,z,size,level){if(level!=null&&this.allWater(x,z,size))return true;const lv=this.rawMax;if(!lv||level==null)return false;let k=0;while(k<lv.length-1&&lv[k].C<size)k++;const L=lv[k];
  const i0=Math.max(0,Math.floor((x-this.root.x)/L.C)),j0=Math.max(0,Math.floor((z-this.root.z)/L.C)),i1=Math.min(L.n-1,Math.floor((x+size-1e-3-this.root.x)/L.C)),j1=Math.min(L.n-1,Math.floor((z+size-1e-3-this.root.z)/L.C));
  for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++)if(L.mx[j*L.n+i]>=level-.1)return false;return true;}
 bounds(x,z,size){const lv=this.mm;if(!lv)return [-50,300];let k=0;while(k<lv.length-1&&lv[k].C<size)k++;const L=lv[k];
  const i0=Math.max(0,Math.floor((x-this.root.x)/L.C)),j0=Math.max(0,Math.floor((z-this.root.z)/L.C)),i1=Math.min(L.n-1,Math.floor((x+size-1e-3-this.root.x)/L.C)),j1=Math.min(L.n-1,Math.floor((z+size-1e-3-this.root.z)/L.C));
  let lo=1e9,hi=-1e9;for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){lo=Math.min(lo,L.mn[j*L.n+i]);hi=Math.max(hi,L.mx[j*L.n+i]);}return lo>hi?[-50,300]:[lo,hi];}
 // new-engine bunker footprint (sand triangle vertices), 2 m cells over the hole box, as a summed-area table
 setBunkers(pos,maskBox){this.bk=null;if(!pos||!maskBox)return;const C=2,n=Math.ceil(maskBox[2]/C)+2,g=new Uint8Array(n*n);
  for(let i=0;i<pos.length;i+=3){const cx=Math.floor((pos[i]-maskBox[0])/C),cz=Math.floor((pos[i+2]-maskBox[1])/C);for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++){const x=cx+dx,z=cz+dz;if(x>=0&&z>=0&&x<n&&z<n)g[z*n+x]=1;}}
  const s=new Uint32Array((n+1)*(n+1));for(let z=0;z<n;z++){let r=0;for(let x=0;x<n;x++){r+=g[z*n+x];s[(z+1)*(n+1)+x+1]=s[z*(n+1)+x+1]+r;}}
  this.bk={s,n,C,x:maskBox[0],z:maskBox[1]};}
 hasBunker(x,z,size){const b=this.bk;if(!b)return false;const x0=Math.max(0,Math.floor((x-b.x)/b.C)),z0=Math.max(0,Math.floor((z-b.z)/b.C)),x1=Math.min(b.n,Math.ceil((x+size-b.x)/b.C)),z1=Math.min(b.n,Math.ceil((z+size-b.z)/b.C));
  if(x1<=x0||z1<=z0)return false;const W=b.n+1;return b.s[z1*W+x1]-b.s[z0*W+x1]-b.s[z1*W+x0]+b.s[z0*W+x0]>0;}
 // --- CDLOD node selection for this view. planes: 6 inward frustum planes (24 floats). Writes the instance buffer, grouped
 // [no-discard full/half, bunker-cut full/half, sea full/half], each sorted front to back.
 select(cam,planes,vScale=1,sea=null,drawSea=true){const out=[[],[],[],[],[],[]];if(!this.root)return this.groups=[0,0,0,0,0,0];const R0=this.R0,box=this.box,bx1=box.x+box.size,bz1=box.z+box.size;
  const range=k=>R0*2**k;
  const sph=(r,x0,y0,z0,x1,y1,z1)=>{const dx=Math.max(x0-cam.x,0,cam.x-x1),dy=Math.max(y0-cam.y,0,cam.y-y1),dz=Math.max(z0-cam.z,0,cam.z-z1);return dx*dx+dy*dy+dz*dz<=r*r;};
  const vis=(x0,y0,z0,x1,y1,z1)=>{for(let i=0;i<6;i++){const a=planes[i*4],b=planes[i*4+1],c=planes[i*4+2],d=planes[i*4+3];if(a*(a>0?x1:x0)+b*(b>0?y1:y0)+c*(c>0?z1:z0)+d<0)return false;}return true;};
  const add=(x,z,size,lod,half)=>{const g=vScale>.98&&this.submerged(x,z,size,sea)?4:this.hasBunker(x,z,size)?2:0;if(g===4&&!drawSea)return;   /* under the drawn ocean surface: nothing of it can show */const dx=x+size/2-cam.x,dz=z+size/2-cam.z;out[g+(half?1:0)].push([x,z,size/(half?PATCH/2:PATCH),lod,dx*dx+dz*dz]);};
  const rec=(x,z,size,lod)=>{if(x>=bx1||z>=bz1||x+size<=box.x||z+size<=box.z)return true;let [y0,y1]=this.bounds(x,z,size);if(vScale!==1){y0=Math.min(y0,y0*vScale);y1=Math.max(y1,y1*vScale);}
   if(!sph(range(lod),x,y0,z,x+size,y1,z+size))return false;
   if(!vis(x,y0,z,x+size,y1,z+size))return true;
   if(lod===0||!sph(range(lod-1),x,y0,z,x+size,y1,z+size)){add(x,z,size,lod,false);return true;}
   const h=size/2;for(const [cx,cz] of [[x,z],[x+h,z],[x,z+h],[x+h,z+h]])if(!rec(cx,cz,h,lod-1)&&cx<bx1&&cz<bz1&&cx+h>box.x&&cz+h>box.z){let [q0,q1]=this.bounds(cx,cz,h);if(vScale!==1){q0=Math.min(q0,q0*vScale);q1=Math.max(q1,q1*vScale);}if(vis(cx,q0,cz,cx+h,q1,cz+h))add(cx,cz,h,lod,true);}return true;};   /* quarter drawn at this LOD: culled on its own bounds */
  if(!rec(this.root.x,this.root.z,this.root.size,this.D))add(this.root.x,this.root.z,this.root.size,this.D,false);
  let n=0;const dt=this.instData;this.groups=out.map(g=>{g.sort((a,b)=>a[4]-b[4]);let c=0;for(const e of g){if(n>=MAX_NODES)break;dt.set([e[0],e[1],e[2],e[3]],n*4);n++;c++;}return c;});
  this.dev.queue.writeBuffer(this.instBuf,0,dt.buffer,0,Math.max(1,n)*16);
  this.stats.nodes=n;this.stats.tris=(this.groups[0]+this.groups[2]+this.groups[4])*this.full.count/3+(this.groups[1]+this.groups[3]+this.groups[5])*this.half.count/3;this.stats.sea=this.groups[4]+this.groups[5];return this.groups;}
 // draw with the pipeline pair [no-discard, discard]; bind groups already set by the caller
 draw(pass,pipes){let first=0;const G=this.groups||[0,0,0,0,0,0];pass.setVertexBuffer(1,this.instBuf);
  for(let g=0;g<6;g++){const n=G[g];if(n){const p=g&1?this.half:this.full;pass.setPipeline(pipes[g>>1]);pass.setVertexBuffer(0,p.pos);pass.setIndexBuffer(p.index,'uint16');pass.drawIndexed(p.count,n,0,0,first);}first+=n;}}
}
