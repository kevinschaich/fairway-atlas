import './debug-panel.css';
// Dev-only visual debugging instruments (loaded with ?debug). Survive reloads so experiments are repeatable.
// Frame capture reads the WebGPU canvas after the renderer's rAF tick into a small 2D canvas.
const R=()=>window.__r;
import {installGradePanel,applyGrade} from './grade-panel.js';
// crop=[x0,y0,x1,y1] in 0..1 of the canvas: captured at native resolution (no downscale, so 1-px events survive)
const cap=(W=480,crop=null)=>{const cv=R().canvas;let sx=0,sy=0,sw=cv.width,sh=cv.height;if(crop){sx=Math.round(crop[0]*cv.width);sy=Math.round(crop[1]*cv.height);sw=Math.round((crop[2]-crop[0])*cv.width);sh=Math.round((crop[3]-crop[1])*cv.height);W=sw}const H=Math.round(W*sh/sw);const t=document.createElement('canvas');t.width=W;t.height=H;const x=t.getContext('2d',{willReadFrequently:true});return {W,H,rgba:()=>{x.drawImage(cv,sx,sy,sw,sh,0,0,W,H);return x.getImageData(0,0,W,H).data}}};
const lum=d=>{const L=new Float32Array(d.length/4);for(let i=0;i<L.length;i++)L[i]=(d[i*4]*.3+d[i*4+1]*.59+d[i*4+2]*.11)/255;return L};
// Standard WASD test path over the hole-7 rough; pose=[x,y,z,yaw,pitch]
const POSE=[11.9,21.5,33.7,.7,-.15];
async function setPose(p=POSE){const r=R(),fc=r.freeCamera;if(r.cameraType!=='free')document.getElementById('cameraFree')?.click();await new Promise(s=>setTimeout(s,200));r.camera.position.set(p[0],p[1],p[2]);fc.yaw=p[3];fc.pitch=p[4];fc.look();fc.velocity?.set(0,0,0);fc.keys.clear();await new Promise(s=>setTimeout(s,300))}
// Record real frames while holding keys (the real render loop, not a debug pose)
async function rec({ms=2500,keys=['KeyW'],W=480,crop=null,pose=POSE}={}){await setPose(pose);const c=cap(W,crop),fr=[],fps0=R().fps;const fc=R().freeCamera;keys.forEach(k=>fc.keys.add(k));const t0=performance.now();
 await new Promise(res=>{const f=()=>{fr.push(c.rgba());if(performance.now()-t0<ms)requestAnimationFrame(f);else res()};requestAnimationFrame(f)});keys.forEach(k=>fc.keys.delete(k));return {fr,W:c.W,H:c.H,fps:R().fps}}
// Flash metric: pixel much brighter than the 5x5 max of the previous AND next frame (single-frame pops)
function flashes({fr,W,H},y0f=.45){const Ls=fr.map(lum),y0=Math.round(H*y0f),mx=(L,i,y)=>{let m=0;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const v=L[(y+dy)*W+i+dx];if(v>m)m=v}return m};
 const per=[];const where=[];for(let k=1;k<Ls.length-1;k++){let c=0;for(let y=Math.max(y0,3);y<H-3;y++)for(let i=3;i<W-3;i++){const v=Ls[k][y*W+i];if(v<.3)continue;if(v>Math.max(mx(Ls[k-1],i,y),mx(Ls[k+1],i,y))*1.3+.04){c++;if(where.length<200)where.push([k,i,y])}}per.push(c)}
 return {total:per.reduce((a,b)=>a+b,0),framesWithFlash:per.filter(Boolean).length,frames:Ls.length,per,where}}
async function flashTest(runs=2,opts={}){const out=[];for(let i=0;i<runs;i++){const r=await rec(opts);window.__lastRec=r;const f=flashes(r);out.push({total:f.total,framesWithFlash:f.framesWithFlash,frames:f.frames,fps:r.fps})}return out}
// Count pixels of pure debug colours (for false-colour shader instrumentation)
function colourCount(r){const c={magenta:0,cyan:0,blue:0,red:0,frames:r.fr.length};for(const d of r.fr)for(let i=0;i<d.length;i+=4){const a=d[i],g=d[i+1],b=d[i+2];if(a>200&&g<70&&b>200)c.magenta++;else if(a<70&&g>200&&b>200)c.cyan++;else if(a<50&&g<50&&b>200)c.blue++;else if(a>200&&g<50&&b<50)c.red++}return c}
// Show frames k-1,k,k+1 of a crop side by side, magnified, in an overlay (for screenshots)
function show(r,k,box,s=4){let o=document.getElementById('dbgOverlay');if(!o){o=document.createElement('canvas');o.id='dbgOverlay';Object.assign(o.style,{position:'fixed',left:'10px',top:'10px',zIndex:9999,border:'2px solid #f0f',background:'#000',cursor:'pointer'});o.onclick=()=>o.remove();document.body.append(o)}
 const [x0,y0,x1,y1]=box,bw=x1-x0,bh=y1-y0,tw=bw*3+10,tmp=document.createElement('canvas');tmp.width=tw;tmp.height=bh;const tc=tmp.getContext('2d'),id=tc.createImageData(tw,bh);
 [k-1,k,k+1].forEach((f,j)=>{const d=r.fr[f];for(let y=0;y<bh;y++)for(let x=0;x<bw;x++){const s0=((y0+y)*r.W+x0+x)*4,t=(y*tw+j*(bw+5)+x)*4;id.data[t]=d[s0];id.data[t+1]=d[s0+1];id.data[t+2]=d[s0+2];id.data[t+3]=255}});tc.putImageData(id,0,0);o.width=tw*s;o.height=bh*s;const c=o.getContext('2d');c.imageSmoothingEnabled=false;c.drawImage(tmp,0,0,o.width,o.height)}
window.__dbg={cap,rec,flashes,flashTest,colourCount,show,setPose,POSE};

// ---- Visual debug menu (bottom-left dock). State persists across reloads in sessionStorage. ----
const GRASS_VIEWS=['Normal','Albedo','Sun (N·L·shadow)','Backlight','Sky','Shadow','Sheen ×4','Terrain-match colour','Colour before fog','Blade normal','Blade tangent','Ground normal','Canopy AO','Grass blue / terrain red','Matting field (white = matted)','Surface classes (false colour)','Terrain mesh: dense grid red / coarse blue','Terrain height error (red above, blue below; strip tinted green)','Terrain vertex normal','Terrain albedo','Terrain sun shadow','Terrain AO (r map, g near-field, b both)','Terrain N·L / sky / bounce','Native cover (red)','Final shading normal','Water SSR hits (magenta)'];
const ss={get:k=>{try{return JSON.parse(sessionStorage.getItem('fa-vdbg')||'{}')[k]}catch{}},set:(k,v)=>{try{const o=JSON.parse(sessionStorage.getItem('fa-vdbg')||'{}');o[k]=v;sessionStorage.setItem('fa-vdbg',JSON.stringify(o))}catch{}}};
function applyDebug(){const g=R()?.gpu;if(!g)return;g.debugGrass=ss.get('grass')||0;g.debugPost=ss.get('nan')?1:(ss.get('post')||0);applyGrade();g.fastLighting=!!ss.get('fast');g.taaOn=!!ss.get('taa');g.turfFullWanted=true;g.bladeFescue=ss.get('bwF')??1;g.bladeRough=ss.get('bwR')??1;const dyn=ss.get('dyn')!==false;if(!!g.fixedRes===dyn){g.fixedRes=!dyn;if(!dyn){g.pxBudget=6.5e6;}}}
// Frame profiler: GPU cost of each part = frame time with everything on minus frame time with that part skipped
// (at a fixed internal resolution so dynamic resolution can't mask it). Sorted, most expensive first.
async function profileFrame(n=45){const g=R()?.gpu;if(!g)return 'no GPU backend';const keepFix=g.fixedRes;g.fixedRes=true;
 const ms=async()=>{await new Promise(r=>setTimeout(r,500));let k=0,t0=0;await new Promise(r=>{const f=t=>{if(k===5)t0=t;if(++k<n+5)requestAnimationFrame(f);else{r();}};requestAnimationFrame(f)});return (performance.now()-t0)/n};
 const parts=[['ground (terrain, sand, rough)','ground'],['objects (rocks, buildings, club, ball)','objects'],['flora + birds','flora'],['turf shells (greens/tees/fairway)','turf'],['grass blades','grass'],['bunker walls','lip'],['ocean (+SSR copy)','ocean'],['shadow maps','shadow'],['volumetrics (rays + clouds)','vol'],['bloom','bloom'],['sky','sky']];
 g.skip={};const base=await ms();const rows=[];for(const [label,k] of parts){g.skip={[k]:true};const t=await ms();rows.push([label,Math.max(0,base-t)]);}g.skip={};g.fixedRes=keepFix;
 rows.sort((a,b)=>b[1]-a[1]);const acc=rows.reduce((a,[,v])=>a+v,0);
 return `frame ${base.toFixed(1)} ms (${(1000/base).toFixed(0)} fps) at ${g.w}×${g.h}\n`+rows.map(([l,v])=>`${v.toFixed(1).padStart(5)} ms  ${'█'.repeat(Math.round(v/base*30))} ${l}`).join('\n')+`\n${Math.max(0,base-acc).toFixed(1).padStart(5)} ms  other (post, compute, overhead)`}
function installMenu(){const dock=document.getElementById('dock');if(!dock||document.getElementById('visualDebug'))return !!dock;
 
 const sw=(id,name,desc)=>`<div class="vd-opt"><span class="vd-name"><b>${name}</b><small>${desc}</small></span><label class="vd-switch"><input type="checkbox" id="${id}" aria-label="${name}"><span></span></label></div>`;
 const d=document.createElement('details');d.id='visualDebug';d.innerHTML=`<summary title="Visual debug">Visual debug <i aria-hidden="true">⌃</i></summary><div class="vd-body" role="dialog" aria-label="Visual debug">
 <div class="vd-head"><div><small>Developer</small><h2>Visual debug</h2></div><button type="button" class="vd-close" aria-label="Close">×</button></div>
 <div class="vd-scroll">
  <div class="vd-label"><span>View</span></div>
  <div class="vd-sec">
   <div class="vd-opt is-stack"><span class="vd-name"><b>Debug view</b><small>False-colour and single-term views of the ground and grass</small></span><select id="vdGrass" aria-label="Debug view">${GRASS_VIEWS.map((n,i)=>`<option value="${i}">${n}</option>`).join('')}</select></div>
   ${sw('vdNan','NaN / Inf pixels','Non-finite scene pixels in magenta, bloom in cyan')}
  </div>
  <div class="vd-label"><span>Camera path &amp; capture</span></div>
  <div class="vd-sec">
   <div class="vd-row"><button type="button" id="vdTeeAxis" title="Show the tee reference axis: teeing position to the first aim point, with the marker line across it" onclick="{const r=window.__r;if(r){r.showTeeAxis=!r.showTeeAxis;this.classList.toggle('active',r.showTeeAxis);}}">Tee axis</button></div><div class="vd-row"><button type="button" id="vdAudioLab" title="Listen to, relabel and delete the game's sounds (dev server)" onclick="window.open('./audio-lab.html','_blank')">Audio lab</button></div><div class="vd-row"><button type="button" id="vdFlash" title="Walk forward and count single-frame bright flashes">Flash test · walk</button><button type="button" id="vdStill" title="Hold still and count single-frame bright flashes">Flash test · still</button></div>
   <output id="vdOut" class="vd-out"></output>
  </div>
  <div class="vd-label"><span>Rendering</span></div>
  <div class="vd-sec">
   ${sw('vdFast','Fast lighting','Cheaper contact shadow, near AO, object shadow and haze')}
   ${sw('vdDyn','Dynamic resolution','Scales the internal resolution to hold the frame rate')}
   ${sw('vdTaa','TAAU','Temporal anti-aliasing and upsampling · press T to A/B')}
   <label class="vd-slide"><span>Fescue blade width</span><input type="range" id="vdBwF" min="0.25" max="2" step="0.05"><output id="vdBwFO"></output></label>
   <label class="vd-slide"><span>Rough blade width</span><input type="range" id="vdBwR" min="0.25" max="2" step="0.05"><output id="vdBwRO"></output></label>
  </div>
  <div class="vd-label"><span>Profiling</span></div>
  <div class="vd-sec">
   <div class="vd-row"><button type="button" id="vdProf" title="Frame time with each part skipped in turn (~15 s, keep the camera still)">Profile passes</button><button type="button" id="vdTerms" title="Frame time with each shading term switched off in turn (~2 min, keep the camera still)">Profile shader terms</button></div>
   <output id="vdProfOut" class="vd-out"></output>
  </div>
 </div></div>`;dock.append(d);installGradePanel(d.querySelector('.vd-scroll'));
 d.querySelector('.vd-close').onclick=()=>{d.open=false;d.querySelector('summary').focus()};
 addEventListener('keydown',e=>{if(e.key==='Escape'&&d.open&&d.contains(document.activeElement)){d.open=false;d.querySelector('summary').focus()}});
 {const fast=d.querySelector('#vdFast'),dyn=d.querySelector('#vdDyn'),po=d.querySelector('#vdProfOut');
  fast.checked=!!ss.get('fast');for(const [id,key] of [['F','bwF'],['R','bwR']]){const el=d.querySelector('#vdBw'+id),o=d.querySelector('#vdBw'+id+'O');el.value=ss.get(key)??1;o.textContent='×'+(+el.value).toFixed(2);el.oninput=()=>{ss.set(key,+el.value);o.textContent='×'+(+el.value).toFixed(2);applyDebug()};}const taa=d.querySelector('#vdTaa');taa.checked=!!ss.get('taa');taa.onchange=()=>{ss.set('taa',taa.checked);applyDebug()};
  addEventListener('keydown',e=>{if(e.code!=='KeyT'||e.target.closest?.('input,textarea,select'))return;taa.checked=!taa.checked;taa.onchange();});dyn.checked=ss.get('dyn')!==false;
  fast.onchange=()=>{ss.set('fast',fast.checked);applyDebug()};dyn.onchange=()=>{ss.set('dyn',dyn.checked);applyDebug()};
  d.querySelector('#vdProf').onclick=async()=>{po.textContent='Profiling… keep the camera still (~15 s)';po.textContent=await profileFrame()};d.querySelector('#vdTerms').onclick=async()=>{po.textContent='Profiling shader terms… keep the camera still (~2 min)';po.textContent=await profileTerms()};}
 const sel=d.querySelector('#vdGrass'),nan=d.querySelector('#vdNan'),out=d.querySelector('#vdOut');sel.value=ss.get('grass')||0;nan.checked=!!ss.get('nan');
 sel.onchange=()=>{ss.set('grass',+sel.value);applyDebug()};nan.onchange=()=>{ss.set('nan',nan.checked);applyDebug()};
 const run=async keys=>{out.textContent='Recording…';const r=await flashTest(2,{keys});out.textContent=r.map(x=>`${x.total} flash px · ${x.framesWithFlash}/${x.frames} frames · ${x.fps} fps`).join('\n')};
 d.querySelector('#vdFlash').onclick=()=>run(['KeyW']);d.querySelector('#vdStill').onclick=()=>run([]);return true}
// NaN counter: needs the NaN overlay on; counts magenta pixels in a native-resolution crop while walking
async function nanTest(runs=2,opts={}){const prev=ss.get('nan');ss.set('nan',true);applyDebug();const o=[];for(let i=0;i<runs;i++){const r=await rec({ms:3000,crop:[0,.4,.6,.8],...opts});const c=colourCount(r);o.push({nan:c.magenta,bloomNan:c.cyan,frames:c.frames})}ss.set('nan',prev);applyDebug();return o}
async function setGrassView(i){ss.set('grass',i);applyDebug();const s=document.getElementById('vdGrass');if(s)s.value=i;await new Promise(r=>setTimeout(r,200))}
// Shader-term profiler: switch off one shading term at a time (F.perf kill mask) and time the frame; the delta is that term's cost
const TERMS=[['contact shadow (heightfield march)',0],['near-field AO',1],['object shadow map lookups',2],['terrain shadow lookup',3],['cloud shadow',4],['fog / haze (fogApply)',5],['sand detail + rake normals',6],['turf detail (mesh ground)',7],['procedural rough canopy (ground)',8],['ground AO map',9],['relief normals (4 taps)',10],['grass blade per-pixel lighting',11],['ocean SSR march',12],['specular + sky reflection',13],['flora per-pixel lighting',14],['turf blade shells',15]];
async function profileTerms(n=40){const g=R()?.gpu;if(!g)return 'no GPU backend';const keepFix=g.fixedRes;g.fixedRes=true;
 const ms=async()=>{await new Promise(r=>setTimeout(r,600));let k=0,t0=0;await new Promise(r=>{const f=t=>{if(k===5)t0=t;if(++k<n+5)requestAnimationFrame(f);else r()};requestAnimationFrame(f)});return (performance.now()-t0)/n};
 // A/B/A per term, twice: the baseline is re-measured right beside every test so drift (thermals, other tabs) cancels
 const rows=[];let bases=[],spread=[];for(const [label,bit] of TERMS){let d=0;for(let rep=0;rep<2;rep++){g.perfMask=0;const a0=await ms();g.perfMask=1<<bit;const t=await ms();g.perfMask=0;const a1=await ms();d+=(a0+a1)/2-t;bases.push(a0,a1);spread.push(Math.abs(a0-a1));}rows.push([label,d/2]);}
 g.perfMask=0;g.fixedRes=keepFix;const base=bases.reduce((x,y)=>x+y,0)/bases.length,noise=spread.reduce((x,y)=>x+y,0)/spread.length;rows.sort((a,b)=>b[1]-a[1]);
 return `frame ${base.toFixed(1)} ms (${(1000/base).toFixed(0)} fps) at ${g.w}×${g.h} · noise ±${noise.toFixed(1)} ms\n`+rows.map(([l,v])=>`${v.toFixed(1).padStart(5)} ms  ${'█'.repeat(Math.max(0,Math.round(v/base*40)))} ${l}`).join('\n')}
Object.assign(window.__dbg,{nanTest,setGrassView,applyDebug,GRASS_VIEWS,profileFrame,profileTerms,TERMS});
(function wait(){if(installMenu()&&R()?.gpu)applyDebug();else{}if(!(document.getElementById('visualDebug')&&R()?.gpu))setTimeout(wait,300)})();
setInterval(applyDebug,1000); // re-apply after hot reloads swap the backend
// Ground-through-grass coverage: with "Grass blue / terrain red", fraction of red among red+blue per screen band
// (bands top→bottom ≈ far→near). 0 = grass fully covers the ground; 1 = only ground visible.
function coverage(bands=12,crop=null){const c=cap(crop?480:1600,crop),d=c.rgba(),W=c.W,H=c.H,out=[];for(let b=0;b<bands;b++){let r=0,bl=0;const y0=Math.floor(H*b/bands),y1=Math.floor(H*(b+1)/bands);for(let y=y0;y<y1;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4,R0=d[i],G=d[i+1],B=d[i+2];if(R0>1.8*G&&R0>1.8*B&&R0>40)r++;else if(B>1.3*R0&&B>1.1*G&&B>40)bl++}out.push(r+bl<50?null:+(r/(r+bl)).toFixed(3))}return out}
const TEE_VIEW=[[-0.329,20.343,-2.932],[30.68,17.34,23.62]];
// __look renders synchronously; read the canvas in the same task (a WebGPU canvas is cleared after it is presented)
// default crop = the rough hillside left of the tee in TEE_VIEW (far top → near bottom)
function teeCoverage(bands=4,crop=[.08,.44,.45,.56],view=TEE_VIEW){window.__look(view[0],view[1],30);return coverage(bands,crop)}
async function teeView(){window.__look(TEE_VIEW[0],TEE_VIEW[1],30)}
Object.assign(window.__dbg,{coverage,teeView,teeCoverage,TEE_VIEW});
// Layer colour match: render the same pose twice — false-colour mask (blue grass / red ground) and normal shading —
// then report per band the mean sRGB of blade pixels vs ground pixels and their difference (ΔE-ish, 0–255 scale).
function layerMatch(bands=4,crop=[.08,.44,.45,.56],view=TEE_VIEW){const g=R().gpu,prev=g.debugGrass;const lookAt=()=>window.__look(view[0],view[1],30);
 g.debugGrass=13;lookAt();const c=cap(480,crop),mask=c.rgba().slice();g.debugGrass=0;lookAt();const img=c.rgba();g.debugGrass=prev;
 const W=c.W,H=c.H,out=[];const cls=new Array(W*H),blueNear=new Float32Array(W*H);
 for(let p=0;p<W*H;p++){const R0=mask[p*4],G=mask[p*4+1],B=mask[p*4+2];cls[p]=(R0>1.8*G&&R0>1.8*B&&R0>40)?'t':(B>1.3*R0&&B>1.1*G&&B>40)?'g':null}
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){let n=0,b=0;for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const yy=y+dy,xx=x+dx;if(yy<0||yy>=H||xx<0||xx>=W)continue;n++;if(cls[yy*W+xx]==='g')b++}blueNear[y*W+x]=b/n}
 for(let b=0;b<bands;b++){const s={g:[0,0,0,0],t:[0,0,0,0]};const y0=Math.floor(H*b/bands),y1=Math.floor(H*(b+1)/bands);
  for(let y=y0;y<y1;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;const k=cls[y*W+x];if(!k)continue;if(k==='t'&&blueNear[y*W+x]<.4)continue;/*ground only among blades*/const a=s[k];a[0]+=img[i];a[1]+=img[i+1];a[2]+=img[i+2];a[3]++}
  const m=a=>a[3]?a.slice(0,3).map(v=>Math.round(v/a[3])):null;const bl=m(s.g),gr=m(s.t);out.push({blade:bl,ground:gr,groundFrac:+(s.t[3]/(s.t[3]+s.g[3]||1)).toFixed(2),diff:bl&&gr?Math.round(Math.hypot(bl[0]-gr[0],bl[1]-gr[1],bl[2]-gr[2])):null,lumDiff:bl&&gr?Math.round((bl[0]*.3+bl[1]*.59+bl[2]*.11)-(gr[0]*.3+gr[1]*.59+gr[2]*.11)):null})}
 return out}
Object.assign(window.__dbg,{layerMatch});
// Patch-scale variation (for "matted patches"): coefficient of variation of luminance after blurring away blade detail.
// Same numbers are computed for a reference photo (480 px wide crop) so the game can be compared to reality.
function blurL(L,W,H,r){let a=L.slice(),b=new Float32Array(L.length);for(let pass=0;pass<3;pass++){for(let y=0;y<H;y++){let s=0,n=0;for(let x=-r;x<W;x++){const xa=x+r,xr=x-r-1;if(xa<W){s+=a[y*W+xa];n++}if(xr>=0){s-=a[y*W+xr];n--}if(x>=0)b[y*W+x]=s/n}}for(let x=0;x<W;x++){let s=0,n=0;for(let y=-r;y<H;y++){const ya=y+r,yr=y-r-1;if(ya<H){s+=b[ya*W+x];n++}if(yr>=0){s-=b[yr*W+x];n--}if(y>=0)a[y*W+x]=s/n}}}return a}
const cv_=A=>{let m=0;for(const v of A)m+=v;m/=A.length;let s=0;for(const v of A)s+=(v-m)*(v-m);return Math.sqrt(s/A.length)/m};
function patchStats(crop=[.15,.45,.85,.95]){const c=cap(480,crop);const d=c.rgba(),L=lum(d),W=c.W,H=c.H;const o={fine:+cv_(L).toFixed(3)};for(const r of [2,4,8,16])o['blur'+r]=+cv_(blurL(L,W,H,Math.round(r*.6))).toFixed(3);let m=0;for(const v of L)m+=v;m/=L.length;{const b3=blurL(L,W,H,2),b12=blurL(L,W,H,7);const sd=f=>{let s2=0;for(let i=0;i<L.length;i++){const v=f(i);s2+=v*v}return Math.sqrt(s2/L.length)/m};o.patch=+sd(i=>b3[i]-b12[i]).toFixed(3);o.blade=+sd(i=>L[i]-b3[i]).toFixed(3)}let br=0;for(const v of L)if(v>m*1.3)br++;o.bright=+(br/L.length).toFixed(3);return o}
const LAWN_POSE=[14,23.2,26,.9,-.55];   // ~3 m above the hole-7 rough, looking down ~30°, like a view from a window
const PHOTO_TARGET={patch:.074,blade:.135,fine:.197,blur2:.127,blur4:.096,blur8:.066,blur16:.042,bright:.049};
async function lawnStats(){await setPose(LAWN_POSE);await new Promise(r=>setTimeout(r,400));let o;await new Promise(res=>requestAnimationFrame(()=>{o=patchStats();res()}));return {game:o,photo:PHOTO_TARGET}}
Object.assign(window.__dbg,{patchStats,lawnStats,LAWN_POSE,PHOTO_TARGET});
// Clustering index ("cheetah print" detector): patch-band contrast (blur r2 − blur r10) measured per tile (6×4);
// cluster = CV of the per-tile contrast. Uniform random spots → low; clustered, merged matting → higher.
// Rows of tiles share a distance, so variation is compared only ACROSS each row (perspective-free); cluster = mean row CV (10 cols).
function clusterStats(crop=[.15,.45,.85,.95],tx=10,ty=4){const c=cap(480,crop),L=lum(c.rgba()),W=c.W,H=c.H;const a=blurL(L,W,H,2),b=blurL(L,W,H,10);let m=0;for(const v of L)m+=v;m/=L.length;
 const cvs=[];let all=0;for(let j=0;j<ty;j++){const s=[];for(let i=0;i<tx;i++){let n=0,s1=0,s2=0;for(let y=Math.floor(j*H/ty);y<Math.floor((j+1)*H/ty);y++)for(let x=Math.floor(i*W/tx);x<Math.floor((i+1)*W/tx);x++){const v=a[y*W+x]-b[y*W+x];s1+=v;s2+=v*v;n++}s.push(Math.sqrt(Math.max(s2/n-(s1/n)**2,0)))}
  const mu=s.reduce((p,q)=>p+q,0)/tx;all+=mu;cvs.push(Math.sqrt(s.reduce((p,q)=>p+(q-mu)**2,0)/tx)/mu)}
 return {cluster:+(cvs.reduce((p,q)=>p+q,0)/ty).toFixed(3),patchEnergy:+(all/ty/m).toFixed(3)}}
const CLUSTER_TARGET={cluster:.149,patchEnergy:.087};
async function lawnCluster(){await setPose(LAWN_POSE);await new Promise(r=>setTimeout(r,400));let o;await new Promise(res=>requestAnimationFrame(()=>{o=clusterStats();res()}));return {game:o,photo:CLUSTER_TARGET}}
Object.assign(window.__dbg,{clusterStats,lawnCluster,CLUSTER_TARGET});

// Matting-field statistics from straight overhead (world-uniform scale). Uses grass view 14 (grayscale mat amount).
// tileCV: variation of matted coverage between ~4 m tiles (uniform print ≈ low). sizes: patch areas (m²) percentiles.
function matStats(center=[20,20],height=60,fovDeg=null){const g=R().gpu,prev=g.debugGrass;g.debugGrass=14;
 window.__look([center[0],height,center[1]+.01],[center[0],0,center[1]],6);const c=cap(480);const d=c.rgba();g.debugGrass=prev;window.__look([center[0],height,center[1]+.01],[center[0],0,center[1]],1);
 const W=c.W,H=c.H;const fov=(R().camera.fov||48)*Math.PI/180;const viewH=2*height*Math.tan(fov/2);const mpp=viewH/H;  // metres per pixel
 const M=new Uint8Array(W*H);let cov=0;for(let i=0;i<W*H;i++){M[i]=d[i*4]>128?1:0;cov+=M[i]}
 const tp=Math.max(4,Math.round(4/mpp)),tv=[];for(let y=0;y+tp<=H;y+=tp)for(let x=0;x+tp<=W;x+=tp){let n=0;for(let yy=y;yy<y+tp;yy++)for(let xx=x;xx<x+tp;xx++)n+=M[yy*W+xx];tv.push(n/(tp*tp))}
 const mu=tv.reduce((a,b)=>a+b,0)/tv.length,sd=Math.sqrt(tv.reduce((a,b)=>a+(b-mu)**2,0)/tv.length);
 const lab=new Int32Array(W*H),areas=[];let id=0;for(let i=0;i<W*H;i++){if(!M[i]||lab[i])continue;id++;let a=0;const st=[i];lab[i]=id;while(st.length){const p=st.pop();a++;const x=p%W,y=(p/W)|0;for(const q of [x>0?p-1:-1,x<W-1?p+1:-1,y>0?p-W:-1,y<H-1?p+W:-1])if(q>=0&&M[q]&&!lab[q]){lab[q]=id;st.push(q)}}areas.push(a*mpp*mpp)}
 areas.sort((a,b)=>a-b);const pc=p=>areas.length?+areas[Math.min(areas.length-1,Math.floor(p*areas.length))].toFixed(2):0;
 return {coverage:+(cov/(W*H)).toFixed(3),tileCV:+(sd/mu).toFixed(3),patches:areas.length,areaP50:pc(.5),areaP90:pc(.9),areaMax:pc(.999),top10share:+(areas.slice(-Math.max(1,Math.round(areas.length*.1))).reduce((a,b)=>a+b,0)/Math.max(areas.reduce((a,b)=>a+b,0),1e-9)).toFixed(2),mpp:+mpp.toFixed(3)}}
Object.assign(window.__dbg,{matStats});
// Turf texture stats (greens/tees) — same definitions as the reference-photo analysis:
// cv = luminance std/mean; dark/bright = share of pixels <60% / >140% of mean; sat = mean HSV saturation; rgb = mean colour.
function texStats(crop=[.2,.5,.8,.95]){if(R().gpu?.errors?.length)throw Error("shader error: "+R().gpu.errors[0].slice(0,200));const c=cap(480,crop),d=c.rgba(),n=d.length/4;let r=0,g=0,b=0,s=0;const L=new Float32Array(n);
 for(let i=0;i<n;i++){const R0=d[i*4]/255,G=d[i*4+1]/255,B=d[i*4+2]/255;r+=R0;g+=G;b+=B;const mx=Math.max(R0,G,B),mn=Math.min(R0,G,B);s+=(mx-mn)/Math.max(mx,1e-3);L[i]=R0*.3+G*.59+B*.11}
 let m=0;for(const v of L)m+=v;m/=n;let sd=0,dk=0,br=0;for(const v of L){sd+=(v-m)**2;if(v<m*.6)dk++;if(v>m*1.4)br++}
 return {rgb:[r,g,b].map(v=>Math.round(v/n*255)),ratio:[+(r/g).toFixed(2),1,+(b/g).toFixed(2)],cv:+(Math.sqrt(sd/n)/m).toFixed(3),dark:+(dk/n).toFixed(3),bright:+(br/n).toFixed(3),sat:+(s/n).toFixed(3)}}
const TURF_TARGET={ratio:[.8,1,.37],cv:.47,dark:.21,bright:.2,sat:.67};
// Pose ~1.5 m above the green, looking down ~35°, like standing over a putt
// Stand 2.5 m from a point, eye 1.5 m up, looking at it (yaw from atan2(dx,-dz) as FreeCamera.enter uses)
async function lookAtGround(p,off=[-1.8,1.8]){const w=__world();const x=p.x+off[0],z=p.z+off[1],dx=p.x-x,dz=p.z-z;const y=w.elevation(x,z)+1.5;const pitch=-Math.atan2(1.5,Math.hypot(dx,dz));await setPose([x,y,z,Math.atan2(dx,-dz),pitch]);await new Promise(r=>setTimeout(r,500))}
function setTime(t){const e=document.getElementById('lpTime');if(!e)return;e.value=t;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))}
// Controlled texture pose: midday sun (no hill shadows), eye 1.5 m up looking steeply down (~50°) at the point
async function statsAt(p,time=13){setTime(time);await new Promise(r=>setTimeout(r,300));const w=__world();const x=p.x-1,z=p.z+1,dx=p.x-x,dz=p.z-z;await setPose([x,w.elevation(x,z)+1.5,z,Math.atan2(dx,-dz),-.9]);await new Promise(r=>setTimeout(r,500));let o;await new Promise(res=>requestAnimationFrame(()=>{o=texStats([.3,.5,.7,.9]);res()}));return {game:o,target:TURF_TARGET,fps:R().fps}}
async function greenStats(){const w=__world();return statsAt({x:w.pin.x+5,z:w.pin.z-6})}
async function teeStats(){const w=__world();return statsAt({x:w.tee.x+1,z:w.tee.z+1.5})}
Object.assign(window.__dbg,{setTime,texStats,greenStats,teeStats,TURF_TARGET});

// ---- Boundary audit: how faithfully the rendered surface edges follow the source polygons ----
// Renders the "Surface classes" false-colour view straight down, tile by tile, and walks every green/tee/fairway/bunker
// edge: along the outward normal it finds where the rendered class stops being the polygon's class.
// offset = that distance (m, + = rendered surface spills outside the polygon, − = falls short). Also counts misses.
function classOf(d,i){const r=d[i],g=d[i+1],b=d[i+2],mx=Math.max(r,g,b),mn=Math.min(r,g,b);
 if(mx<50)return 'rough';if(r>180&&b>180&&g<110)return 'green';if(g>180&&b>180&&r<110)return 'collar';if(r>180&&g>180&&b<110)return 'fairway';if(r>180&&g<170&&g>40&&b<90)return 'tee';
 if(mx>150&&(mx-mn)/mx<.3)return 'bunker';if(b>150&&r<120)return 'water';return 'other'}
const CLASS_OF_KIND={green:'green',tee:'fairway',fairway:'fairway',bunker:'bunker'};   // tees share the fairway mask channel; tee-vs-fairway tone comes from the kind map
const same=(c,want)=>c===want||(want==='fairway'&&c==='tee');
function polyEdges(f,step=.5){const P=f.points;let A=0;for(let i=0;i<P.length;i++){const a=P[i],b=P[(i+1)%P.length];A+=a[0]*b[1]-b[0]*a[1]}const s=Math.sign(A)||1;const out=[];
 for(let i=0;i<P.length;i++){const a=P[i],b=P[(i+1)%P.length];const dx=b[0]-a[0],dz=b[1]-a[1],L=Math.hypot(dx,dz);if(L<1e-6)continue;const nx=dz/L*s,nz=-dx/L*s;   // outward normal
  for(let t=0;t<L;t+=step)out.push({x:a[0]+dx*t/L,z:a[1]+dz*t/L,nx,nz})}return out}
async function boundaryAudit({kinds=['green','tee','fairway','bunker'],margin=40,h=9,tile=12,maxTiles=80}={}){
 const w=__world(),g=R().gpu,prev=g.debugGrass;g.debugGrass=15;
 const minx=Math.min(w.tee.x,w.pin.x)-margin,maxx=Math.max(w.tee.x,w.pin.x)+margin,minz=Math.min(w.tee.z,w.pin.z)-margin,maxz=Math.max(w.tee.z,w.pin.z)+margin;
 const feats=w.features.filter(f=>f.closed&&kinds.includes(f.kind)&&f.points.some(p=>p[0]>minx&&p[0]<maxx&&p[1]>minz&&p[1]<maxz));
 const samples=[];for(const f of feats)for(const s of polyEdges(f))if(s.x>minx&&s.x<maxx&&s.z>minz&&s.z<maxz)samples.push({...s,kind:f.kind,id:f.id});
 const tiles=new Map();for(const s of samples){const k=Math.floor(s.x/tile)+','+Math.floor(s.z/tile);if(!tiles.has(k))tiles.set(k,[]);tiles.get(k).push(s)}
 const cv=g.canvas,W=cv.width,H=cv.height,fov=(R().camera.fov)*Math.PI/180;const t2=document.createElement('canvas');t2.width=W;t2.height=H;const x2=t2.getContext('2d',{willReadFrequently:true});
 const res=[];let n=0;for(const [k,ss] of tiles){if(n++>=maxTiles)break;const [tx,tz]=k.split(',').map(Number);const cx=(tx+.5)*tile,cz=(tz+.5)*tile,gy=w.elevation(cx,cz);
  window.__look([cx,gy+h,cz+.001],[cx,gy,cz],3);x2.drawImage(cv,0,0);const d=x2.getImageData(0,0,W,H).data;const mpp=2*h*Math.tan(fov/2)/H;
  const at=(x,z)=>{const px=Math.round(W/2+(x-cx)/mpp),py=Math.round(H/2+(z-cz)/mpp);if(px<0||py<0||px>=W||py>=H)return null;return classOf(d,(py*W+px)*4)};
  for(const s of ss){const want=CLASS_OF_KIND[s.kind];const inside=at(s.x-s.nx*.8,s.z-s.nz*.8);if(!same(inside,want)){res.push({...s,miss:'inside='+inside});continue}
   let off=null;for(let e=-.8;e<=2;e+=.03){const c=at(s.x+s.nx*e,s.z+s.nz*e);if(!same(c,want)){off=e;break}}res.push({...s,off,outside:at(s.x+s.nx*(off??0)+s.nx*.3,s.z+s.nz*(off??0)+s.nz*.3)})}}
 g.debugGrass=prev;window.__look();window.__lastAudit=res;
 const byKind={};for(const r of res){const o=byKind[r.kind]??={n:0,miss:0,abs:[],spill:0,short:0};o.n++;if(r.off==null){o.miss++;continue}o.abs.push(Math.abs(r.off));if(r.off>.3)o.spill++;if(r.off<-.3)o.short++}
 for(const k in byKind){const o=byKind[k];o.abs.sort((a,b)=>a-b);const q=p=>o.abs.length?+o.abs[Math.floor(p*(o.abs.length-1))].toFixed(2):null;Object.assign(o,{p50:q(.5),p90:q(.9),max:q(1),pctOff30:+(((o.spill+o.short)/Math.max(o.abs.length,1))*100).toFixed(1)});delete o.abs}
 return {tiles:Math.min(n,maxTiles),samples:res.length,byKind}}
Object.assign(window.__dbg,{boundaryAudit,classOf});
// post-process debug readouts (persist across the 1 s re-apply): 2 = local-exposure EV map, 3 = tone curve in/out, 4 = readback check
Object.assign(window.__dbg,{setPost:n=>{ss.set('post',n);applyDebug()},setTAA:on=>{ss.set('taa',!!on);applyDebug()},setDynRes:on=>{ss.set('dyn',!!on);applyDebug()},setFastLighting:on=>{ss.set('fast',!!on);applyDebug()},
 // isolation settings for perf work: only the listed effects on, dynamic resolution / TAAU / fast lighting off, 6.5 Mpx native
 isolate:(keep=[])=>{const R=window.__r;const fx={};for(const k in R.userEffects)fx[k]=keep.includes(k);R.setEffects(fx);ss.set('dyn',false);ss.set('taa',false);ss.set('fast',false);applyDebug();const g=R.gpu;if(g){g.fixedRes=true;g.pxBudget=6.5e6;}return {effects:{...R.userEffects},dynRes:!g?.fixedRes,taa:!!g?.taaOn,fast:!!g?.fastLighting}}});
// Overhead view of a spot with the SOURCE polygons drawn on top (red = bunker, magenta = green, yellow = fairway, orange = tee)
function showPolys(cx,cz,h=9,view=0){const w=__world(),g=R().gpu;g.debugGrass=view;const gy=w.elevation(cx,cz);window.__look([cx,gy+h,cz+.001],[cx,gy,cz],6);
 let o=document.getElementById('polyOverlay');if(!o){o=document.createElement('canvas');o.id='polyOverlay';Object.assign(o.style,{position:'fixed',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:9998});document.body.append(o)}
 const cv=g.canvas,W=o.width=cv.width,H=o.height=cv.height,fov=R().camera.fov*Math.PI/180,mpp=2*h*Math.tan(fov/2)/H;const c=o.getContext('2d');c.lineWidth=3;
 const col={bunker:'#ff2020',green:'#ff00ff',fairway:'#ffff00',tee:'#ff9900',water:'#00a0ff'};
 for(const f of w.features.filter(f=>f.closed&&col[f.kind])){c.strokeStyle=col[f.kind];c.beginPath();f.points.forEach((p,i)=>{const x=W/2+(p[0]-cx)/mpp,y=H/2+(p[1]-cz)/mpp;i?c.lineTo(x,y):c.moveTo(x,y)});c.closePath();c.stroke()}
 return {mpp:+mpp.toFixed(4)}}
function hidePolys(){document.getElementById('polyOverlay')?.remove();R().gpu.debugGrass=0;window.__look()}
Object.assign(window.__dbg,{showPolys,hidePolys});
// ---- Bunker lip audit: width of the exposed-soil band between sand and grass, seen from straight above ----
function lipClass(d,i){const r=d[i],g=d[i+1],b=d[i+2],mx=Math.max(r,g,b),mn=Math.min(r,g,b),s=(mx-mn)/Math.max(mx,1),l=(r*.3+g*.59+b*.11)/255;
 if(g>r*1.08&&g>b*1.2)return 'grass';if(l>.5&&s<.3)return 'sand';if(r>=g*.92&&r>b*1.15&&l<.62)return 'dirt';if(l<.12)return 'dark';return 'other'}
async function lipAudit({h=4,tile=5,maxTiles=60,margin=30}={}){const w=__world(),g=R().gpu,prev=g.debugGrass;g.debugGrass=0;
 const minx=Math.min(w.tee.x,w.pin.x)-margin,maxx=Math.max(w.tee.x,w.pin.x)+margin,minz=Math.min(w.tee.z,w.pin.z)-margin,maxz=Math.max(w.tee.z,w.pin.z)+margin;
 const samples=[];for(const f of w.features.filter(f=>f.closed&&f.kind==='bunker'))for(const s of polyEdges(f,.6))if(s.x>minx&&s.x<maxx&&s.z>minz&&s.z<maxz)samples.push({...s,id:f.id});
 const tiles=new Map();for(const s of samples){const k=Math.floor(s.x/tile)+','+Math.floor(s.z/tile);if(!tiles.has(k))tiles.set(k,[]);tiles.get(k).push(s)}
 const cv=g.canvas,W=cv.width,H=cv.height,fov=R().camera.fov*Math.PI/180;const t2=document.createElement('canvas');t2.width=W;t2.height=H;const x2=t2.getContext('2d',{willReadFrequently:true});
 const out=[];let n=0;for(const [k,ss] of tiles){if(n++>=maxTiles)break;const [tx,tz]=k.split(',').map(Number);const cx=(tx+.5)*tile,cz=(tz+.5)*tile,gy=w.elevation(cx,cz);
  window.__look([cx,gy+h,cz+.001],[cx,gy,cz],3);x2.drawImage(cv,0,0);const d=x2.getImageData(0,0,W,H).data;const mpp=2*h*Math.tan(fov/2)/H;
  const at=(x,z)=>{const px=Math.round(W/2+(x-cx)/mpp),py=Math.round(H/2+(z-cz)/mpp);if(px<0||py<0||px>=W||py>=H)return null;return lipClass(d,(py*W+px)*4)};
  for(const s of ss){const st=mpp*.9;let lastSand=null,firstGrass=null,dirt=0,dark=0;for(let e=-.8;e<=.8;e+=st){const c=at(s.x+s.nx*e,s.z+s.nz*e);if(c==null)continue;if(c==='sand'&&firstGrass==null)lastSand=e;if(c==='grass'&&lastSand!=null&&firstGrass==null)firstGrass=e;}
   if(lastSand==null||firstGrass==null){out.push({...s,width:null});continue}
   for(let e=lastSand;e<firstGrass;e+=st){const c=at(s.x+s.nx*e,s.z+s.nz*e);if(c==='dirt')dirt+=st;else if(c==='dark')dark+=st}
   out.push({...s,gap:firstGrass-lastSand,dirt,dark})}}
 g.debugGrass=prev;window.__look();window.__lastLip=out;const ok=out.filter(o=>o.gap!=null),q=(a,p)=>a.length?+a[Math.floor(p*(a.length-1))].toFixed(3):null;
 const gaps=ok.map(o=>o.gap).sort((a,b)=>a-b),dirts=ok.map(o=>o.dirt).sort((a,b)=>a-b);
 return {samples:out.length,measured:ok.length,gap_m:{p10:q(gaps,.1),p50:q(gaps,.5),p90:q(gaps,.9)},dirt_m:{p10:q(dirts,.1),p50:q(dirts,.5),p90:q(dirts,.9)},pctDirtIn5to8cm:+(ok.filter(o=>o.dirt>=.045&&o.dirt<=.085).length/Math.max(ok.length,1)*100).toFixed(1),pctNoDirt:+(ok.filter(o=>o.dirt<.01).length/Math.max(ok.length,1)*100).toFixed(1)}}
Object.assign(window.__dbg,{lipAudit,lipClass});
// ---- A/B views: "Mark A" copies the current view (position + camera angle); "Mark B" copies A and B together.
// Pose = [x, y, z, yaw, pitch, fov] (fov = zoom, degrees). __dbg.replay({a,b}) moves the camera in a straight line from A to B (or just shows A),
// capturing frames like rec() so __dbg.flashes(await __dbg.replay(p)) measures it.
let markedA=null;
const r3=v=>+v.toFixed(3);
function camPose(){const r=R(),c=r.camera,fc=r.freeCamera;let yaw=fc.yaw,pitch=fc.pitch;if(r.cameraType!=='free'){const d=c.getWorldDirection(c.position.clone());yaw=Math.atan2(d.x,-d.z);pitch=Math.asin(Math.max(-1,Math.min(1,d.y)))}
 return [r3(c.position.x),r3(c.position.y),r3(c.position.z),r3(yaw),r3(pitch),+c.fov.toFixed(1)]}   // [x,y,z,yaw,pitch,fov(zoom)]
function meta(){const q=new URLSearchParams(location.search);return {course:q.get('course'),hole:+(q.get('hole')||0),time:+(+(q.get('time')||0)).toFixed(2)}}
async function copyCmd(p,out,label){const cmd=`__dbg.replay(${JSON.stringify(p)})`;try{await navigator.clipboard.writeText(cmd);if(out)out.textContent=label+' copied ✓\n'+cmd}catch{console.log(cmd);if(out)out.textContent=label+' (clipboard blocked):\n'+cmd}return p}
function markA(out){markedA=camPose();document.getElementById('vdMarkA')?.classList.add('on');return copyCmd({...meta(),a:markedA},out,'A')}
function markB(out){if(!markedA){if(out)out.textContent='Mark A first';return}const p={...meta(),a:markedA,b:camPose()};window.__lastPath=p;ss.set('path',p);document.getElementById('vdMarkA')?.classList.remove('on');return copyCmd(p,out,'A → B')}
async function replay(p=window.__lastPath||ss.get('path'),{W=480,crop=null,capture=true,speed=6}={}){if(!p?.a)throw Error('nothing to replay');const r=R();
 if(r.gpu?.debugPose)window.__look?.();if(p.time&&window.__dbg.setTime)await window.__dbg.setTime(p.time);
 const A=p.a,B=p.b||p.a;await setPose(A);const fc=r.freeCamera;fc.setFrozen?.(true);
 const L=Math.hypot(B[0]-A[0],B[1]-A[1],B[2]-A[2]),ms=p.b?Math.max(600,L/speed*1000):0,c=capture?cap(W,crop):null,fr=[],t0=performance.now();
 let dy=B[3]-A[3];dy=((dy+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
 await new Promise(res=>{const f=()=>{const u=ms?Math.min(1,(performance.now()-t0)/ms):1,s=u*u*(3-2*u);
   r.camera.position.set(A[0]+(B[0]-A[0])*s,A[1]+(B[1]-A[1])*s,A[2]+(B[2]-A[2])*s);fc.yaw=A[3]+dy*s;fc.pitch=A[4]+(B[4]-A[4])*s;fc.look();if(A[5]){const f=A[5]+((B[5]||A[5])-A[5])*s;if(Math.abs(r.camera.fov-f)>.01){r.camera.fov=f;r.camera.updateProjectionMatrix()}}
   requestAnimationFrame(()=>{if(c)fr.push(c.rgba());if(u<1)f();else res()})};f()});
 return {fr,W:c?.W,H:c?.H,fps:r.fps,ms:Math.round(ms),path:p}}
Object.assign(window.__dbg,{markA,markB,replay,camPose});
(function addPathUI(){const b=document.querySelector('#visualDebug .vd-body');if(!b){setTimeout(addPathUI,400);return}if(b.querySelector('#vdMarkA'))return;
 const row=document.createElement('div');row.className='vd-row';row.innerHTML='<button type="button" id="vdMarkA" title="Mark the current camera as A and copy its replay call">Mark A</button><button type="button" id="vdMarkB" title="Mark B and copy the A→B path replay call">Mark B</button><button type="button" id="vdReplay" title="Fly the marked A→B path">Replay path</button>';const o0=b.querySelector('#vdOut');o0.parentNode.insertBefore(row,o0.previousElementSibling);
 const out=b.querySelector('#vdOut');row.querySelector('#vdMarkA').onclick=e=>{e.currentTarget.blur();markA(out)};row.querySelector('#vdMarkB').onclick=e=>{e.currentTarget.blur();markB(out)};
 row.querySelector('#vdReplay').onclick=async e=>{e.currentTarget.blur();if(!(window.__lastPath||ss.get('path'))){out.textContent='Mark A and B first';return}out.textContent='replaying…';const r=await replay(undefined,{capture:false});out.textContent=`replayed ${(r.ms/1000).toFixed(1)} s`}})();
// ---- Surface lightness: mean CIE L* per surface class (green, tee, fairway, fringe, rough) as rendered, using the
// "Surface classes" view (15) as a per-pixel mask over the normal render at the same pose. Poses default to overheads of the
// current green (with its fringe, approach fairway, rough) and of the tee.
const CLASS_KEYS={green:[255,0,255],fringe:[0,255,255],yellow:[250,245,0],orange:[255,77,0],rough:[64,64,62]};
function Lstar(r,g,b){const f=c=>{c/=255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4)};const Y=.2126*f(r)+.7152*f(g)+.0722*f(b);return Y>.008856?116*Math.cbrt(Y)-16:903.3*Y}
// views: [{pose, yellow:'fairway'|'tee'}]. Default: overhead of the current green (+fringe, rough, nearby tees), overhead of the
// current tee, and overhead of the nearest large fairway.
function surfaceViews(){const w=window.__world();const over=(x,z,h)=>[x,w.elevation(x,z)+h,z+h*.45,0,-1.15];
 const fw=w.features.filter(f=>f.kind==='fairway'&&f.closed).map(f=>{const c=f.points.reduce((a,p)=>[a[0]+p[0]/f.points.length,a[1]+p[1]/f.points.length],[0,0]);return {c,d:Math.hypot(c[0]-w.pin.x,c[1]-w.pin.z)}}).sort((a,b)=>a.d-b.d)[0];
 const v=[{pose:over(w.pin.x,w.pin.z,45),yellow:'tee'},{pose:over(w.tee.x,w.tee.z,25),yellow:'tee'}];if(fw)v.push({pose:over(fw.c[0],fw.c[1],45),yellow:'fairway'});return v}
async function surfaceLightness(views=surfaceViews()){const prev=ss.get('grass')||0;const acc={};const add=(k,L)=>{(acc[k]??={s:0,n:0}).s+=L;acc[k].n++};
 for(const v of views){await setPose(v.pose);await new Promise(r=>setTimeout(r,600));const c=cap(640);
  const grab=()=>new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(()=>res(c.rgba()))));
  await setGrassView(0);await new Promise(r=>setTimeout(r,300));const img=await grab();await setGrassView(15);await new Promise(r=>setTimeout(r,300));const cls=await grab();
  for(let i=0;i<img.length;i+=4){let best=null,bd=45;for(const [k,col] of Object.entries(CLASS_KEYS)){const d=Math.abs(cls[i]-col[0])+Math.abs(cls[i+1]-col[1])+Math.abs(cls[i+2]-col[2]);if(d<bd){bd=d;best=k}}
   if(best){const k=best==='yellow'?v.yellow:best==='orange'?'tee':best;add(k,Lstar(img[i],img[i+1],img[i+2]))}}}
 await setGrassView(prev);const out={};for(const k of ['green','tee','fairway','fringe','rough'])out[k]=acc[k]?.n>200?+(acc[k].s/acc[k].n).toFixed(1):null;return out}
Object.assign(window.__dbg,{surfaceLightness,surfaceViews});
// ---- Perf reference harness: five fixed Pebble Beach hole-7 views, isolation settings (DR off, TAA off, fast lighting off).
// pose=[x,y(above ground),z,yaw,pitch]; y is resolved against the terrain so poses survive elevation changes.
const PERF_REFS={tee:[1.6,1.7,10,3.03,-.06],green:[6,1.7,84,2.82,-.15],bunker:[7,1.7,71,3.14,-.3],ocean:[-4,1.7,104,-2.09,-.14],rough:[26,1.2,60,-2.91,-.3],inland:[1.6,1.7,14,.4,-.05]};
const ALL_FX=['grass','surfaceDetail','ao','shadows','terrainShadows','clouds','atmosphere','bloom','water','trees','buildings','tracer'];
async function perfIsolation(){const d=window.__dbg;d.setDynRes(false);d.setTAA(false);d.setFastLighting(false);const g=R().gpu;return {taa:g.taaOn,fixedRes:g.fixedRes,fast:g.fastLighting,pxBudget:g.pxBudget}}
function fxOnly(keys){const o={};for(const k of ALL_FX)o[k]=keys==='all'||(Array.isArray(keys)&&keys.includes(k));R().setEffects(o);return o}
async function perfRef(name,{ms=2500,settle=1800}={}){const w=window.__world(),p=PERF_REFS[name];await setPose([p[0],w.elevation(p[0],p[2])+p[1],p[2],p[3],p[4]]);await new Promise(r=>setTimeout(r,settle));const r=await window.__perf(ms);return {ref:name,fps:r.fps,frameMs:r.frameMs,p95:r.p95,gpu:r.gpuSpan,cpu:r.cpuTickMs,res:r.res,systems:r.systems,passes:r.gpuPasses}}
// fx: 'all' | [] | ['grass',...]; returns one row per reference view
// the ground shader is compiled per effect set in the background (seconds): wait until this set's deferred pipelines exist
async function pipesReady(max=60000){const g=R().gpu,t0=performance.now();while(performance.now()-t0<max){const e=g.groundPipesFor((g.effectMask||0)>>>0);if(e?.ready&&e.def)return performance.now()-t0;await new Promise(r=>setTimeout(r,250))}return -1}
async function perfBench(fx=[],{refs=Object.keys(PERF_REFS),ms=2500,settle=1800}={}){const iso=await perfIsolation();fxOnly(fx);await new Promise(r=>setTimeout(r,300));iso.compileMs=Math.round(await pipesReady());await new Promise(r=>setTimeout(r,500));const out=[];for(const n of refs)out.push(await perfRef(n,{ms,settle}));return {iso,fx,rows:out}}
Object.assign(window.__dbg,{pipesReady,PERF_REFS,perfIsolation,fxOnly,perfRef,perfBench});
// full suite: all on, core only, then each effect alone, at every reference view; saved to .captures/perf_<tag>.json.png
const SUITE_CFGS=()=>[['all','all'],['core',[]],...ALL_FX.map(k=>[k,[k]])];
async function saveJSON(name,obj){return (await fetch('/__capture?name='+encodeURIComponent(name),{method:'POST',body:JSON.stringify(obj)})).ok}
async function perfSuite(tag='run',{cfgs=SUITE_CFGS(),ms=2000,settle=1500,refs}={}){const res={};window.__suite={tag,res,done:false,t0:Date.now()};
 for(const [n,fx] of cfgs){window.__suite.cur=n;res[n]=await perfBench(fx,{ms,settle,refs});}window.__suite.done=true;await saveJSON('perf_'+tag+'.json',res);return res}
// compact table: rows = config, cols = refs: gpu span and the config's own attributed ms
function perfTable(res){const out={};for(const [n,b] of Object.entries(res)){out[n]={};for(const r of b.rows){const own=n==='all'||n==='core'?r.gpu:(r.systems?.[n]??0);out[n][r.ref]=+own.toFixed(2)}}return out}
async function perfShots(tag,{refs=Object.keys(PERF_REFS)}={}){for(const n of refs){const w=window.__world(),p=PERF_REFS[n];await setPose([p[0],w.elevation(p[0],p[2])+p[1],p[2],p[3],p[4]]);await new Promise(r=>setTimeout(r,1500));await window.__capture(tag+'_'+n,2)}return 'ok'}
Object.assign(window.__dbg,{perfSuite,perfTable,perfShots,saveJSON});
async function goRef(name,wait=1200){const w=window.__world(),p=PERF_REFS[name];await setPose([p[0],w.elevation(p[0],p[2])+p[1],p[2],p[3],p[4]]);await new Promise(r=>setTimeout(r,wait))}
window.go=goRef;Object.assign(window.__dbg,{goRef});
// Interleaved A/B: the GPU's clocks/thermals drift by 2-3x over tens of seconds on this laptop, so configurations are compared
// inside one window, alternating every `block` frames. Each timed frame is tagged with the configuration it rendered.
// cfgs: {name:()=>apply}. Returns median span and per-pass medians for each, plus deltas vs the first.
async function abTest(cfgs,{ms=6000,block=6,warm=600}={}){const g=R().gpu,T=g.timer,names=Object.keys(cfgs);const was=g.timing;g.timing=true;
 let f=0,cur=-1;const orig=g.render;g.render=function(now){const k=Math.floor(f/block)%names.length;if(k!==cur){cur=k;cfgs[names[k]]();}T.tag=(f%block>=2)?names[k]:null;f++;return orig.call(this,now)};   /* first 2 frames of a block untagged: settle */
 await new Promise(r=>setTimeout(r,warm));const n0=T.rawN;await new Promise(r=>setTimeout(r,ms));g.render=orig;T.tag=null;g.timing=was;cfgs[names[0]]();
 const rs=T.raw.slice(T.raw.length-Math.min(T.rawN-n0,T.raw.length));const md=a=>{if(!a.length)return null;const q=[...a].sort((x,y)=>x-y);return +q[q.length>>1].toFixed(3)};const out={};
 for(const n of names){const x=rs.filter(r=>r.tag===n);const labs=new Set(x.flatMap(r=>Object.keys(r.cur)));const passes={};for(const l of labs)if(!l.startsWith('probe:'))passes[l]=md(x.map(r=>r.cur[l]||0));out[n]={n:x.length,span:md(x.map(r=>r.span)),passes}}
 for(const n of names)out[n].delta=+(out[n].span-out[names[0]].span).toFixed(3);return out}
Object.assign(window.__dbg,{abTest});
// Per-system cost at every reference view, measured as interleaved A/B against core-only (see abTest): the delta is the
// system's own cost at whatever clock the GPU is at; `core` is reported alongside as the clock reference.
// pause rendering so the GPU cools (this laptop throttles its GPU up to ~5x within minutes of sustained load)
async function gpuRest(ms){const r=R();r.manual=true;await new Promise(x=>setTimeout(x,ms));r.manual=false;requestAnimationFrame(r.tick);await new Promise(x=>setTimeout(x,300))}
async function perfDeltaSuite(tag='deltas',{keys=[...ALL_FX,'all'],refs=Object.keys(PERF_REFS),ms=3000,rest=0}={}){await perfIsolation();
 for(const k of keys){fxOnly(k==='all'?'all':k==='clouds'?['atmosphere','clouds']:[k]);await pipesReady();}fxOnly(['atmosphere']);await pipesReady();fxOnly([]);await pipesReady();const out={};window.__suite={tag,res:out,done:false,t0:Date.now()};
 for(const ref of refs){if(rest)await gpuRest(rest);await goRef(ref,1500);out[ref]={};for(const k of keys){window.__suite.cur=ref+'/'+k;const base=k==='clouds'?['atmosphere']:[];   /* the cloud deck is drawn by the Sky detail volumetrics pass: Clouds is measured on top of it */const o=await abTest({core:()=>fxOnly(base),on:()=>fxOnly(k==='all'?'all':[...base,k])},{ms});out[ref][k]={core:o.core.span,on:o.on.span,delta:o.on.delta,passes:o.on.passes,corePasses:o.core.passes};}}
 fxOnly([]);window.__suite.done=true;await saveJSON('perf_'+tag+'.json',out);return out}
Object.assign(window.__dbg,{perfDeltaSuite,gpuRest});
// Marginal cost of each system inside the full frame: all on vs all on except that system (interleaved A/B).
async function perfMarginalSuite(tag='marginal',{keys=ALL_FX,refs=Object.keys(PERF_REFS),ms=3000}={}){await perfIsolation();
 const allBut=k=>{const o={};for(const x of ALL_FX)o[x]=x!==k;R().setEffects(o)};for(const k of keys){allBut(k);await pipesReady();}fxOnly('all');await pipesReady();
 const out={};window.__suite={tag,res:out,done:false,t0:Date.now()};
 for(const ref of refs){await goRef(ref,1500);out[ref]={};for(const k of keys){window.__suite.cur=ref+'/'+k;const o=await abTest({all:()=>fxOnly('all'),without:()=>allBut(k)},{ms});out[ref][k]={all:o.all.span,without:o.without.span,delta:+(o.all.span-o.without.span).toFixed(3),passes:o.all.passes};}}
 fxOnly('all');window.__suite.done=true;await saveJSON('perf_'+tag+'.json',out);return out}
Object.assign(window.__dbg,{perfMarginalSuite});
// What the player sees: all systems on, fps / frame time without GPU timestamps, then the GPU span with them, per reference view
async function perfPlayer(tag='player',{refs=Object.keys(PERF_REFS),ms=2500}={}){await perfIsolation();fxOnly('all');await pipesReady();const out={};
 for(const ref of refs){await goRef(ref,1200);const a=await window.__perf(ms,{timing:false});const b=await window.__perf(1500);out[ref]={fps:a.fps,frameMs:a.frameMs,p95:a.p95,gpu:b.gpuSpan};}
 await saveJSON('perf_'+tag+'.json',out);return out}
Object.assign(window.__dbg,{perfPlayer});
