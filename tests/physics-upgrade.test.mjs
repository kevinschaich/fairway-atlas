import test from 'node:test';import assert from 'node:assert/strict';
import {simulate,clubs} from '../src/game/engine.js';
import {R,M,I,G,dot,length,cross,scale,sub} from '../src/game/physics-math.js';
import {normalizeLaunchData,measuredVectors,clubImpact,HEADS,MPH,RPM} from '../src/game/launch-input.js';
import {atmosphere,coefficients,integrateFlight,acceleration} from '../src/game/ball-aerodynamics.js';
import {conditions,materialFor,stimpDeceleration} from '../src/game/physics-conditions.js';
import {surfaceStep,bounce,CUP_RADIUS,CUP_DEPTH} from '../src/game/ball-physics.js';
import {readConditions} from '../src/game/physics-controls.js';
const flat={elevation:()=>0,surface:()=> 'green',inside:()=>true,pin:{x:1000,z:1000}};
const base={ball:{x:0,z:0},club:0,power:100,aim:0,lie:'tee',wind:{x:0,z:0}};
const delivery={clubSpeed:100,pathAngle:0,attackAngle:3,faceAngle:0,dynamicLoft:15,impactPoint:{x:0,y:0}};
const ball={ballSpeed:150,ballDirection:0,ballElevation:13,backspin:2800,sideSpin:0};
const rollShot=(speed,x=0)=>({...base,club:5,lie:'green',ball:{x,z:.15},launchData:{ballSpeed:speed/MPH,ballDirection:0,ballElevation:0,backspin:-speed/R/RPM,sideSpin:0}});
const cup={...flat,pin:{x:0,z:0}};
test('launch contract preserves zero, rejects invalid units, non-finite and incomplete packets',()=>{assert.equal(normalizeLaunchData({...ball,ballSpeed:0}).ballSpeed,0);for(const d of [{...ball,units:'m/s'},{...ball,sideSpin:NaN},{ballSpeed:100},{...delivery,impactPoint:{x:2}}])assert.throws(()=>normalizeLaunchData(d));});
test('measured launch uses SI vectors and explicit rightward sidespin convention',()=>{const d=measuredVectors({...ball,ballDirection:90,ballElevation:0,backspin:0,sideSpin:1000});assert.ok(Math.abs(d.v.x-150*MPH)<1e-10);assert.ok(Math.abs(d.omega.y+1000*RPM)<1e-10);const a=acceleration(measuredVectors(ball).v,measuredVectors({...ball,sideSpin:1000}).omega,{});assert.ok(a.x>0);});
test('all measured ball fields are authoritative even if club or lie data disagree',()=>{const a=simulate(flat,{...base,launchData:{...ball,...delivery}}),b=simulate(flat,{...base,lie:'bunker',power:1,launchData:{...ball,...delivery,clubSpeed:20,pathAngle:35,attackAngle:-10,faceAngle:-20,dynamicLoft:60,impactPoint:{x:20,y:15}}});assert.deepEqual(a.path,b.path);assert.notDeepEqual(a.stats.prediction,b.stats.prediction);assert.equal(b.stats.source,'measured ball');});
test('club delivery fields and off-centre impact each affect predicted launch',()=>{const a=clubImpact(delivery,clubs[0]);for(const change of [{clubSpeed:110},{pathAngle:5},{attackAngle:-2},{faceAngle:5},{dynamicLoft:20},{impactPoint:{x:15,y:0}},{impactPoint:{x:0,y:15}}]){const b=clubImpact({...delivery,...change},clubs[0]);assert.ok(length(sub(a.v,b.v))+length(sub(a.omega,b.omega))>.01);}});
test('two-body impact conserves total linear momentum and cannot create kinetic energy',()=>{for(const c of clubs)for(const x of [-20,0,20])for(const y of [-10,0,10]){const h=HEADS[c.type],d={...delivery,attackAngle:0,dynamicLoft:h.loft,impactPoint:{x,y}},r=clubImpact(d,c),initial={x:0,y:0,z:-100*MPH};const residual={x:M*r.v.x+h.mass*r.clubAfter.x,y:M*r.v.y+h.mass*r.clubAfter.y,z:M*r.v.z+h.mass*r.clubAfter.z-h.mass*initial.z};assert.ok(length(residual)<1e-10);const before=.5*h.mass*length(initial)**2,after=.5*M*length(r.v)**2+.5*I*length(r.omega)**2+.5*h.mass*length(r.clubAfter)**2+.5*h.moi*length(r.headSpin)**2;assert.ok(after<=before+1e-8);}});
test('drag crisis and lift stay bounded, continuous and zero at zero spin',()=>{for(let re=0;re<350000;re+=1000)for(const spin of [0,.1,.5,1,2]){const a=coefficients(re,spin),b=coefficients(re+1,spin);assert.ok(a.cd>=.17&&a.cd<.6&&a.cl>=0&&a.cl<=.32);assert.ok(Math.abs(a.cd-b.cd)<.001);if(!spin)assert.equal(a.cl,0);}});
test('terminal velocity emerges from drag balance without speed clipping',()=>{let p={x:0,y:100000,z:0},v={x:0,y:0,z:0},omega={x:0,y:0,z:0};for(let i=0;i<24000;i++)({p,v,omega}=integrateFlight(p,v,omega,{},1.225,1/240));assert.ok(-v.y>40&&-v.y<60);assert.ok(Math.abs(acceleration(v,omega,{},1.225).y)<.001);});
test('temperature, humidity and altitude affect atmospheric density',()=>{assert.ok(atmosphere(1600).density<atmosphere(0).density);assert.ok(atmosphere(0,35).density<atmosphere(0,5).density);assert.ok(atmosphere(0,25,100).density<atmosphere(0,25,0).density);assert.ok(atmosphere(0,35).viscosity>atmosphere(0,5).viscosity);});
test('headwind reduces carry, tailwind increases it, mirrored sidespin gives mirrored flight',()=>{const shot={...base,launchData:ball},a=simulate(flat,shot),head=simulate(flat,{...shot,wind:{z:5}}),tail=simulate(flat,{...shot,wind:{z:-5}});assert.ok(head.carry<a.carry&&tail.carry>a.carry);const left=simulate(flat,{...shot,launchData:{...ball,sideSpin:-600}}),right=simulate(flat,{...shot,launchData:{...ball,sideSpin:600}});assert.ok(left.end.x<0&&right.end.x>0);assert.ok(Math.abs(left.end.x+right.end.x)<1e-8);});
test('Stimpmeter rollout matches 6, 8, 10, 12 and 14 feet within 1cm',()=>{for(const stimp of [6,8,10,12,14]){const r=simulate(flat,{...base,club:5,power:1.83/4.5*100,lie:'green',puttRollRatio:1,conditions:{stimp}});assert.ok(Math.abs(r.total-stimp*.3048)<.01,`${stimp}: ${r.total}`);}});
test('rolling slope acceleration includes rotational inertia (5/7 g sin slope)',()=>{const angle=.03,n={x:Math.sin(angle),y:Math.cos(angle),z:0},v={x:0,y:0,z:-2},w=scale(cross(n,v),1/R),s=surfaceStep(v,w,n,{mu:.5,roll:0},.001);assert.ok(Math.abs(s.v.x/.001-5/7*G*Math.sin(angle)*Math.cos(angle))<1e-8);});
test('wet grass lowers bounce and extends deceleration; wet sand packs differently',()=>{for(const kind of ['tee','fairway','green','rough']){const dry=materialFor(kind,conditions(),15),wet=materialFor(kind,conditions({dampness:1}),15);assert.ok(wet.e<dry.e&&wet.roll>dry.roll);}assert.ok(materialFor('sand',conditions({dampness:1})).roll<materialFor('sand',conditions()).roll);const dry=simulate(flat,{...base,club:5,power:50,puttRollRatio:1}),wet=simulate(flat,{...base,club:5,power:50,puttRollRatio:1,conditions:{dampness:1}});assert.ok(wet.total<dry.total*.8);});
test('high backspin can reverse tangential velocity without adding energy',()=>{const v={x:1,y:-10,z:0},w={x:0,y:0,z:800},r=bounce(v,w,{x:0,y:1,z:0},materialFor('green',conditions(),10));assert.ok(r.v.x<0);assert.ok(.5*M*length(r.v)**2+.5*I*length(r.omega)**2<.5*M*length(v)**2+.5*I*length(w)**2);});
test('slow direct putt falls through the opening, contacts the cup floor and stays below ground',()=>{const r=simulate(cup,rollShot(1));assert.equal(r.holed,true);assert.ok(r.contacts.some(c=>c.kind==='cup wall'));assert.ok(r.contacts.some(c=>c.kind==='cup floor'));assert.ok(r.path.at(-1).y<0);assert.ok(r.path.at(-1).y>=-CUP_DEPTH+R-1e-5);});
test('clobbered putt hits the opposite rim and bounces upwards instead of passing in a straight line',()=>{const r=simulate(cup,rollShot(3)),rim=r.contacts.find(c=>c.kind==='rim');assert.equal(r.holed,false);assert.ok(rim&&rim.z<0&&rim.velocityAfter.y>.5);assert.ok(r.path.some(p=>p.z<0&&p.y>R+.03));});
test('off-centre cup interaction curves and lips out; missing the rim is not magnetized',()=>{const lip=simulate(cup,rollShot(1.6,.02)),   /* 1.4 m/s at 2 cm "lipped out" only by falling through the cup floor (fixed); Holmes/Penner capture at b/R_H≈.37 is ~1.5 m/s */ miss=simulate(cup,rollShot(1,.08));assert.equal(lip.holed,false);assert.ok(lip.contacts.some(c=>c.kind==='rim'));assert.ok(Math.abs(lip.end.x-.02)>.03);assert.equal(miss.holed,false);assert.ok(Math.abs(miss.end.x-.08)<1e-8);});
test('cup capture boundary agrees with Holmes/Penner benchmark to a broad material tolerance',()=>{assert.equal(simulate(cup,rollShot(1.4)).holed,true);assert.equal(simulate(cup,rollShot(1.8)).holed,false);assert.equal(CUP_RADIUS*2,.10795);});
test('flight, rolling, and cup outcomes converge at halved integration step',()=>{for(const shot of [{...base,launchData:ball},{...base,club:5,power:45},rollShot(3),rollShot(1,.02)]){const w=shot.ball.z===.15?cup:flat,a=simulate(w,shot),b=simulate(w,{...shot,timeStep:1/480});assert.equal(a.outcome,b.outcome);assert.ok(Math.hypot(a.end.x-b.end.x,a.end.z-b.end.z)<.08);assert.ok(Math.abs(a.carry-b.carry)<.01);}});
test('recorded paths are finite, monotonic, and include physical velocity and angular velocity',()=>{const r=simulate(flat,{...base,launchData:ball});for(let i=0;i<r.path.length;i++){const p=r.path[i];for(const k of ['x','y','z','t','vx','vy','vz','wx','wy','wz'])assert.ok(Number.isFinite(p[k]));if(i)assert.ok(p.t>r.path[i-1].t);}assert.ok(r.solver.steps<10000);});
test('physics conditions survive share URLs and reject invalid values',()=>{const c=readConditions('https://example.org/?physics_dampness=.6&physics_stimp=12&physics_windSpeed=NaN');assert.equal(c.dampness,.6);assert.equal(c.stimp,12);assert.ok(Number.isFinite(c.windSpeed));assert.equal(readConditions('https://example.org/?physics_stimp=500').stimp,15);});

test('full 14-club bag has individual lofts and distinct wedge launches',()=>{assert.equal(clubs.length,14);const wedges=[11,12,4,13].map(club=>simulate(flat,{...base,club,power:70}));assert.deepEqual([11,12,4,13].map(i=>clubs[i].loft),[46,50,56,60]);for(let i=1;i<wedges.length;i++){assert.ok(wedges[i].stats.dynamicLoft>wedges[i-1].stats.dynamicLoft);assert.ok(wedges[i].stats.launch>wedges[i-1].stats.launch);assert.ok(wedges[i].carry<wedges[i-1].carry);}const iron=simulate(flat,{...base,club:3,power:70});assert.ok(iron.stats.spin>3000);assert.ok(iron.contacts[0].spinBefore.x>200);});

test('shot panel reports the actual landing spin, descent and signed rollout',async()=>{const {shotMetrics}=await import('../src/game/shot-panel.js');const shot=simulate(flat,{...base,club:3,power:70});const m=Object.fromEntries(shotMetrics(shot).map(([label,value])=>[label,value]));assert.equal(m['Backspin'],shot.stats.spin);assert.ok(m['Landing spin']>0&&m['Landing spin']<m['Backspin']);assert.ok(m['Descent angle']>0);assert.ok(Number.isFinite(m.Rollout));assert.equal(shotMetrics(null)[0][1],undefined);});
test('impact predicts published Trackman optimizer launch/ball-speed/spin benchmarks together',()=>{
 // Primary sources: Trackman spin-rate, launch-angle and ball-speed definitions.
 // These are same-speed reference conditions, not PGA-speed targets for everyone.
 for(const ref of [{club:8,speed:80,loft:23.5,attack:-4,ball:110,launch:16.9,spin:5956},{club:11,speed:72,loft:38,attack:-5,ball:86,launch:26.7,spin:8408}]){
  const r=clubImpact({clubSpeed:ref.speed,pathAngle:0,attackAngle:ref.attack,faceAngle:0,dynamicLoft:ref.loft,impactPoint:{x:0,y:0}},clubs[ref.club]);
  assert.ok(Math.abs(length(r.v)/MPH/ref.ball-1)<.03);assert.ok(Math.abs(r.omega.x/RPM/ref.spin-1)<.03);assert.ok(Math.abs(Math.atan2(r.v.y,-r.v.z)*180/Math.PI-ref.launch)<.5);
 }
});
test('compliant turf rebound matches the Haake measurement within declared model tolerance',async()=>{
 const {turfBounce}=await import('../src/game/ball-physics.js'),a=44.4*Math.PI/180;
 const r=turfBounce({x:18.6*Math.sin(a),y:-18.6*Math.cos(a),z:0},{x:0,y:0,z:484},{x:0,y:1,z:0},'green',conditions());
 // Haake via Penner 2002: rebound 5.1 m/s, 33 degrees from vertical, topspin 145 rad/s.
 assert.ok(Math.abs(length(r.v)/5.1-1)<.2);assert.ok(Math.abs(Math.atan2(r.v.x,r.v.y)*180/Math.PI-33)<10);assert.ok(Math.abs(-r.omega.z/145-1)<.15);
});
test('short-iron and wedge approaches do not acquire dozens of yards of flat-green rollout',()=>{
 for(const club of [3,11,4,13]){const r=simulate(flat,{...base,club,power:100});assert.ok(r.total-r.carry<12,`${clubs[club].abbr}: ${r.total-r.carry} m`);assert.ok(r.contacts.length<12);}
 const full=simulate(flat,{...base,club:13,power:100}),partial=simulate(flat,{...base,club:13,power:70});assert.ok(full.stats.spin>9000&&full.stats.spin<11000);assert.ok(partial.stats.spin<full.stats.spin);assert.ok(partial.carry<full.carry);
});
test('revised turf contacts dissipate energy over speed, slope, spin and material sweeps',async()=>{
 const {turfBounce}=await import('../src/game/ball-physics.js');
 for(const surface of ['green','fairway','rough','sand','path'])for(const wet of [0,.5,1])for(const speed of [3,12,30,60])for(const spin of [-1200,0,1200]){
  const v={x:speed,y:-speed*.7,z:0},w={x:0,y:0,z:spin},r=turfBounce(v,w,{x:0,y:1,z:0},surface,conditions({dampness:wet}));
  assert.ok(.5*M*length(r.v)**2+.5*I*length(r.omega)**2<=.5*M*length(v)**2+.5*I*length(w)**2+1e-8);
 }
});

test('shot diagnostics preserve physics version, wetness, material and geometric slope',async()=>{
 const {PHYSICS_VERSION}=await import('../src/game/physics-version.js');
 const r=simulate({...flat,elevation:(x,z)=>z*.02},{...base,club:12,power:110,conditions:{dampness:.5,stimp:12}});
 assert.equal(r.modelVersion,PHYSICS_VERSION);assert.equal(r.conditions.dampness,.5);assert.equal(r.conditions.stimp,12);
 const c=r.contacts.find(c=>c.kind==='ground');assert.equal(c.surface,'green');assert.ok(Math.abs(c.groundNormal.z/c.groundNormal.y+.02)<1e-9);
});
test('a stationary shot in water is a hazard, not an ordinary rest',()=>{
 const r=simulate({...flat,surface:()=> 'water'},{...base,lie:'water'});assert.equal(r.outcome,'water');
});
