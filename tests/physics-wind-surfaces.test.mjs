import test from 'node:test';import assert from 'node:assert/strict';
import {flight,craterDepth,softImpact,BALL_RADIUS as R} from '../src/game/ball-physics.js';
import {simulate} from '../src/game/engine.js';
import {conditions,materialFor,windVector,windRelative,windProfileFactor} from '../src/game/physics-conditions.js';
import {splineGrid,visibleGroundHeight,meshHeight} from '../src/game/ground-contact.js';
const MPH=.44704,drive={units:'mph-deg-rpm-mm',ballSpeed:167,ballDirection:0,ballElevation:10.9,backspin:2686,sideSpin:0};
const shot=(surface,launchData=drive,wind={x:0,z:0})=>flight({elevation:()=>0,surface:()=>surface,inside:()=>true,pin:{x:1e4,z:1e4},physicsConditions:{}},{ball:{x:0,z:0},aim:0,power:100,wind,launchData},{type:'driver',speed:40,loft:10},1);
const iron={units:'mph-deg-rpm-mm',ballSpeed:120,ballDirection:0,ballElevation:16.3,backspin:7000,sideSpin:0};

test('wind: tail carries further on a lower flight, head shorter and higher, cross wind drifts downwind',()=>{
 const calm=shot('fairway'),tail=shot('fairway',drive,{x:0,z:-38*MPH}),head=shot('fairway',drive,{x:0,z:38*MPH}),left=shot('fairway',drive,{x:-20*MPH,z:0}),right=shot('fairway',drive,{x:20*MPH,z:0});
 assert.ok(tail.carry>calm.carry+10&&tail.total>calm.total+25,'tailwind adds distance');assert.ok(tail.apex<calm.apex,'tailwind flattens');
 // a tailwind never makes the ball fall back under its own arc: the downrange position only increases through the flight
 for(let i=1;i<tail.path.length;i++)assert.ok(tail.path[i].z<=tail.path[i-1].z+1e-9);
 assert.ok(head.carry<calm.carry-40&&head.apex>calm.apex);
 assert.ok(left.end.x<-10&&right.end.x>10&&Math.abs(left.end.x+right.end.x)<.01);
});
test('wind follows the neutral log-law surface layer, 10 m reference',()=>{
 assert.equal(windProfileFactor(10).toFixed(6),'1.000000');assert.equal(windProfileFactor(.02),0);
 assert.ok(windProfileFactor(1)<.65&&windProfileFactor(30)>1.15);
 for(let h=.05;h<60;h*=1.3)assert.ok(windProfileFactor(h*1.3)>windProfileFactor(h));
});
test('HUD wind is shot relative: bearing toward the target helps, toward the right blows L→R',()=>{
 const c=conditions({windSpeed:20,windDirection:90});
 assert.ok(windRelative(c,90).along>8.9&&Math.abs(windRelative(c,90).cross)<1e-9&&windRelative(c,90).angle===0);
 assert.ok(windRelative(c,270).along<-8.9);assert.ok(windRelative(c,0).cross>8.9&&windRelative(c,0).angle===90);assert.ok(windRelative(c,180).cross<-8.9);
 const w=windVector(c),a=90*Math.PI/180;assert.ok(Math.abs(w.x-Math.sin(a)*20*MPH)<1e-9);
});
test('rough and sand absorb the landing: full shots stop within a few yards, sand plugs',()=>{
 const fair=shot('fairway'),rough=shot('rough'),bunker=shot('bunker'),ironRough=shot('rough',iron),ironBunker=shot('bunker',iron);
 const roll=r=>(r.total-r.carry)/.9144;
 assert.ok(roll(rough)<roll(fair)/2&&roll(rough)<6,`rough roll ${roll(rough)}`);assert.ok(roll(ironRough)<3);
 for(const r of [bunker,ironBunker]){assert.ok(r.plugged&&roll(r)<.2);assert.ok(r.end.depth>.6*R);assert.equal(r.path.at(-1).phase,'plugged');}
 const low={units:'mph-deg-rpm-mm',ballSpeed:30,ballDirection:0,ballElevation:8,backspin:1000,sideSpin:0};
 assert.ok(roll(shot('bunker',low))<roll(shot('fairway',low))/5,'a running ball digs into sand');
 assert.ok(roll(shot('rough',low))<roll(shot('fairway',low))/2);
 // softImpact never adds energy and a crater only forms in soft media
 const mat=materialFor('sand',conditions(),10),v={x:0,y:-10,z:-8},hit=softImpact(v,{x:200,y:0,z:0},{x:0,y:1,z:0},mat);
 assert.ok(Math.hypot(hit.v.x,hit.v.y,hit.v.z)<Math.hypot(v.x,v.y,v.z));assert.equal(craterDepth(10,materialFor('green',conditions(),10)),0);
 assert.ok(craterDepth(15,materialFor('bunker',conditions(),15))>craterDepth(15,materialFor('rough',conditions(),15)));
});
test('a plugged lie loses most of the next shot',()=>{
 const world={elevation:()=>0,surface:()=> 'bunker',inside:()=>true,pin:{x:1e4,z:1e4}};
 const clean=simulate(world,{ball:{x:0,z:0},club:10,power:100,aim:0,wind:{x:0,z:0}}),buried=simulate(world,{ball:{x:0,z:0,depth:.9*R},club:10,power:100,aim:0,wind:{x:0,z:0}});
 assert.ok(buried.carry<clean.carry*.8);
});
test('CPU ground reconstructs the GPU B-spline height map exactly for linear ground and smooths kinks',()=>{
 const box={x:-50,z:-50,size:100},N=256,lin=(i,j)=>3+.2*(-50+(i+.5)/N*100)-.1*(-50+(j+.5)/N*100);
 for(const [x,z] of [[0,0],[1.23,-4.5],[20.7,11.1]])assert.ok(Math.abs(splineGrid(N,box,lin,x,z)-(3+.2*x-.1*z))<1e-9);
 const xs=[],zs=[];for(let v=-50;v<=50;v+=1){xs.push(v);zs.push(v)}const pos=[];for(const z of zs)for(const x of xs)pos.push(Math.abs(x));
 const geo={userData:{grid:{xs,zs},bake:{box,N}},attributes:{position:{getY:i=>pos[i]}}};
 assert.ok(Math.abs(meshHeight(geo,0,0))<1e-9);const h=visibleGroundHeight(geo,0,0);assert.ok(h>.05&&h<.3,`smoothed crest ${h}`);
});
// Biber, Hosseini & Sharpe (2023), arXiv 2302.02758, eq. (12): measured bounces on a natural teeing area (campaign B),
// 1.9–38.7 m/s, 16–90°, −3.9k–16k rpm. Units: ball radii/s and rad/s, ω > 0 backspin.
function biberB(vx,vy,rpm){const x=vx/R,y=vy/R,w=rpm*Math.PI/30,c=.377*x+2.25*y+w;
 const [M,b]=c< -485?[[[.326,.222,-.213],[.185,-.008,-.076],[-.333,-.147,.224]],[175,90.4,-171]]:[[[.606,.649,-.007],[.146,-.089,-.006],[-.192,1.01,.887]],[117,49.3,35.0]];
 const o=M.map((r,i)=>r[0]*x+r[1]*y+r[2]*w+b[i]);return{vx:o[0]*R,vy:o[1]*R,rpm:o[2]*30/Math.PI};}
test('turf bounce matches measured natural-turf bounces; fast shallow landings skip forward, not up',async()=>{
 const {turfBounce}=await import('../src/game/ball-physics.js');let e=[0,0,0],N=0;
 for(const sp of [8,12,16,20,25,30,35])for(const ang of [16,20,25,30,40,50,60,75])for(const rpm of [0,2500,5000,8000]){
  const a=ang*Math.PI/180,vx=sp*Math.cos(a),vy=-sp*Math.sin(a),o=turfBounce({x:0,y:vy,z:-vx},{x:rpm*Math.PI/30,y:0,z:0},{x:0,y:1,z:0},'fairway',conditions()),b=biberB(vx,vy,rpm);
  e[0]+=(-o.v.z-b.vx)**2;e[1]+=(o.v.y-b.vy)**2;e[2]+=((o.omega.x*30/Math.PI-b.rpm)/1000)**2;N++;
  if(ang<=25&&sp>=20){assert.ok(-o.v.z>o.v.y,`${sp} m/s at ${ang}°: ${-o.v.z} forward vs ${o.v.y} up`);assert.ok(-o.v.z>.3*vx);}}
 const [fwd,up,spin]=e.map(x=>Math.sqrt(x/N));assert.ok(fwd<1.2&&up<1.3&&spin<1.1,`RMS ${fwd} ${up} ${spin}`);
});
test('a ball that drops below the lip is never snapped back out of the cup; capture speeds match Holmes/Penner',async()=>{
 const {MPH,RPM}=await import('../src/game/launch-input.js');const {CUP_RADIUS,CUP_DEPTH}=await import('../src/game/ball-physics.js');
 assert.equal(CUP_RADIUS*2,.10795);assert.equal(CUP_DEPTH,.1016);   // USGA Rule: 4.25 in diameter, at least 4 in deep
 const cup={elevation:()=>0,surface:()=> 'green',inside:()=>true,pin:{x:0,z:0},physicsConditions:{windSpeed:0}};
 const putt=(speed,x,dist)=>({ball:{x,z:dist},club:5,power:100,aim:0,lie:'green',wind:{x:0,z:0},launchData:{units:'mph-deg-rpm-mm',ballSpeed:speed/MPH,ballDirection:0,ballElevation:0,backspin:-speed/R/RPM,sideSpin:0}});
 for(let v=.8;v<=4.5;v+=.1)for(let x=-.07;x<=.07;x+=.01){const r=simulate(cup,putt(v,x,1.5));
  if(!r.holed)assert.ok(!r.contacts.some(c=>c.kind==='cup floor')&&Math.min(...r.path.map(p=>p.y))>-CUP_DEPTH,`v ${v} x ${x}: entered the cup and came back out`);}
 // centred capture speed ≈ 1.63 m/s with lip interaction (Holmes 1991 via Penner 2002); free fall alone gives 1.31
 let vmax=0;for(let v=1.2;v<=1.8;v+=.01){if(simulate(cup,putt(v,0,.12)).holed)vmax=v;else break;}assert.ok(vmax>1.31&&vmax<1.75,`capture ${vmax}`);
});
