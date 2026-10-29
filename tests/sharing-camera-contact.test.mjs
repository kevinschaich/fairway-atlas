import test from 'node:test';import assert from 'node:assert/strict';const {Vec3,Camera}=await import('../src/game/core/index.js');
const {readShareState,shareURL}=await import('../src/game/share-state.js');
const {DEFAULT_LIGHTING}=await import('../src/game/lighting-settings.js');
const {CameraMotion,cameraPose,createDroneFlight,ease}=await import('../src/game/camera-motion.js');
const {ballSurfaceY,markerY,groundAimPoints,visibleGroundHeight}=await import('../src/game/ground-contact.js');
const {BALL_RADIUS}=await import('../src/game/ball-physics.js');
const {createTracer}=await import('../src/game/shot-tracer.js');
const ground=(height=()=>0)=>({userData:{grid:{xs:[-100,100],zs:[-100,100]}},attributes:{position:{getY:i=>height(i%2?100:-100,i>=2?100:-100)}}});
test('course/hole and all scene settings survive a share URL round trip',()=>{
 const settings={...DEFAULT_LIGHTING,date:'2026-09-25',hour:16.25,clouds:.52,fill:.3,haze:.8,exposure:-.2},url=shareURL('https://example.com/?keep=yes&azimuth=40#play',{course:'relation/6174192',hole:7,settings,resolution:1.25}),parsed=readShareState(url);assert.equal(parsed.course,'relation/6174192');assert.equal(parsed.hole,7);assert.deepEqual(parsed.settings,{...settings,resolution:1.25});assert.equal(url.searchParams.get('keep'),'yes');assert.ok(!url.searchParams.has('azimuth'));assert.equal(url.hash,'#play');
});
test('invalid deep links cannot become arbitrary fetch paths or non-finite settings',()=>{
 const p=readShareState('https://example.com/?course=../../secret&hole=-1&time=NaN&resolution=99&date=2026-02-31');assert.equal(p.course,null);assert.equal(p.hole,null);assert.equal(p.hasRoute,false);assert.deepEqual(p.settings,{resolution:2});assert.equal(readShareState('https://example.com/?course=pebble').course,'pebble');
});
test('drone travels behind the tee toward the green with gentle launch and arrival',()=>{
 const world={route:[{x:0,z:0},{x:20,z:-60},{x:-10,z:-120}],pin:{x:-10,z:-120},elevation:(x,z)=>4*Math.exp(-(((z+60)/15)**2))},flight=createDroneFlight(world),a=flight.sample(0),b=flight.sample(1);assert.ok(a.position.z>0);assert.ok(b.position.distanceTo(new Vec3(-10,10,-120))<45);
 for(let i=0;i<=100;i++){const p=flight.sample(i/100);assert.ok(p.position.y>=world.elevation(p.position.x,p.position.z)+5);assert.ok(p.position.toArray().every(Number.isFinite));}
 const start=flight.sample(.01).position.distanceTo(a.position),middle=flight.sample(.51).position.distanceTo(flight.sample(.5).position),finish=b.position.distanceTo(flight.sample(.99).position);assert.ok(start<middle*.03&&finish<middle*.03);assert.equal(ease(0),0);assert.equal(ease(1),1);
});
test('camera transitions preserve endpoints and frame-rate independence',()=>{
 function run(hz){const camera=new Camera(80,1,.06,1000),owner={camera,world:{elevation:()=>0}},motion=new CameraMotion(owner);camera.position.set(0,2,0);const from=cameraPose(camera);camera.position.set(20,10,-30);camera.lookAt(0,0,0);camera.fov=45;motion.toCurrent(from,2);for(let i=0;i<hz;i++)motion.update(1/hz);const halfway=cameraPose(camera);for(let i=0;i<hz+1;i++)motion.update(1/hz);assert.ok(camera.position.distanceTo(new Vec3(20,10,-30))<1e-8);return halfway;}
 const a=run(30),b=run(120);assert.ok(a.position.distanceTo(b.position)<1e-8);assert.ok(a.quaternion.angleTo(b.quaternion)<1e-7);assert.ok(Math.abs(a.fov-b.fov)<1e-8);
});
test('ball and ground markers clear sloping rendered triangles',()=>{
 const g=ground((x,z)=>2+x*.25+z*.1),world={surface:()=> 'rough',elevation:(x,z)=>2+x*.25+z*.1},y=ballSurfaceY(g,0,0);assert.ok((y-2)/Math.sqrt(1+.25**2+.1**2)>BALL_RADIUS);
 const points=groundAimPoints(world,g,{x:0,z:0},.4,30);assert.ok(points.length>=150);for(const p of points)assert.ok(p.y-visibleGroundHeight(g,p.x,p.z)>.08);
 const path=[{x:0,y:2+BALL_RADIUS,z:0,t:0,phase:'roll'},{x:3,y:2.75+BALL_RADIUS,z:0,t:1,phase:'rest'}],tracer=createTracer(path,world,g),p=tracer.geometry.attributes.position;for(let i=0;i<p.count;i++)assert.ok(p.getY(i)>=markerY(world,g,p.getX(i),p.getZ(i))-.000001);tracer.geometry.dispose();tracer.material.dispose();
});
