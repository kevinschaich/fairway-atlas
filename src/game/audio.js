import {asset} from './asset.js';
// Game audio (Web Audio API). Two parts:
//  1. Ambience: looping field-recording beds (birds, meadow insects, tropical forest, desert wind, mountain wind, night
//     insects, surf, gulls, distant sea, lake shore) mixed from where the listener is: latitude / climate, elevation, season,
//     time of day, and the distance to the mapped ocean and lakes. ambienceMix() is the pure mixing model (tested in node).
//  2. Shots: every swing is a whoosh plus a club-face impact. Driver, woods, hybrids, irons, wedges and the putter each
//     have their own pool of recorded impacts (chopped from multi-hit Freesound recordings) and a random alternative is
//     picked per swing, never the same one twice in a row, with slight pitch / level variation.
//  3. Ball: every bounce by the surface it lands on (fairway / rough / green / sand), the splash into water, the cup.
// Sound files are picked up by folder and file name (dist/audio/README.md); scripts/audio-manifest.mjs builds the manifest
// and the credits in CREDITS.md from them.
const BASE=asset('audio/');
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
// arid regions (lat range, lon range): the U.S. Southwest, northern Mexico, the Sahara / Sahel, Arabia & the Gulf, Iran,
// central Asia's deserts, inland Australia, the Atacama and Namib/Kalahari
const ARID=[[31,37.6,-118.2,-103],[24,31,-115,-100],[15,32,-17,35],[12,33,34,60],[25,36,52,64],[37,45,55,70],[-32,-18,118,145],[-28,-18,-71,-68],[-28,-17,12,25]];
/** Target level (0..1) of every ambience bed for a place and moment. o: {lat,lon,elev,month(1-12),hour,oceanDist,lakeDist} (m). */
export function ambienceMix(o){
 const lat=o.lat??40,lon=o.lon??0,h=o.hour??12,elev=o.elev??0,month=o.month??6,sea=o.oceanDist??Infinity,lake=o.lakeDist??Infinity;
 const day=smooth(5,7,h)*(1-smooth(19.5,21,h)),dusk=smooth(17.5,20,h)*(1-smooth(21,23,h)),night=1-day;
 const alat=Math.abs(lat),tropical=1-smooth(19,26,alat);
 const arid=ARID.some(([a,b,c,d])=>lat>=a&&lat<=b&&lon>=c&&lon<=d)?1:0;
 const mountain=smooth(1100,2000,elev);
 const summerN=[0,.1,.25,.5,.8,1,1,1,.8,.45,.15,0],season=lat>=0?summerN[(month-1+12)%12]:summerN[(month+5)%12];
 const temperate=(1-tropical)*(1-arid);
 const surf=1-smooth(70,420,sea),distantSea=(1-smooth(300,1800,sea))*(1-surf*.7),lakeShore=(1-smooth(15,140,lake))*(1-surf);
 return {
  birds:day*(temperate*(1-mountain*.4)*(.8+.2*season)+arid*.2)*(1-.3*surf),
  meadow:Math.max(day*temperate*season*(1-mountain)*.8,0)*(1-.5*surf),
  tropical:day*tropical*(1-.3*surf),
  desert:arid*(1-tropical)*(.7+.3*night),
  mountain:mountain*(.6+.4*day),
  night:(night+dusk*.5)*(1-mountain*.5)*(1-arid*.4)*(.4+.6*Math.max(season,tropical)),
  surf,gulls:surf*day*.8,'distant-sea':distantSea,lake:lakeShore};
}
export const AMBIENCE_LEVEL=.28;   // overall ambience level (~-11 dB): a bed under the game, never in front of it
const BED_GAIN={birds:1,meadow:.8,tropical:.9,desert:.8,mountain:.8,night:.7,surf:1,gulls:.5,'distant-sea':.8,lake:.9};
/** Which landing pool a mapped surface uses. */
export function landKind(surface){return surface==='green'?'green':surface==='bunker'||surface==='sand'?'sand':surface==='water'?'water':surface==='fairway'||surface==='tee'?'fairway':'rough';}
/** Ball sounds of a shot, from its simulated path: [{t (s after launch), kind, level 0..1, x, z}]. */
export function shotEvents(path,surfaceAt,outcome){const ev=[];let cup=false;
 for(let i=1;i<path.length;i++){const p=path[i],q=path[i-1];
  if(p.phase==='bounce'){const v=Math.hypot(q.vy,.35*Math.hypot(q.vx,q.vz));const level=clamp(v/14);const k=landKind(surfaceAt(p.x,p.z));
   if(level>.06&&!(ev.length&&p.t-ev.at(-1).t<.06))ev.push({t:p.t,kind:k,level:Math.max(.15,level),x:p.x,z:p.z});}
  else if(!cup&&(p.phase==='cup floor'||p.phase==='holed')){cup=true;ev.push({t:p.t,kind:'cup',level:1,x:p.x,z:p.z});}
  else if((p.phase==='rim'||p.phase==='cup wall')&&!(ev.length&&p.t-ev.at(-1).t<.08))ev.push({t:p.t,kind:'cup',level:.35,x:p.x,z:p.z});}
 if(outcome==='water'){const i=path.findIndex(p=>p.phase!=='flight'&&surfaceAt(p.x,p.z)==='water');const p=path[i>=0?i:path.length-1];
  const cut=ev.findIndex(e=>e.t>=p.t);if(cut>=0)ev.length=cut;ev.push({t:p.t,kind:'water',level:1,x:p.x,z:p.z});}
 return ev;}
/** Which impact pool a club type uses. */
export function shotFamily(type){return type==='driver'?'driver':type==='wood'?'wood':type==='hybrid'?'hybrid':type==='wedge'?'wedge':type==='putter'?'putter':'iron';}
const CLUB_SPEED={driver:1,wood:.9,hybrid:.8,iron:.7,wedge:.6,putter:.1};

export class GameAudio{
 constructor(){this.ctx=null;this.buffers=new Map();this.beds={};this.lastPick={};this.volume=.8;this.muted=false;this.manifest=null;
  try{const s=JSON.parse(localStorage.getItem('fairway-audio-v1')||'{}');if(Number.isFinite(s.volume))this.volume=clamp(s.volume);this.muted=!!s.muted;}catch{}
  this.ready=fetch(new URL('manifest.json',BASE)).then(r=>r.json()).then(m=>this.manifest=m).catch(()=>null);
  // Build the audio graph as soon as the page loads, so sound starts the moment the browser allows it: immediately where
  // autoplay is permitted, otherwise on the very first click / tap / key press anywhere (browsers require one gesture).
  this.unlock();
  const unlock=()=>{this.unlock();};for(const ev of ['pointerdown','keydown','touchend','click'])window.addEventListener(ev,unlock,{capture:true});}
 unlock(){
  // iOS: Web Audio follows the ringer switch unless the page's audio session is "playback" (Safari/WebKit 16.4+), and
  // an interrupted context (call, Siri, backgrounding) reports 'interrupted', not 'suspended'.
  try{if(navigator.audioSession&&navigator.audioSession.type!=='playback')navigator.audioSession.type='playback';}catch{}
  if(!this.iosKick&&/iPhone|iPad|iPod/.test(navigator.userAgent)||(!this.iosKick&&/Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1)){this.iosKick=true;try{const n=800,b=new DataView(new ArrayBuffer(44+n*2)),w=(o,t)=>{for(let k=0;k<t.length;k++)b.setUint8(o+k,t.charCodeAt(k))};w(0,'RIFF');b.setUint32(4,36+n*2,true);w(8,'WAVEfmt ');b.setUint32(16,16,true);b.setUint16(20,1,true);b.setUint16(22,1,true);b.setUint32(24,8000,true);b.setUint32(28,16000,true);b.setUint16(32,2,true);b.setUint16(34,16,true);w(36,'data');b.setUint32(40,n*2,true);const a=new Audio(URL.createObjectURL(new Blob([b],{type:'audio/wav'})));a.setAttribute('playsinline','');a.volume=0;a.play().catch(()=>{this.iosKick=false;});}catch{}}   /* older iOS: a media element play() in the gesture moves the session to playback */
  if(this.ctx){if(this.ctx.state!=='running'&&this.ctx.state!=='closed')this.ctx.resume().catch(()=>{});return;}const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;
  this.ctx=new AC();this.master=this.ctx.createGain();const lim=this.ctx.createDynamicsCompressor();lim.threshold.value=-3;lim.knee.value=2;lim.ratio.value=16;lim.attack.value=.002;lim.release.value=.12;this.master.connect(lim);lim.connect(this.ctx.destination);this.bedBus=this.ctx.createGain();this.bedBus.gain.value=AMBIENCE_LEVEL;this.bedBus.connect(this.master);this.sfxBus=this.ctx.createGain();this.sfxBus.connect(this.master);this.applyVolume();if(this.lastMix)this.setMix(this.lastMix);this.preload();this.ctx.resume().catch(()=>{});this.ctx.addEventListener('statechange',()=>this.onstate?.(this.ctx.state));}
 // decode every short effect up front (a few hundred KB): a swing must never wait on a fetch
 async preload(){if(!(await this.ready))return;const m=this.manifest;for(const e of [...m.whoosh,...Object.values(m.impact).flat(),...Object.values(m.land).flat()])this.buffer(e.file).then(b=>this.peakOf(b)).catch(()=>{});}
 save(){try{localStorage.setItem('fairway-audio-v1',JSON.stringify({volume:this.volume,muted:this.muted}))}catch{}}
 setVolume(v){this.volume=clamp(v);this.muted=this.volume===0?this.muted:false;this.applyVolume();this.save();}
 toggleMute(){this.muted=!this.muted;this.applyVolume();this.save();return this.muted;}
 applyVolume(){if(!this.master)return;this.master.gain.setTargetAtTime(this.muted?0:this.volume*this.volume,this.ctx.currentTime,.05);}
 async buffer(file){let p=this.buffers.get(file);if(!p){p=fetch(new URL(file,BASE)).then(r=>r.arrayBuffer()).then(b=>this.ctx.decodeAudioData(b));this.buffers.set(file,p);}return p;}
 pick(key,list){if(!list?.length)return null;let i=Math.floor(Math.random()*list.length);if(list.length>1&&i===this.lastPick[key])i=(i+1)%list.length;this.lastPick[key]=i;return list[i];}
 /** Crossfade the ambience beds toward a mix from ambienceMix(). */
 async setMix(mix){this.lastMix=mix;if(!this.ctx||!(await this.ready))return;const t=this.ctx.currentTime;
  for(const [name,level] of Object.entries(mix)){const def=this.manifest.ambience[name];if(!def?.length)continue;let bed=this.beds[name];const target=level*(BED_GAIN[name]??1);
   if(!bed&&target<.01)continue;
   if(!bed){bed=this.beds[name]={gain:this.ctx.createGain(),src:null,loading:true};bed.gain.gain.value=0;bed.gain.connect(this.bedBus);
    const e=this.pick('bed:'+name,def);this.buffer(e.file).then(buf=>{const s=this.ctx.createBufferSource(),fg=this.ctx.createGain();fg.gain.value=e.gain??1;s.buffer=buf;s.loop=true;s.connect(fg);fg.connect(bed.gain);s.start(0,Math.random()*buf.duration);bed.src=s;bed.loading=false;}).catch(()=>{});}
   bed.gain.gain.setTargetAtTime(target,t,1.2);}}
 pool(group,kind){const g=this.manifest?.[group];return kind==null?g:g?.[kind];}
 /** A swing: whoosh, then the club-face impact at impactAt (performance.now() ms). power 0..1.1; dist: camera-to-ball metres. */
 async swing(type,power=1,impactAt=performance.now(),dist=3){if(!this.ctx||!(await this.ready))return;const fam=shotFamily(type);
  const now=this.ctx.currentTime,tImpact=now+Math.max(0,(impactAt-performance.now())/1000),p=clamp(power,0,1.1),sp=CLUB_SPEED[fam]??.7;
  const att=clamp(6/Math.max(dist,1),.12,1);const list=this.pool('impact',fam)?.length?this.pool('impact',fam):this.pool('impact','iron');
  const w=fam!=='putter'?this.pick('whoosh',this.pool('whoosh')):null,e=this.pick('impact:'+fam,list);
  const [wb,ib]=await Promise.all([w?this.buffer(w.file):null,e?this.buffer(e.file):null]);
  if(wb){const rate=.82+.32*sp*p+(Math.random()-.5)*.06,pk=this.peakOf(wb)/rate;   // the whoosh crests ~30 ms before the ball, then gets out of its way
   const start=Math.max(now,tImpact-pk-.03);this.play(wb,start,rate,(.12+.3*sp*p)*att*(w.gain??1),tImpact+.02);}
  if(ib){const lvl=fam==='putter'?(.45+.55*clamp(p/.6)):(.7+.5*p);this.play(ib,Math.max(now,tImpact),1+(Math.random()-.5)*.07,lvl*att*(e.gain??1));}}
 /** Ball sounds of a shot (bounces by surface, water, cup). start: performance.now() ms of launch (t = 0 of the path). */
 async ballSounds(events,start,listener){if(!this.ctx||!events.length||!(await this.ready))return;this.cancelBall();const now=this.ctx.currentTime;
  for(const ev of events){const list=this.pool('land',ev.kind);if(!list?.length)continue;const e=this.pick('land:'+ev.kind,list);const buf=await this.buffer(e.file);
   const when=now+(start+ev.t*1000-performance.now())/1000;if(when<this.ctx.currentTime-.05)continue;const att=listener?listener(ev):1;
   const lvl=(ev.kind==='water'||ev.kind==='cup'?.9:.35+.75*ev.level)*ev.level**.3*att*(e.gain??1);const rate=ev.kind==='water'||ev.kind==='cup'?1+(Math.random()-.5)*.06:.9+.2*ev.level+(Math.random()-.5)*.05;
   this.ballSrc.push(this.play(buf,Math.max(this.ctx.currentTime,when),rate,lvl));}}
 cancelBall(){for(const s of this.ballSrc||[])try{s.stop();}catch{}this.ballSrc=[];}
 peakOf(buf){if(buf._pk!=null)return buf._pk;const d=buf.getChannelData(0);let m=0,k=0;for(let i=0;i<d.length;i++){const a=Math.abs(d[i]);if(a>m){m=a;k=i;}}return buf._pk=k/buf.sampleRate;}
 play(buf,when,rate,level,duckAt=null){const s=this.ctx.createBufferSource(),g=this.ctx.createGain();s.buffer=buf;s.playbackRate.value=rate;g.gain.value=level;
  if(duckAt!=null&&duckAt>when){g.gain.setValueAtTime(level,duckAt);g.gain.linearRampToValueAtTime(level*.25,duckAt+.06);}s.connect(g);g.connect(this.sfxBus);s.start(when);return s;}
}

// distance from (x,z) to a closed polygon (0 inside)
function polyDist(pts,x,z){let inside=false,best=Infinity;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const [ax,az]=pts[j],[bx,bz]=pts[i];
  if(((az>z)!==(bz>z))&&x<(bx-ax)*(z-az)/(bz-az)+ax)inside=!inside;const dx=bx-ax,dz=bz-az,l=dx*dx+dz*dz;const t=l?clamp(((x-ax)*dx+(z-az)*dz)/l):0;const ex=ax+dx*t-x,ez=az+dz*t-z;best=Math.min(best,ex*ex+ez*ez);}
 return inside?0:Math.sqrt(best);}
/** Where the listener is, for ambienceMix(): distances to the mapped ocean (OSM coastline water) and to lakes / ponds. */
export function listenerEnvironment(world,pos,lighting){
 const [lon,lat]=world.toGeo({x:pos.x,z:pos.z});const ground=world.elevation(pos.x,pos.z)||0;const agl=Math.max(0,pos.y-ground);
 let ocean=Infinity,lake=Infinity;for(const f of world.features){if(!f.closed||f.kind!=='water'||!f.points?.length)continue;const d=polyDist(f.points,pos.x,pos.z);
  if(String(f.id).startsWith('coast-water'))ocean=Math.min(ocean,d);else lake=Math.min(lake,d);}
 // the renderer floods unmapped sea below the ocean's level: treat low-lying water under the listener as ocean too
 if(ocean===Infinity&&world.surfaces?.some(f=>String(f.id).startsWith('coast-water'))&&world.surface(pos.x,pos.z)==='water')ocean=0;
 const d3=(d)=>d===Infinity?d:Math.hypot(d,agl*.8);
 const date=new Date((lighting?.date||'2026-06-21')+'T12:00:00Z');
 return {lat,lon,elev:ground,month:date.getUTCMonth()+1,hour:lighting?.hour??12,oceanDist:d3(ocean),lakeDist:d3(lake)};
}
/** Wire audio into the game: ambience follows the camera; the sound control sits in the Appearance panel. */
export function installAudio({renderer,getWorld}){
 const audio=new GameAudio();window.__audio=audio;   // console: __audio.lastMix, __audio.swing('driver',1)
 // until the browser lets sound start, a small hint says one click turns it on (it disappears the moment audio runs)
 {const pill=document.createElement('button');pill.type='button';pill.className='sound-hint';pill.textContent='🔈 Click anywhere for sound';pill.hidden=true;document.body.append(pill);
  const show=st=>{pill.hidden=st==='running'||audio.muted;};pill.onclick=()=>audio.unlock();audio.onstate=show;setTimeout(()=>show(audio.ctx?.state),900);}
 setInterval(()=>{const w=getWorld();if(!w||!renderer.camera||document.hidden)return;try{audio.setMix(ambienceMix(listenerEnvironment(w,renderer.camera.position,renderer.lighting)));}catch(e){}},700);
 const panel=document.getElementById('sceneSettings');if(panel){const l=document.createElement('label');l.innerHTML='Sound <output id="soundValue"></output><input id="soundVolume" aria-label="Sound volume" type="range" min="0" max="1" step=".01">';
  const p=panel.querySelector('p');panel.insertBefore(l,p||null);const inp=l.querySelector('input'),out=l.querySelector('output');const sync=()=>{inp.value=audio.muted?0:audio.volume;out.value=audio.muted?'Muted':Math.round(audio.volume*100)+'%';};
  inp.oninput=e=>{audio.setVolume(Number(e.target.value));if(Number(e.target.value)>0)audio.muted=false;audio.applyVolume();audio.save();sync();};sync();audio.sync=sync;}
 window.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='m'&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!/input|textarea|select/i.test(e.target?.tagName||'')){audio.unlock();audio.toggleMute();audio.sync?.();}});
 return audio;
}
