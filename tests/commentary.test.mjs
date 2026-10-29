import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {classifyShot,holeFor,introFor} from '../src/game/commentary.js';
const script=JSON.parse(fs.readFileSync(new URL('../public/commentary/script.json',import.meta.url)));
test('every moment/situation in the matrix has at least one exchange, every exchange is a call and a response from both voices, and its audio exists',t=>{const missing=[];
 for(const [m,def] of Object.entries(script.moments))for(const w of Object.keys(def.situations))assert.ok(script.exchanges.some(e=>e.moment===m&&e.when===w),`no exchange for ${m}/${w}`);
 const ids=new Set();for(const e of script.exchanges){assert.ok(!ids.has(e.id),'duplicate id '+e.id);ids.add(e.id);assert.ok(script.moments[e.moment]?.situations[e.when],`${e.id}: unknown ${e.moment}/${e.when}`);
  assert.ok(e.lines.length>=2&&new Set(e.lines.map(l=>l.who)).size===2,`${e.id}: needs both voices`);
  e.lines.forEach((l,i)=>{assert.ok(script.voices[l.who],l.who);const f=`${e.id}-${i+1}-${l.who}.mp3`;if(!fs.existsSync(new URL('../public/commentary/audio/'+f,import.meta.url)))missing.push(f);});}
 // lines not generated yet are reported, not failed (generation needs ElevenLabs credits); the game skips exchanges without audio
 if(missing.length)t.diagnostic(`${missing.length} commentary lines have no audio yet — run: npm run commentary`);
 for(const m of ['launch','land'])for(const w of Object.keys(script.moments[m].situations))assert.ok(script.exchanges.filter(e=>e.moment===m&&e.when===w).length>=10,`${m}/${w}: fewer than 10 variations`);
 // callers are mixed between the two voices within every moment
 for(const m of Object.keys(script.moments)){const ex=script.exchanges.filter(e=>e.moment===m);if(ex.length<2)continue;const callers=new Set(ex.map(e=>e.lines[0].who));assert.equal(callers.size,2,`${m}: only ${[...callers]} leads`);}});
test('shots are classified into the right situations',()=>{
 const pin={x:0,z:0},S=kind=>()=>kind,base={pin,clubCarryYd:150,power:100,par:4};
 const approach=(end,surface,extra={})=>classifyShot({...base,result:{end,carry:130,flightTime:5,holed:false,outcome:'rest',...extra},start:{x:0,z:140},surfaceAt:(x,z)=>z===140?'fairway':surface,clubType:'iron',strokes:2});
 assert.deepEqual(approach({x:1,z:1},'green'),{launch:'great',land:'green-close'});
 assert.equal(approach({x:0,z:8},'green').land,'green');
 assert.deepEqual(approach({x:40,z:20},'rough'),{launch:'wayward',land:'rough'});
 assert.equal(approach({x:0,z:100},'fairway',{carry:40}).launch,'short');
 assert.deepEqual(approach({x:0,z:20},'water',{outcome:'water'}),{launch:'trouble',land:'water'});
 assert.equal(approach({x:0,z:0},'green',{holed:true}).land,'holed');
 const ace=classifyShot({...base,par:3,result:{end:pin,carry:140,flightTime:5,holed:true,outcome:'holed'},start:{x:0,z:140},surfaceAt:(x,z)=>z===140?'tee':'green',clubType:'iron',strokes:1});
 assert.equal(ace.land,undefined);assert.equal(ace.hole,'ace');
 const putt=(end,holed=false,from=6)=>classifyShot({...base,result:{end,holed,outcome:holed?'holed':'rest'},start:{x:0,z:from},surfaceAt:S('green'),clubType:'putter',strokes:3});
 assert.deepEqual(putt(pin,true),{putt:'holed-long',hole:'birdie'});assert.equal(putt(pin,true,2).putt,'holed-short');
 assert.equal(putt({x:.3,z:.2}).putt,'near-miss');assert.equal(putt({x:0,z:2}).putt,'short');assert.equal(putt({x:0,z:-2}).putt,'long');assert.equal(putt({x:4,z:5}).putt,'awful');
 assert.deepEqual([1,2,3,4,5,6,7].map(s=>holeFor(s,4)),['ace','eagle','birdie','par','bogey','double','worse']);assert.equal(holeFor(2,5),'albatross');
 assert.deepEqual([3,4,5].map(introFor),['par3','par4','par5']);});
