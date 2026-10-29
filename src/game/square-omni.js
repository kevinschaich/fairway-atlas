// Square Golf Omni launch monitor over Web Bluetooth (desktop Chrome).
//
// Protocol sources, cross-checked against each other:
//  - divotmaker/allsquare docs/WIRE.md + SEQUENCE.md: verified on Omni hw 3.1, lm fw 1.5.8
//    (UUIDs, frame layouts, 0x07 validity mask, 0x91 battery, duplicate notifications,
//    stale club packets, Omni club codes, sidespin/axis sign inversion).
//  - patrickhult/squaregolf-connector, chrisjack/SquareConnector, DoGBoNE-GC/SquareGolf (Go):
//    same UUIDs and frame offsets, original-Square club codes, post-shot re-arm of
//    DetectBall only, time-bounded ball-packet dedup, and SpinAxis/SideSpin * -1 for sims.
//  - divotmaker/flighthook (production Omni integration built on allsquare): zero-spin misread rejection
//    for non-putter shots, and face impact withheld because the raw values are not face-centred.
//  - dallinf/square-golf-data, jDelille/golf-analyzer, UrAvgPharmGuy/SquareGolf: the Square
//    app's CSV export (ball speed, launch dir/angle, spin rate/axis, back/side spin, club
//    path, face, attack, dynamic loft) confirms the metric set the app surfaces.
// Wire units are always m/s, degrees and RPM, whatever the device's display units are set to.

export const UUID=Object.freeze({
 service:'86601001-6b7e-439a-bdd1-489a3213e9bb',
 deviceId:'86602001-6b7e-439a-bdd1-489a3213e9bb',
 hardware:'86602002-6b7e-439a-bdd1-489a3213e9bb',
 firmware:'86602003-6b7e-439a-bdd1-489a3213e9bb',
 command:'86602101-6b7e-439a-bdd1-489a3213e9bb',// write with response
 events:'86602102-6b7e-439a-bdd1-489a3213e9bb'// notify
});
export const CMD=Object.freeze({detectBall:0x81,clubSelect:0x82,heartbeat:0x83,query:0x86,requestClubMetrics:0x87});
export const DEVICE_STATES=['none','idle','initialising','detecting','ready','shot','done'];
export const CHARGING=['not charging','discharging','charging','full','no battery','unknown'];
export const MPS_TO_MPH=1/0.44704;
const SPIN_ADVANCED=0x11;
export const HEARTBEAT_MS=5000,CLUB_WAIT_MS=1200,REARM_DELAY_MS=500,REARM_WINDOW_MS=800,DEDUP_MS=1500,STALE_MS=12000;

// Omni: {number, category}; category 0 driver, 1 wood/hybrid, 2 iron/wedge, 3 putter (allsquare club.rs).
// Codes marked inferred by allsquare: 5W, 7W, 4H, 3I, LW.
// Verified on a real Omni (lm 1.5.8): heartbeat ack byte 5 echoes the selected category (0 driver, 1 wood/hybrid,
// 2 iron/wedge, 3 putter) and matched for every club in the game's bag. The club number is not echoed; numbers
// agree across allsquare (app capture) and brentyates/squaregolf-connector v0.2.1-alpha.1, except the driver
// (01 vs 02), where the app capture is used. The device also mapped an original-Square putter category (07) to 3.
const OMNI_CLUBS={DR:[1,0],'3W':[3,1],'5W':[5,1],'7W':[7,1],'3H':[13,1],'4H':[14,1],'5H':[15,1],'3I':[3,2],'4I':[4,2],'5I':[5,2],'6I':[6,2],'7I':[7,2],'8I':[8,2],'9I':[9,2],PW:[10,2],GW:[11,2],AW:[11,2],SW:[12,2],LW:[13,2],PT:[1,3]};
// Original Square / Square Home "regular" codes (Go connectors' constants.go). No hybrid or lob-wedge
// codes exist there, so those map to the nearest club the device knows.
const LEGACY_CLUBS={DR:[2,4],'3W':[3,5],'5W':[5,5],'7W':[7,5],'3H':[3,5],'4H':[4,6],'5H':[5,6],'4I':[4,6],'5I':[5,6],'6I':[6,6],'7I':[7,6],'8I':[8,6],'9I':[9,6],PW:[10,6],GW:[11,6],AW:[11,6],SW:[12,6],LW:[12,6],PT:[1,7]};
const BY_TYPE={driver:'DR',wood:'3W',hybrid:'4H',iron:'7I',wedge:'SW',putter:'PT'};
export function clubCode(club,profile='omni'){const table=profile==='legacy'?LEGACY_CLUBS:OMNI_CLUBS;const key=club?.abbr&&table[club.abbr]?club.abbr:BY_TYPE[club?.type]||'7I';return{key,code:table[key]};}
// Omni hardware reports "3.1". Anything that clearly reports an older major version gets the
// original-Square club table; unknown or unreadable versions are treated as an Omni.
export function profileFor(hardware){const major=parseInt(String(hardware||'').trim(),10);return Number.isFinite(major)&&major>0&&major<3?'legacy':'omni';}

// Host -> device: always 9 bytes, [direction, type, seq, payload...]. allsquare (Omni) sends 0x00 as the
// first byte and notes the device ignores it; the Go connectors (original Square) send 0x11.
export function encodeCommand(type,seq,payload=[],profile='omni'){const b=new Uint8Array(9);b[0]=profile==='legacy'?0x11:0x00;b[1]=type;b[2]=seq&255;for(let i=0;i<payload.length&&i<6;i++)b[3+i]=payload[i]&255;return b;}
export const commands={
 heartbeat:(seq,p)=>encodeCommand(CMD.heartbeat,seq,[],p),
 query:(seq,p)=>encodeCommand(CMD.query,seq,[],p),
 requestClubMetrics:(seq,p)=>encodeCommand(CMD.requestClubMetrics,seq,[],p),
 detectBall:(seq,on,p)=>encodeCommand(CMD.detectBall,seq,[on?1:0,SPIN_ADVANCED],p),
 clubSelect:(seq,[number,category],handed,p)=>encodeCommand(CMD.clubSelect,seq,[number,category,handed==='left'?1:0],p)
};

const CLUB_FIELDS=['path','face','attack','loft','impactH','impactV','clubSpeed','smash'];
// Device -> host. Byte 0 is a message family (0x11 data, 0x71 clock, 0x91 battery), not a magic number.
export function parseNotification(input){
 const b=input instanceof Uint8Array?input:new Uint8Array(input.buffer?input.buffer.slice(input.byteOffset,input.byteOffset+input.byteLength):input);
 if(!b.length)return{kind:'disconnect'};
 const dv=new DataView(b.buffer,b.byteOffset,b.byteLength),i16=o=>dv.getInt16(o,true),i32=o=>dv.getInt32(o,true);
 if(b[0]===0x91)return b.length>=3?{kind:'battery',percent:Math.min(100,b[1]),charging:CHARGING[b[2]]??'unknown'}:null;
 if(b[0]===0x71)return{kind:'clock'};
 if(b[0]!==0x11||b.length<2)return null;
 switch(b[1]){
  case 0x01:return b.length<5?null:{kind:'sensor',ready:b[3]===1||b[3]===2,detected:b[4]===1,position:b.length>=17?[i32(5),i32(9),i32(13)]:null};
  case 0x02:return b.length<17?null:{kind:'ball',shotType:b[2],speed:i16(3)/100,launch:i16(5)/100,direction:i16(7)/100,totalSpin:i16(9),spinAxis:i16(11)/100,backspin:i16(13),sideSpin:i16(15)};
  case 0x03:return b.length<4?null:{kind:'heartbeat',code:b[3],state:DEVICE_STATES[b[3]]??'unknown'};
  case 0x04:return b.length<7?null:{kind:'alignment',aim:i16(5)/100};
  case 0x06:return{kind:'query'};
  case 0x07:{
   // Byte 2 is a per-field validity mask; unmeasured fields are also 0xFFFF. Check both, never the length:
   // the Omni sends 19 bytes even when nothing was tracked, the original Square can send just "11 07 00".
   const mask=b.length>2?b[2]:0,club={kind:'club',mask};
   CLUB_FIELDS.forEach((name,i)=>{const o=3+2*i;if(o+2>b.length||!(mask>>i&1))return;const raw=i16(o);if(raw===-1)return;club[name]=raw/100;});
   return club;}
  default:return{kind:'unknown',type:b[1]};
 }
}

const inRange=(v,a,b)=>Number.isFinite(v)&&v>=a&&v<=b;
// Device shot -> the game's launch contract (launch-input.js): mph, degrees, RPM, mm;
// horizontal + = right of target, sidespin + = curving right, impact x + = target-right.
export function toLaunchData(ball,club={},{handed='right',impact=false}={}){
 let back=ball.backspin,side=ball.sideSpin;
 // Standard-spin packets can carry only total spin + axis; rebuild the components (device signs).
 if(!back&&!side&&ball.totalSpin){const a=ball.spinAxis*Math.PI/180;back=ball.totalSpin*Math.cos(a);side=ball.totalSpin*Math.sin(a);}
 const out={units:'mph-deg-rpm-mm',ballSpeed:ball.speed*MPS_TO_MPH,ballDirection:ball.direction,ballElevation:ball.launch,backspin:back,sideSpin:side===0?0:-side};
 const put=(key,value,min,max)=>{if(inRange(value,min,max))out[key]=value;};
 put('clubSpeed',club.clubSpeed*MPS_TO_MPH,0.1,180);put('pathAngle',club.path,-90,90);put('faceAngle',club.face,-90,90);
 put('attackAngle',club.attack,-60,60);put('dynamicLoft',club.loft,-15,90);
 // Face impact is withheld by default: flighthook found a flush centre strike reads well off the face, so the raw
 // values need a calibration nobody has published yet. Opt in with {impact:true} once one exists.
 // Device: negative = toe (right-handed). A right-hander's toe points target-right; a left-hander's heel does.
 if(impact&&Number.isFinite(club.impactH)&&Number.isFinite(club.impactV)){const x=handed==='left'?club.impactH:-club.impactH;if(Math.abs(x)<=60&&Math.abs(club.impactV)<=60)out.impactPoint={x,y:club.impactV};}
 return out;
}
// Everything the device measured, in display units, for the panel and saved shot details.
export function deviceMetrics(ball,club={}){
 return{ballSpeedMph:ball.speed*MPS_TO_MPH,launch:ball.launch,direction:ball.direction,totalSpin:ball.totalSpin,spinAxis:ball.spinAxis?-ball.spinAxis:0,backspin:ball.backspin,sideSpin:ball.sideSpin?-ball.sideSpin:0,
  clubSpeedMph:Number.isFinite(club.clubSpeed)?club.clubSpeed*MPS_TO_MPH:null,smash:club.smash??null,path:club.path??null,face:club.face??null,attack:club.attack??null,dynamicLoft:club.loft??null,impactH:club.impactH??null,impactV:club.impactV??null,clubMask:club.mask??0,shotType:ball.shotType};
}

// A struck ball always spins. The Omni sometimes returns zero spin for a ball at the front edge of its
// detection zone; such a shot flies ~30 yd long, so it is dropped. Putts always read zero spin and are kept.
export function isZeroSpinMisread(ball,club){return club?.type!=='putter'&&!ball.totalSpin&&!ball.backspin&&!ball.sideSpin;}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const decode=v=>{try{return new TextDecoder().decode(v).replace(/\0+$/,'').trim()}catch{return''}};

// Connection + session state machine. Emits 'status' (on any change) and 'shot' ({detail:{ball,club,launchData,metrics}}).
export class SquareOmni extends EventTarget{
 constructor({getClub=()=>null,handed='right',now=()=>performance.now()}={}){
  super();this.getClub=getClub;this.handed=handed;this.now=now;
  this.status={link:'idle',error:'',deviceName:'',hardware:'',firmware:null,deviceId:'',profile:'omni',battery:null,charging:'',deviceState:'none',armed:false,ballDetected:false,ballReady:false,lastSensorAt:0,lastRxAt:0,club:'',shots:0};
  this.seq=0;this.queue=Promise.resolve();this.lastRx=null;this.lastRxAt=0;this.pending=null;this.userClosed=false;this.retries=0;this.lastRearm=0;
  this._onNotify=e=>this.receive(new Uint8Array(e.target.value.buffer.slice(e.target.value.byteOffset,e.target.value.byteOffset+e.target.value.byteLength)));
  this._onGone=()=>this._lost();
 }
 static supported(){return typeof navigator!=='undefined'&&!!navigator.bluetooth&&(typeof isSecureContext==='undefined'||isSecureContext);}
 set(patch){Object.assign(this.status,patch);this.dispatchEvent(new CustomEvent('status',{detail:this.status}));}
 get connected(){return this.status.link==='connected'&&!!this.device?.gatt?.connected;}
 // Must be called from a user gesture: requestDevice is the first await.
 async connect({showAll=false}={}){
  if(!SquareOmni.supported())throw Error(typeof isSecureContext!=='undefined'&&!isSecureContext?'Web Bluetooth needs HTTPS or localhost.':'Web Bluetooth is not available in this browser. Use desktop Chrome.');
  // Same lesson as the terminal console: the Omni's name arrives in its scan response, so a name-only filter can miss
  // it. Also match the service ID and the Omni's manufacturer data (company 0xFFFF, model code "0300A").
  // showAll lists every nearby device as a last resort; the service still has to be listed in optionalServices.
  const device=await navigator.bluetooth.requestDevice(showAll?{acceptAllDevices:true,optionalServices:[UUID.service]}:
   {filters:[{namePrefix:'SquareGolf'},{services:[UUID.service]},{manufacturerData:[{companyIdentifier:0xffff}]}],optionalServices:[UUID.service]});
  return this.attach(device);
 }
 async attach(device){
  if(this.device&&this.device!==device){this.device.removeEventListener('gattserverdisconnected',this._onGone);}
  this.device=device;this.userClosed=false;this.retries=0;device.removeEventListener('gattserverdisconnected',this._onGone);device.addEventListener('gattserverdisconnected',this._onGone);
  this.set({deviceName:device.name||'SquareGolf'});
  try{await this._open();}catch(e){const cancelled=this.userClosed;this.userClosed=true;if(this.device?.gatt?.connected)try{this.device.gatt.disconnect()}catch{}
   if(cancelled){this.set({link:'idle',error:''});return;}this.set({link:'error',error:e.message||String(e)});throw e;}
 }
 async _open(){
  this.set({link:'connecting',error:'',armed:false,ballDetected:false,ballReady:false,deviceState:'none'});
  const server=await this.device.gatt.connect();await sleep(250);
  // Discovery occasionally returns before characteristics resolve; retry (allsquare: 4 attempts suffice).
  let service,err;for(let i=0;i<4&&!service;i++){try{service=await server.getPrimaryService(UUID.service)}catch(e){err=e;await sleep(400)}}
  if(!service)throw err||Error('Square service not found.');
  this.command=await service.getCharacteristic(UUID.command);const events=await service.getCharacteristic(UUID.events);await sleep(250);
  if(this.events)this.events.removeEventListener('characteristicvaluechanged',this._onNotify);
  this.events=events;events.addEventListener('characteristicvaluechanged',this._onNotify);await events.startNotifications();
  const read=async uuid=>{try{return decode(await (await service.getCharacteristic(uuid)).readValue())}catch{return''}};
  const hardware=await read(UUID.hardware),fwText=await read(UUID.firmware),deviceId=await read(UUID.deviceId);
  let firmware=null;try{firmware=JSON.parse(fwText)}catch{firmware=fwText?{raw:fwText}:null}
  this.lastRx=null;this.pending=null;this.lastRxAt=this.now();this.clubKey=null;
  this.set({hardware,firmware,deviceId,profile:profileFor(hardware),lastRxAt:this.lastRxAt});
  await this.send(commands.query(this.nextSeq(),this.status.profile));
  await this.send(commands.heartbeat(this.nextSeq(),this.status.profile));
  await this.syncClub(true);
  await this.send(commands.detectBall(this.nextSeq(),true,this.status.profile));
  this.retries=0;this.set({link:'connected',armed:true});this._startTimers();
 }
 nextSeq(){this.seq=(this.seq+1)&255;return this.seq;}
 // GATT operations must not overlap; serialise every write.
 send(bytes){const c=this.command;const run=()=>c.writeValueWithResponse?c.writeValueWithResponse(bytes):c.writeValue(bytes);const p=this.queue.then(run);this.queue=p.catch(()=>{});return p;}
 async syncClub(force=false){
  const club=this.getClub?.();const {key,code}=clubCode(club,this.status.profile),id=key+'/'+this.handed;
  if(!force&&id===this.clubKey)return;this.clubKey=id;this.set({club:club?.name||key});
  await this.send(commands.clubSelect(this.nextSeq(),code,this.handed,this.status.profile));
 }
 setHanded(h){this.handed=h==='left'?'left':'right';if(this.connected)this.syncClub(true).catch(e=>this._fail(e));}
 _startTimers(){
  this._stopTimers();
  this.heartbeatTimer=setInterval(()=>{if(!this.connected)return;this.send(commands.heartbeat(this.nextSeq(),this.status.profile)).catch(e=>this._fail(e));},HEARTBEAT_MS);
  // Cheap poll: keeps the device's club (which tunes putting detection) in step with the game's.
  this.clubTimer=setInterval(()=>{if(this.connected)this.syncClub().catch(e=>this._fail(e));},700);
  this.staleTimer=setInterval(()=>{const stale=this.now()-this.lastRxAt>STALE_MS;if(stale!==!!this.status.stale)this.set({stale});},1000);
 }
 _stopTimers(){clearInterval(this.heartbeatTimer);clearInterval(this.clubTimer);clearInterval(this.staleTimer);clearTimeout(this.clubWait);clearTimeout(this.rearmTimer);}
 _fail(e){console.warn('Square Omni:',e);if(!this.device?.gatt?.connected)return;this.set({error:e.message||String(e)});}
 receive(bytes){
  const now=this.now();
  // Every notification arrives twice, byte-identical. Only drop an exact repeat of the previous frame
  // seen within a short window, so identical back-to-back tap-in putts still count.
  if(this.lastRx&&bytes.length===this.lastRx.length&&bytes.every((v,i)=>v===this.lastRx[i])&&now-this.lastRxAt<DEDUP_MS){this.lastRxAt=now;return null;}
  this.lastRx=bytes;this.lastRxAt=now;
  const n=parseNotification(bytes);if(!n)return null;
  const patch={lastRxAt:now};if(this.status.stale)patch.stale=false;
  switch(n.kind){
   case 'disconnect':this._lost();return n;
   case 'sensor':Object.assign(patch,{ballDetected:n.detected,ballReady:n.ready,lastSensorAt:now,armed:true});break;
   case 'heartbeat':Object.assign(patch,{deviceState:n.state});if(n.state==='ready'||n.state==='detecting')patch.armed=true;break;
   case 'battery':Object.assign(patch,{battery:n.percent,charging:n.charging});break;
   case 'ball':
    // Ball data is pushed, club data must be pulled. Hold the ball until the club reply (or a timeout).
    this.pending={ball:n};clearTimeout(this.clubWait);this.clubWait=setTimeout(()=>this._finish(null),CLUB_WAIT_MS);
    if(this.command)this.send(commands.requestClubMetrics(this.nextSeq(),this.status.profile)).catch(e=>this._fail(e));
    Object.assign(patch,{ballReady:false,ballDetected:false,deviceState:'shot'});break;
   case 'club':
    // The device keeps the last shot's club data across reconnects: only accept a reply to our own request.
    if(this.pending){clearTimeout(this.clubWait);this._finish(n);}break;
  }
  this.set(patch);return n;
 }
 _finish(club){
  const p=this.pending;this.pending=null;if(!p)return;
  if(isZeroSpinMisread(p.ball,this.getClub?.())){this.set({deviceState:'done'});this.dispatchEvent(new CustomEvent('discard',{detail:{ball:p.ball,club,metrics:deviceMetrics(p.ball,club||{}),reason:'zero-spin'}}));this._rearm();return;}
  const launchData=toLaunchData(p.ball,club||{},{handed:this.handed}),metrics=deviceMetrics(p.ball,club||{});
  this.set({shots:this.status.shots+1,lastShot:metrics,deviceState:'done'});
  this.dispatchEvent(new CustomEvent('shot',{detail:{ball:p.ball,club,launchData,metrics}}));
  this._rearm();
 }
 // The device stays armed across shots, but the official app and the Go connectors re-send DetectBall
 // (not ClubSelect, which resets putter tuning) after each shot. Coalesce so it is sent once.
 _rearm(){const now=this.now();if(now-this.lastRearm<REARM_WINDOW_MS)return;this.lastRearm=now;clearTimeout(this.rearmTimer);
  this.rearmTimer=setTimeout(()=>{if(this.connected)this.send(commands.detectBall(this.nextSeq(),true,this.status.profile)).catch(e=>this._fail(e));},REARM_DELAY_MS);}
 async _lost(){
  this._stopTimers();this.pending=null;
  if(this.userClosed||!this.device){this.set({link:'idle',armed:false,ballReady:false,ballDetected:false});return;}
  if(this.reconnecting)return;this.reconnecting=true;
  try{
   while(!this.userClosed&&this.retries<5){
    this.retries++;this.set({link:'reconnecting',armed:false,ballReady:false,ballDetected:false,error:`Connection lost · retry ${this.retries} of 5`});
    await sleep(Math.min(8000,1000*2**(this.retries-1)));if(this.userClosed)break;
    try{await this._open();return;}catch(e){this.set({error:e.message||String(e)});}
   }
   if(!this.userClosed)this.set({link:'error',error:'Connection lost. Check the device is on and nearby, then reconnect.'});
  }finally{this.reconnecting=false;}
 }
 async disconnect(){
  this.userClosed=true;this._stopTimers();
  try{if(this.connected)await Promise.race([this.send(commands.detectBall(this.nextSeq(),false,this.status.profile)),sleep(400)]);}catch{}
  try{this.events?.removeEventListener('characteristicvaluechanged',this._onNotify);}catch{}
  try{if(this.device?.gatt?.connected)this.device.gatt.disconnect();}catch{}
  this.set({link:'idle',armed:false,ballReady:false,ballDetected:false,error:'',stale:false});
 }
 async reconnect(){if(!this.device)return this.connect();this.userClosed=false;this.retries=0;try{await this._open();}catch(e){this.set({link:'error',error:e.message||String(e)});throw e;}}
}

// Traffic light for the HUD: red = not connected, yellow = connecting / problem / not ready,
// green = connected, listening and a ball is in position.
export function lightFor(s,supported=true,now=performance.now()){
 if(!supported)return{light:'red',text:'Web Bluetooth unavailable'};
 if(s.link==='idle')return{light:'red',text:'Not connected'};
 if(s.link==='error')return{light:'red',text:s.error||'Connection failed'};
 if(s.link==='connecting')return{light:'yellow',text:'Connecting…'};
 if(s.link==='reconnecting')return{light:'yellow',text:s.error||'Reconnecting…'};
 if(s.stale)return{light:'yellow',text:'Device not responding'};
 if(!s.armed)return{light:'yellow',text:'Arming ball detection…'};
 // Idle Omni (lm 1.5.8) sends a sensor frame every ~3-4 s, so allow 10 s before falling back to the heartbeat state if it goes quiet.
 const ready=s.lastSensorAt&&now-s.lastSensorAt<10000?s.ballReady:s.deviceState==='ready';
 if(ready)return{light:'green',text:'Ball ready · swing away'};
 if(s.deviceState==='shot')return{light:'yellow',text:'Reading shot…'};
 if(s.ballDetected)return{light:'yellow',text:'Ball detected · hold still'};
 return{light:'yellow',text:'Waiting for ball'};
}
