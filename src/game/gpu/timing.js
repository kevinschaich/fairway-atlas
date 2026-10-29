// Perf instrumentation for the WebGPU engine (bottom-right perf HUD > "Detailed timing").
//  - GpuTimer: timestamp queries around every render/compute pass (needs the 'timestamp-query' feature). Results are
//    read back asynchronously (ring of 3 readback buffers, never stalls the frame) and smoothed.
//  - GpuMemory: wraps device.createTexture / createBuffer to keep a live tally of GPU memory by creation site, so
//    textures or buffers that outlive their effect show up.
export class GpuTimer{
 constructor(dev,max=96){this.dev=dev;this.max=max;this.qs=dev.createQuerySet({type:'timestamp',count:max*2});
  this.resolveBuf=dev.createBuffer({size:max*16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
  this.reads=[0,1,2].map(()=>({buf:dev.createBuffer({size:max*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),busy:false,labels:null}));
  this.labels=[];this.avg={};this.raw=[];this.rawN=0;this.span=0;this.sum=0;this.pending=null;}
 begin(){this.labels=[];}
 // timestampWrites for one pass (undefined once the query set is full)
 tw(label){if(this.labels.length>=this.max)return undefined;const i=this.labels.length;this.labels.push(label);return {querySet:this.qs,beginningOfPassWriteIndex:i*2,endOfPassWriteIndex:i*2+1};}
 end(enc){const n=this.labels.length;this.pending=null;if(!n)return;const r=this.reads.find(x=>!x.busy);if(!r)return;
  enc.resolveQuerySet(this.qs,0,n*2,this.resolveBuf,0);enc.copyBufferToBuffer(this.resolveBuf,0,r.buf,0,n*16);r.busy=true;r.labels=this.labels.slice();r.tag=this.tag;this.pending=r;}
 afterSubmit(){const r=this.pending;if(!r)return;this.pending=null;
  r.buf.mapAsync(GPUMapMode.READ).then(()=>{const t=new BigInt64Array(r.buf.getMappedRange());const cur={};let first=null,last=null,sum=0;
   // Tile-based GPUs (Apple) overlap consecutive passes, so raw begin->end durations add up to several times the frame.
   // Attribute time exclusively instead: walk the passes in order of completion and give each only the time since the
   // previous pass finished (or since its own start, if the GPU was idle in between). The parts then sum to the span.
   const ev=[];for(let i=0;i<r.labels.length;i++){const b=t[i*2],e=t[i*2+1];if(b<=0n||e<=0n||e<b)continue;ev.push({l:r.labels[i],b,e});if(first===null||b<first)first=b;if(last===null||e>last)last=e;}
   ev.sort((x,y)=>(x.e<y.e?-1:x.e>y.e?1:0));let prev=null;
   for(const x of ev){const st=prev!==null&&prev>x.b?prev:x.b;const ms=Number(x.e-st)/1e6;cur[x.l]=(cur[x.l]||0)+ms;sum+=ms;prev=x.e;}
   r.buf.unmap();r.busy=false;const a=.12;
   for(const k in cur)this.avg[k]=this.avg[k]==null?cur[k]:this.avg[k]*(1-a)+cur[k]*a;for(const k in this.avg)if(!(k in cur)&&!k.startsWith('probe:')){this.avg[k]*=1-a;if(this.avg[k]<.001)delete this.avg[k];}   /* probes run on some frames only: keep their average between samples */
   if(first!==null){const sp=Number(last-first)/1e6;this.raw.push({cur,span:sp,tag:r.tag});if(this.raw.length>600)this.raw.splice(0,this.raw.length-600);this.rawN++;this.span=this.span?this.span*(1-a)+sp*a:sp;this.sum=this.sum?this.sum*(1-a)+sum*a:sum;}}).catch(()=>{r.busy=false;});}
}

const BPP={r8unorm:1,rg8unorm:2,rgba8unorm:4,'rgba8unorm-srgb':4,bgra8unorm:4,'bgra8unorm-srgb':4,r16float:2,rg16float:4,rgba16float:8,r32float:4,rg32float:8,rgba32float:16,depth32float:4,depth24plus:4,'depth24plus-stencil8':4,r32uint:4,rgba32uint:16,rg11b10ufloat:4};
export class GpuMemory{
 constructor(dev){this.live=new Map();this.byKey=new Map();
  const site=()=>{const s=(new Error().stack||'').split('\n').slice(3).find(l=>!/timing\.js/.test(l))||'';const m=s.match(/(?:at\s+)?([\w$.<>]*)\s*\(?[^()]*\/([\w.-]+\.js):(\d+)/);return m?`${m[2]}:${m[3]}${m[1]&&m[1]!=='at'?' '+m[1]:''}`:'unknown'};
  const add=(obj,bytes,kind,label)=>{const key=(label?label+' · ':'')+kind+' @ '+site();this.live.set(obj,{bytes,key});const e=this.byKey.get(key)||{bytes:0,count:0};e.bytes+=bytes;e.count++;this.byKey.set(key,e);
   const d0=obj.destroy.bind(obj);obj.destroy=()=>{const r=this.live.get(obj);if(r){this.live.delete(obj);const e2=this.byKey.get(r.key);if(e2){e2.bytes-=r.bytes;e2.count--;if(e2.count<=0)this.byKey.delete(r.key);}}return d0();};};
  const ct=dev.createTexture.bind(dev);dev.createTexture=(desc)=>{const t=ct(desc);try{const s=desc.size,w=s.width??s[0],h=s.height??s[1]??1,l=s.depthOrArrayLayers??s[2]??1;const mips=desc.mipLevelCount||1;
   add(t,w*h*l*(BPP[desc.format]||4)*(mips>1?4/3:1)*(desc.sampleCount||1),'texture '+desc.format+' '+w+'×'+h+(l>1?'×'+l:''),desc.label)}catch{}return t};
  const cb=dev.createBuffer.bind(dev);dev.createBuffer=(desc)=>{const b=cb(desc);try{if(!(desc.usage&GPUBufferUsage.MAP_READ))add(b,desc.size,'buffer',desc.label)}catch{}return b};}
 total(){let t=0,n=0;for(const v of this.live.values()){t+=v.bytes;n++}return {bytes:t,count:n}}
 top(k=12){return [...this.byKey.entries()].sort((a,b)=>b[1].bytes-a[1].bytes).slice(0,k)}
}
