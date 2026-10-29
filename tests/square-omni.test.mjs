import test from 'node:test';import assert from 'node:assert/strict';
import {isZeroSpinMisread,parseNotification,toLaunchData,deviceMetrics,commands,clubCode,profileFor,lightFor,SquareOmni,UUID,MPS_TO_MPH} from '../src/game/square-omni.js';
import {normalizeLaunchData} from '../src/game/launch-input.js';
import {simulate,clubs} from '../src/game/engine.js';
const hex=s=>Uint8Array.from(s.replace(/\s/g,'').match(/../g),h=>parseInt(h,16));
const near=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<=e,`${a} ≈ ${b}`);

// Frames captured from a real Omni (hw 3.1, lm 1.5.8) in divotmaker/allsquare's protocol tests.
test('decodes captured Omni frames',()=>{
 const putt=parseNotification(hex('1102379f004800dcff0000000000000000'));
 assert.equal(putt.kind,'ball');assert.equal(putt.shotType,0x37);near(putt.speed,1.59);near(putt.launch,0.72);near(putt.direction,-0.36);assert.equal(putt.totalSpin,0);
 const club=parseNotification(hex('1107ffbd012d03d600e90f6df331f946016500'));
 assert.equal(club.mask,0xff);near(club.path,4.45);near(club.face,8.13);near(club.attack,2.14);near(club.loft,40.73);near(club.impactH,-32.19);near(club.impactV,-17.43);near(club.clubSpeed,3.26);near(club.smash,1.01);
 near(3.30/club.clubSpeed,club.smash,0.01);
 const empty=parseNotification(hex('110700ffffffffffffffffffffffffffffffff'));assert.deepEqual(empty,{kind:'club',mask:0});
 assert.deepEqual(parseNotification(hex('110700')),{kind:'club',mask:0});// original Square / Home short form
 assert.deepEqual(parseNotification(hex('916403')),{kind:'battery',percent:100,charging:'full'});
 assert.equal(parseNotification(hex('710000000000000551')).kind,'clock');
 assert.equal(parseNotification(hex('110385040403000000')).state,'ready');
 assert.equal(parseNotification(hex('11032f000003000000')).state,'none');
 const sensor=parseNotification(hex('1101270101b8220000a4fbffff36ffffff'));
 assert.ok(sensor.ready&&sensor.detected);assert.deepEqual(sensor.position,[8888,-1116,-202]);
 assert.equal(parseNotification(new Uint8Array(0)).kind,'disconnect');
 // Captured from a real Omni (SquareGolf(1574), hw 3.1, lm 1.5.8), armed with the putter and no ball down.
 assert.deepEqual(parseNotification(hex('1106000100')),{kind:'query'});
 assert.equal(parseNotification(hex('110301030300000000')).state,'detecting');
 assert.deepEqual(parseNotification(hex('915b01')),{kind:'battery',percent:91,charging:'discharging'});
 const idle=parseNotification(hex('1101020000000000000000000000000000'));assert.ok(!idle.ready&&!idle.detected);
 assert.equal(parseNotification(hex('7100000000000000fd')).kind,'clock');
 assert.equal(parseNotification(hex('1102')),null);assert.equal(parseNotification(hex('55aa')),null);
 // Original Square club reply: mask 0x0f covers the four delivery angles only.
 const legacy=parseNotification(hex('11070fbd012d03d600e90f'));assert.equal(legacy.mask,0x0f);near(legacy.loft,40.73);assert.equal(legacy.clubSpeed,undefined);
});

test('encodes commands byte-for-byte like allsquare (Omni) and the Go connectors (original Square)',()=>{
 const h=b=>[...b].map(x=>x.toString(16).padStart(2,'0')).join('');
 assert.equal(h(commands.heartbeat(0x1c)),'00831c000000000000');
 assert.equal(h(commands.detectBall(0x0a,true)),'00810a011100000000');
 assert.equal(h(commands.clubSelect(0x06,clubCode({abbr:'PW'}).code,'right')),'0082060a0200000000');
 assert.equal(h(commands.requestClubMetrics(0x10)),'008710000000000000');
 assert.equal(h(commands.detectBall(3,true,'legacy')),'118103011100000000');// Go: 1181%02x0%d1%d00000000
 assert.equal(h(commands.clubSelect(5,clubCode({abbr:'DR'},'legacy').code,'left','legacy')),'118205020401000000');// Go: 1182 seq 0204 01 000000
});

test('maps every game club to an Omni club code',()=>{
 const want={DR:'01 00','3W':'03 01','4H':'0e 01','4I':'04 02','5I':'05 02','6I':'06 02','7I':'07 02','8I':'08 02','9I':'09 02',PW:'0a 02',GW:'0b 02',SW:'0c 02',LW:'0d 02',PT:'01 03'};
 for(const c of clubs){const {code}=clubCode(c);assert.equal(code.map(x=>x.toString(16).padStart(2,'0')).join(' '),want[c.abbr],c.name);}
 assert.equal(profileFor('3.1'),'omni');assert.equal(profileFor(''),'omni');assert.equal(profileFor('2.0'),'legacy');
});

test('converts to the game contract: mph, positive = right, device sidespin/axis sign flipped',()=>{
 // A right-hander's fade: device reports negative sidespin and axis for a ball curving right.
 const ball={speed:60,launch:12.5,direction:1.8,totalSpin:2700,spinAxis:-8.5,backspin:2670,sideSpin:-399};
 const club={mask:0xff,path:-2.1,face:0.4,attack:-1.2,loft:14.3,impactH:-6,impactV:3,clubSpeed:40.5,smash:1.48};
 const d=toLaunchData(ball,club);
 near(d.ballSpeed,60*MPS_TO_MPH);near(d.ballSpeed,134.216,0.001);assert.equal(d.ballDirection,1.8);assert.equal(d.ballElevation,12.5);assert.equal(d.backspin,2670);assert.equal(d.sideSpin,399);
 near(d.clubSpeed,40.5*MPS_TO_MPH);assert.equal(d.pathAngle,-2.1);assert.equal(d.faceAngle,0.4);assert.equal(d.attackAngle,-1.2);assert.equal(d.dynamicLoft,14.3);
 assert.equal(d.impactPoint,undefined,'uncalibrated face impact is not forwarded by default');
 assert.deepEqual(toLaunchData(ball,club,{impact:true}).impactPoint,{x:6,y:3});// toe-side strike (device −) is target-right for a right-hander
 assert.deepEqual(toLaunchData(ball,club,{handed:'left',impact:true}).impactPoint,{x:-6,y:3});
 assert.deepEqual(normalizeLaunchData(d),d);
 const m=deviceMetrics(ball,club);assert.equal(m.spinAxis,8.5);assert.equal(m.sideSpin,399);assert.equal(m.smash,1.48);
 // Untracked club: ball-only launch, still valid.
 const bare=toLaunchData(ball,{mask:0});assert.equal(bare.clubSpeed,undefined);assert.deepEqual(normalizeLaunchData(bare),bare);
 // Only total spin + axis: components are rebuilt (then sidespin flipped).
 const t=toLaunchData({...ball,backspin:0,sideSpin:0});near(t.backspin,2700*Math.cos(-8.5*Math.PI/180));near(t.sideSpin,-2700*Math.sin(-8.5*Math.PI/180));
 // Out-of-range club fields are dropped instead of rejecting the shot.
 assert.equal(toLaunchData(ball,{...club,impactH:-75},{impact:true}).impactPoint,undefined);
 const zero={...ball,totalSpin:0,backspin:0,sideSpin:0};assert.ok(isZeroSpinMisread(zero,{type:'iron'}));assert.ok(!isZeroSpinMisread(zero,{type:'putter'}));assert.ok(!isZeroSpinMisread(ball,{type:'iron'}));
});

test('a measured fade flies right and the game reports the device values',()=>{
 const d=toLaunchData({speed:60,launch:12.5,direction:0,totalSpin:2700,spinAxis:-10,backspin:2659,sideSpin:-469},{});
 const flat={elevation:()=>0,surface:()=>'fairway',inside:()=>true,pin:{x:1000,z:1000}};
 const shot=simulate(flat,{ball:{x:0,z:0},club:0,power:100,aim:0,lie:'tee',wind:{x:0,z:0},launchData:normalizeLaunchData(d)});
 assert.equal(shot.stats.source,'measured ball');assert.ok(shot.stats.sideSpin>0);assert.ok(shot.end.x>0,'fade finishes right of target');near(shot.stats.ballSpeed,d.ballSpeed,1e-6);
});

// Fake Web Bluetooth GATT that records writes and lets the test push notifications.
function fakeDevice(){
 const writes=[],listeners={},evt=new EventTarget();evt.startNotifications=async()=>{};
 const push=hexs=>{evt.value=new DataView(hex(hexs).buffer);evt.dispatchEvent(new Event('characteristicvaluechanged'));};
 Object.defineProperty(evt,'target',{get:()=>evt});
 const text=s=>({readValue:async()=>new DataView(new TextEncoder().encode(s).buffer)});
 const chars={[UUID.command]:{writeValueWithResponse:async b=>{writes.push([...b])}},[UUID.events]:evt,[UUID.hardware]:text('3.1'),[UUID.firmware]:text('{"launcher":"1.0.1","mmi":"1.4.0","lm":"1.5.8"}'),[UUID.deviceId]:text('SQ123')};
 const service={getCharacteristic:async u=>chars[u]};
 const device={name:'SquareGolf(A1B2)',gatt:{connected:false,connect:async()=>{device.gatt.connected=true;return{getPrimaryService:async()=>service}},disconnect(){device.gatt.connected=false;(listeners.gattserverdisconnected||[]).forEach(f=>f())}},
  addEventListener:(t,f)=>(listeners[t]||=[]).push(f),removeEventListener:(t,f)=>{listeners[t]=(listeners[t]||[]).filter(x=>x!==f)}};
 return{device,writes,push};
}
const types=w=>w.map(b=>b[1]);
test('session: arm, dedupe doubled notifications, pull club data, ignore stale club packets, light states',async()=>{
 let t=0;const f=fakeDevice(),club={abbr:'7I',name:'7 Iron',type:'iron'};
 const omni=new SquareOmni({getClub:()=>club,now:()=>t});const shots=[];omni.addEventListener('shot',e=>shots.push(e.detail));
 assert.equal(lightFor(omni.status,true,t).light,'red');
 await omni.attach(f.device);
 try{
 assert.equal(omni.status.link,'connected');assert.equal(omni.status.firmware.lm,'1.5.8');assert.equal(omni.status.profile,'omni');
 assert.deepEqual(types(f.writes),[0x86,0x83,0x82,0x81]);assert.deepEqual(f.writes[2].slice(3,6),[7,2,0]);assert.deepEqual(f.writes[3].slice(3,5),[1,0x11]);
 assert.equal(lightFor(omni.status,true,t).light,'yellow');
 // Stale club packet from a previous session: no preceding ball packet, so it is not a shot.
 f.push('1107ffbd012d03d600e90f6df331f946016500');assert.equal(shots.length,0);
 t=100;f.push('1101270101b8220000a4fbffff36ffffff');f.push('1101270101b8220000a4fbffff36ffffff');
 assert.equal(lightFor(omni.status,true,t).light,'green');
 // Zero-spin read with an iron selected is a misread and is dropped.
 const discards=[];omni.addEventListener('discard',e=>discards.push(e.detail));
 t=150;f.push('1102379f004800dcff0000000000000000');await new Promise(r=>setTimeout(r,5));f.push('110700ffffffffffffffffffffffffffffffff');
 assert.equal(shots.length,0);assert.equal(discards.length,1);
 club.abbr='PT';club.type='putter';club.name='Putter';f.push('1101290101b8220000a4fbffff36ffffff');
 t=200;f.push('1102379f004800dcff0000000000000000');f.push('1102379f004800dcff0000000000000000');
 await new Promise(r=>setTimeout(r,5));
 assert.equal(types(f.writes).filter(x=>x===0x87).length,2,'each (doubled) ball packet requests club data once');
 t=260;f.push('1107ffbd012d03d600e90f6df331f946016500');f.push('1107ffbd012d03d600e90f6df331f946016500');
 assert.equal(shots.length,1);near(shots[0].launchData.ballSpeed,1.59*MPS_TO_MPH);near(shots[0].launchData.clubSpeed,3.26*MPS_TO_MPH);assert.deepEqual(normalizeLaunchData(shots[0].launchData),shots[0].launchData);
 // An identical tap-in putt later (after other traffic) still counts.
 t=5000;f.push('1101280101b8220000a4fbffff36ffffff');t=5100;f.push('1102379f004800dcff0000000000000000');t=5150;f.push('110700ffffffffffffffffffffffffffffffff');
 assert.equal(shots.length,2);assert.equal(shots[1].launchData.clubSpeed,undefined);
 // Club changes in the game are forwarded.
 club.abbr='DR';club.type='driver';await omni.syncClub();assert.deepEqual(f.writes.at(-1).slice(3,5),[1,0]);club.abbr='PT';club.type='putter';await omni.syncClub();assert.deepEqual(f.writes.at(-1).slice(1,2).concat(f.writes.at(-1).slice(3,5)),[0x82,1,3]);
 t=30000;omni.set({stale:true});assert.equal(lightFor(omni.status,true,t).text,'Device not responding');
 await omni.disconnect();assert.equal(omni.status.link,'idle');assert.equal(lightFor(omni.status,true,t).light,'red');
 assert.deepEqual(f.writes.filter(w=>w[1]===0x81).at(-1).slice(3,4),[0]);
 }finally{await omni.disconnect();}
});
