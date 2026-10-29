import {asset} from './asset.js';
import {AMBIENCE_LEVEL} from './audio.js';
// Two-voice commentary (Dale: calm American, Darren "Dazza" Buckley: unhinged Australian). Lines and voices live in commentary/script.json;
// the audio is generated from it by scripts/commentary.mjs. This module decides WHAT to say (classifyShot / introFor, pure
// and tested) and plays the exchanges with broadcast pacing (call, beat, response), ducking the ambience under the voices.
const YARD=.9144;const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const lieOf=s=>s==='green'?'green':s==='bunker'||s==='sand'?'bunker':s==='water'?'water':s==='fairway'||s==='tee'?'fairway':'rough';
export const introFor=par=>par<=3?'par3':par>=5?'par5':'par4';
export function holeFor(strokes,par){if(strokes===1)return 'ace';const d=strokes-par;return d<=-3?'albatross':d===-2?'eagle':d===-1?'birdie':d===0?'par':d===1?'bogey':d===2?'double':'worse';}
/** What the booth says about a shot. Returns {launch?, land?, putt?, hole?} situation keys (see commentary/script.json). */
export function classifyShot({result,start,pin,surfaceAt,clubType,clubCarryYd=150,power=100,strokes,par}){
 const end=result.end,sd=dist(start,pin),ed=dist(end,pin),startLie=lieOf(surfaceAt(start.x,start.z)),endLie=lieOf(surfaceAt(end.x,end.z));
 const out={};const putt=clubType==='putter'||startLie==='green';const wet=result.outcome==='water',ob=result.outcome==='out of bounds';
 if(putt){
  if(result.holed)out.putt=sd>4?'holed-long':'holed-short';
  else if(ed<=.6)out.putt='near-miss';
  else if(ed>3&&ed>sd*.5)out.putt='awful';
  else{const ux=(pin.x-start.x)/(sd||1),uz=(pin.z-start.z)/(sd||1);out.putt=(end.x-start.x)*ux+(end.z-start.z)*uz<sd?'short':'long';}
 }else{
  // launch call (while the ball is in the air): tee and approach shots only
  if(sd>45&&(result.flightTime??0)>=2){
   const expect=clubCarryYd*YARD*clamp(power/100,.3,1.1);const ux=(pin.x-start.x)/sd,uz=(pin.z-start.z)/sd;const lateral=Math.abs((end.x-start.x)*uz-(end.z-start.z)*ux);
   out.launch=wet||ob?'trouble':result.carry<expect*.6?'short':(endLie==='rough'||endLie==='bunker')&&lateral>Math.max(15,result.carry*.1)?'wayward':
    result.holed||(endLie==='green'&&ed<10)||(endLie==='fairway'&&result.carry>=expect*.9)?'great':'good';}
  if(wet)out.land='water';else if(ob)out.land='ob';else if(result.holed){if(strokes!==1)out.land='holed';}
  else out.land=endLie==='green'?(ed<=3?'green-close':'green'):endLie;
 }
 if(result.holed)out.hole=holeFor(strokes,par);
 return out;}

const PRIORITY={welcome:1,intro:1,launch:2,land:3,putt:3,hole:4};
export class Commentary{
 constructor(audio){this.audio=audio;this.script=null;this.enabled=true;this.volume=1;this.last={};this.queue=[];this.current=null;this.buffers=new Map();this.token=0;
  try{const s=JSON.parse(localStorage.getItem('fairway-commentary-v1')||'{}');if(typeof s.enabled==='boolean')this.enabled=s.enabled;if(Number.isFinite(s.volume))this.volume=clamp(s.volume);}catch{}
  this.ready=fetch(asset('commentary/script.json'),{cache:'no-cache'}).then(r=>r.json()).then(s=>this.script=s).catch(()=>null);}
 save(){try{localStorage.setItem('fairway-commentary-v1',JSON.stringify({enabled:this.enabled,volume:this.volume}))}catch{}}
 bus(){const a=this.audio;if(!a.ctx)return null;if(!this.gain){this.gain=a.ctx.createGain();this.gain.connect(a.master);}this.gain.gain.value=this.enabled?this.volume:0;return this.gain;}
 pick(moment,when){const list=(this.script?.exchanges||[]).filter(e=>e.moment===moment&&e.when===when&&!e.disabled);if(!list.length)return null;const key=moment+'/'+when;let i=Math.floor(Math.random()*list.length);if(list.length>1&&list[i].id===this.last[key])i=(i+1)%list.length;this.last[key]=list[i].id;return list[i];}
 async clip(ex,i){const l=ex.lines[i],file=`commentary/audio/${ex.id}-${i+1}-${l.who}.mp3`;let p=this.buffers.get(file);
  if(!p){p=fetch(asset(file)).then(r=>{if(!r.ok)throw Error(file);return r.arrayBuffer();}).then(b=>this.audio.ctx.decodeAudioData(b)).then(buf=>{
    // trim the silence the TTS leaves around a line, and match loudness between the two voices (voiced RMS -> -20 dBFS)
    const d=buf.getChannelData(0),th=.012;let s=0,e=d.length-1;while(s<d.length&&Math.abs(d[s])<th)s++;while(e>s&&Math.abs(d[e])<th)e--;let sum=0,n=0;for(let k=s;k<=e;k++){if(Math.abs(d[k])>th){sum+=d[k]*d[k];n++;}}
    const rms=Math.sqrt(sum/Math.max(n,1));return {buf,start:Math.max(0,s/buf.sampleRate-.02),end:Math.min(buf.duration,e/buf.sampleRate+.05),gain:clamp((.1/Math.max(rms,1e-4))**.65,.3,3)};/* partial normalisation: the voices sit together, a shout still lands louder */});this.buffers.set(file,p);}
  return p;}
 /** Say a line pair for (moment, situation). at: performance.now() ms to start (default now). Returns the playback promise. */
 say(moment,when,{at=performance.now(),then=null,expires=Infinity,chained=false}={}){if(!this.enabled||!when)return;this.queue.push({moment,when,at,then,expires,chained,prio:PRIORITY[moment]||1});this.pump();}
 cancel(){this.token++;this.queue.length=0;for(const s of this.current?.sources||[])try{s.stop();}catch{}this.current=null;this.duck(false);}
 duck(on){const b=this.audio.bedBus;if(!b||!this.audio.ctx)return;b.gain.setTargetAtTime(AMBIENCE_LEVEL*(on?.45:1),this.audio.ctx.currentTime,on?.12:.6);}
 async pump(){if(this.current||!this.queue.length)return;if(!(await this.ready)||this.audio.ctx?.state!=='running'){clearTimeout(this.waitT);this.waitT=setTimeout(()=>this.pump(),400);return;}   // hold the booth until the browser lets sound play
  this.queue.sort((a,b)=>a.at-b.at||b.prio-a.prio);const job=this.queue[0];const wait=job.at-performance.now();if(wait>30){clearTimeout(this.timer);this.timer=setTimeout(()=>this.pump(),wait);return;}
  this.queue.shift();
  // One conversation at a time: a new event is skipped (not queued) while the booth is talking or within 3 s of it finishing.
  // A chained follow-up (the hole call after the landing call, the first hole's intro after the welcome) is the same
  // conversation and goes ahead; if its lead-in was skipped, the follow-up is judged as an event of its own.
  const quiet=!this.current&&performance.now()-(this.lastEnd??-1e9)>=3000;
  if(performance.now()>job.expires||(!job.chained&&!quiet)){if(job.then)this.say(job.then.moment,job.then.when,{at:performance.now()+(job.then.gap??600)});if(!this.queue.length&&!this.current)this.duck(false);this.pump();return;}
  const ex=this.pick(job.moment,job.when);if(!ex){this.pump();return;}const token=this.token;this.current={sources:[],job};
  try{const clips=await Promise.all(ex.lines.map((_,i)=>this.clip(ex,i)));if(token!==this.token)return;const ctx=this.audio.ctx,bus=this.bus();this.duck(true);let t=ctx.currentTime+.05;
   clips.forEach((c,i)=>{const s=ctx.createBufferSource(),g=ctx.createGain();s.buffer=c.buf;g.gain.value=c.gain;s.connect(g);g.connect(bus);s.start(t,c.start,c.end-c.start);this.current.sources.push(s);
    // broadcast pacing: the response lands on the beat after the call; Darren jumps in, Dale takes a breath first
    const next=ex.lines[i+1];t+=c.end-c.start+(next?(next.who==='darren'?.22:.4)+Math.random()*.12:0);});
   await new Promise(r=>setTimeout(r,(t-ctx.currentTime)*1000+80));}catch(e){console.warn('commentary:',e.message);}
  if(token!==this.token)return;this.current=null;this.lastEnd=performance.now();if(job.then)this.say(job.then.moment,job.then.when,{at:performance.now()+(job.then.gap??600),chained:true});
  if(!this.queue.length)this.duck(false);this.pump();}
}
/** Wire the booth into the game. state(): {world, hole, round, course, mode, busy} */
export function installCommentary({audio,renderer,state}){
 const c=new Commentary(audio);window.__commentary=c;const introduced=new Set();let welcomed=false;   // the booth introduces itself once per session
 setInterval(()=>{const s=state();if(!s.world||!s.hole||!s.round||s.mode!=='play'||s.busy||renderer.overview||document.hidden)return;
  if(s.course?.stage!=='complete'||!s.world.playable||!s.world.terrainReady||!s.hole.par)return;const key=s.course.id+':'+s.hole.number;
  if(s.round.strokes===0&&!introduced.has(key)){introduced.add(key);const intro={moment:'intro',when:introFor(s.hole.par),gap:700};
   if(!welcomed){welcomed=true;c.say('welcome','session',{at:performance.now()+1200,then:intro});}else c.say('intro',intro.when,{at:performance.now()+1200});}
  if(s.round.strokes>0)introduced.add(key);},700);
 const panel=document.getElementById('sceneSettings');if(panel){const l=document.createElement('label');l.innerHTML='Commentary <output id="commentaryValue"></output><input id="commentaryVolume" aria-label="Commentary volume" type="range" min="0" max="1" step=".01">';
  const anchor=document.getElementById('soundVolume')?.closest('label');panel.insertBefore(l,anchor?anchor.nextSibling:panel.querySelector('p'));const inp=l.querySelector('input'),out=l.querySelector('output');
  const sync=()=>{inp.value=c.enabled?c.volume:0;out.value=c.enabled&&c.volume>0?Math.round(c.volume*100)+'%':'Off';};inp.oninput=e=>{const v=Number(e.target.value);c.volume=v;c.enabled=v>0;if(!c.enabled)c.cancel();c.bus();c.save();sync();};sync();}
 return {
  /** Right after the swing: schedules the launch call, the landing / putt call, and the hole call. */
  shot({result,start,pin,surfaceAt,club,power,strokes,par,impactAt}){c.queue.length=0;   // drop anything still pending from the last shot; whatever is being said now finishes, and this shot's calls only play if the booth has been quiet for 3 s by then
  audio.unlock?.();
   const k=classifyShot({result,start,pin,surfaceAt,clubType:club.type,clubCarryYd:club.carry,power,strokes,par});const rest=impactAt+(result.path?.at(-1)?.t??result.duration??3)*1000;
   if(k.launch)c.say('launch',k.launch,{at:impactAt+550,expires:rest-600});   // only while the ball is still in the air
   const after=k.land?'land':k.putt?'putt':null;const hole=k.hole?{moment:'hole',when:k.hole,gap:650}:null;
   if(after)c.say(after,k[after],{at:rest+350,then:hole});else if(hole)c.say('hole',k.hole,{at:rest+350});
   return k;},
  commentary:c};
}
