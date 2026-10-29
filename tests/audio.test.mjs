import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {makeWorld} from '../src/game/engine.js';
import {ambienceMix,listenerEnvironment,shotFamily,shotEvents,landKind} from '../src/game/audio.js';import {buildAudioManifest} from '../scripts/audio-manifest.mjs';import {simulate} from '../src/game/engine.js';
const read=p=>JSON.parse(fs.readFileSync(new URL(p,import.meta.url)));
test('Pebble Beach hole 7 tee hears the surf and daytime birds; the same spot at night swaps birds for insects',()=>{
 const c=read('../public/data/pebble.json'),w=makeWorld(c,c.holes.find(h=>h.number===7));
 const env=listenerEnvironment(w,{x:w.tee.x,y:w.elevation(w.tee.x,w.tee.z)+1.7,z:w.tee.z},{hour:15,date:'2026-09-27'});
 assert.ok(env.oceanDist<250,`tee is ${env.oceanDist} m from the mapped ocean`);
 const day=ambienceMix(env),night=ambienceMix({...env,hour:23});
 assert.ok(day.surf>.3&&day.birds>.2,JSON.stringify(day));assert.ok(night.birds<.02&&night.night>.2,JSON.stringify(night));assert.equal(day.desert,0);});
test('inland and other biomes pick their own beds',()=>{
 const scottsdale=ambienceMix({lat:33.5,lon:-111.9,elev:400,month:4,hour:10,oceanDist:Infinity,lakeDist:Infinity});
 assert.ok(scottsdale.desert>.5&&scottsdale.surf===0&&scottsdale.tropical===0);
 const tropics=ambienceMix({lat:9.9,lon:-84,elev:50,month:3,hour:9,oceanDist:5000,lakeDist:Infinity});assert.ok(tropics.tropical>.9&&tropics.birds<.05);
 const alpine=ambienceMix({lat:46.5,lon:9.8,elev:1850,month:7,hour:11,oceanDist:Infinity,lakeDist:Infinity});assert.ok(alpine.mountain>.6);
 const pond=ambienceMix({lat:40.4,lon:-80,elev:300,month:7,hour:11,oceanDist:Infinity,lakeDist:20});assert.ok(pond.lake>.9&&pond.meadow>.5);});
test('every audio file follows the naming convention, every kind the game plays has files, and every source is credited',async()=>{
 const {manifest:m,warnings}=await buildAudioManifest();assert.deepEqual(warnings,[]);
 assert.deepEqual(['driver','wood','hybrid','iron','wedge','putter'].map(t=>shotFamily(t)),['driver','wood','hybrid','iron','wedge','putter']);
 for(const k of ['driver','wood','hybrid','iron','wedge','putter'])assert.ok(m.impact[k]?.length>=1,'impact '+k);assert.ok(m.whoosh.length>=1);
 for(const k of ['fairway','rough','green','sand','water','cup'])assert.ok(m.land[k]?.length>=1,'land '+k);
 for(const k of ['birds','surf'])assert.ok(m.ambience[k]?.length>=1,'ambience '+k);   // the rest are curated in the Audio lab; a bed with no files is simply silent
 const ids=new Set(m.credits.map(c=>c.id));const all=[...Object.values(m.ambience),m.whoosh,...Object.values(m.impact),...Object.values(m.land)].flat();
 for(const e of all){assert.ok(fs.existsSync(new URL('../public/audio/'+e.file,import.meta.url)),e.file);assert.ok(ids.has(e.src),e.src);}
 for(const c of m.credits)assert.match(c.url,/^https:\/\/freesound\.org\/people\/[^/]+\/sounds\/\d+\/$/);});
test('a shot onto the green bounces with green sounds; a holed putt ends in the cup; a ball in the water ends in a splash',()=>{
 const c=read('../public/data/pebble.json'),w=makeWorld(c,c.holes.find(h=>h.number===7));
 const approach=simulate(w,{ball:{...w.tee},club:12,power:85,aim:0,lie:'tee'});const ev=shotEvents(approach.path,(x,z)=>w.surface(x,z),approach.outcome);
 assert.ok(ev.length>=1,'no landing events');assert.ok(ev.every(e=>['fairway','rough','green','sand','water','cup'].includes(e.kind)));assert.equal(ev[0].kind,landKind(w.surface(ev[0].x,ev[0].z)));
 const holed=shotEvents([{t:0,phase:'roll',x:0,z:0,vx:1,vy:0,vz:0},{t:.5,phase:'rim',x:0,z:0,vx:0,vy:-.2,vz:0},{t:.6,phase:'cup floor',x:0,z:0,vx:0,vy:-1,vz:0},{t:.7,phase:'holed',x:0,z:0,vx:0,vy:0,vz:0}],()=>'green','holed');
 assert.equal(holed.at(-1).kind,'cup');assert.equal(holed.filter(e=>e.kind==='cup'&&e.level===1).length,1);
 const wet=shotEvents([{t:0,phase:'flight',x:0,z:0,vx:10,vy:5,vz:0},{t:1,phase:'bounce',x:5,z:0,vx:9,vy:-6,vz:0},{t:1.01,phase:'water',x:5,z:0,vx:0,vy:0,vz:0}],()=>'water','water');
 assert.deepEqual(wet.map(e=>e.kind),['water']);});
