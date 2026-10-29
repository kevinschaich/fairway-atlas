import test from 'node:test';
import assert from 'node:assert/strict';
const {Mesh,Material,Scene,Camera,Vec3,Geometry,f32,planeGeometry}=await import('../src/game/core/index.js');
const {CourseRenderer}=await import('../src/game/renderer.js');

test('uninitialized mapping preference never renders the empty white overlay',()=>{
 const overlay=new Mesh(planeGeometry(),new Material({kind:'unlit',transparent:true}));
 const scene=new Scene();scene.add(overlay);const owner={mappingMesh:overlay};
 CourseRenderer.prototype.setMapping.call(owner,undefined,{},.5);
 const visible=[];scene.traverseVisible(object=>visible.push(object));
 assert.equal(overlay.visible,false);assert.ok(!visible.includes(overlay));
 overlay.geometry.dispose();
});

test('mapping off and zero opacity both hide an existing overlay',()=>{
 for(const [enabled,opacity] of [[false,.5],[true,0]]){
  const owner={mappingMesh:{visible:true,material:{opacity:1}}};
  CourseRenderer.prototype.setMapping.call(owner,enabled,{},opacity);
  assert.equal(owner.mappingMesh.visible,false);assert.equal(owner.mappingMesh.material.opacity,opacity);
 }
});

const {courseGroundGeometry}=await import('../src/game/landscape-mesh.js');
const {visibleGroundHeight,CUTS,BUNKER_SINK}=await import('../src/game/ground-contact.js');
test('rendered-ground heights follow both triangles of nonplanar cells, cut heights order the lies, bunker floors deepen inward',()=>{
 const geometry=new Geometry();geometry.setAttribute('position',f32([0,0,0,1,.02,0,0,.03,1,1,.10,1],3));geometry.userData.grid={xs:[0,1],zs:[0,1]};
 for(const [x,z,expected] of [[.2,.3,.013],[.8,.7,.062]])assert.ok(Math.abs(visibleGroundHeight(geometry,x,z)-expected)<1e-7);
 assert.ok(CUTS.green.height<CUTS.tee.height&&CUTS.tee.height<CUTS.fairway.height&&CUTS.fairway.height<CUTS.rough.height);
 assert.ok(BUNKER_SINK(0)>0&&BUNKER_SINK(1)<BUNKER_SINK(2.5)&&Math.abs(BUNKER_SINK(9)-BUNKER_SINK(2.5))<1e-12);
});
const {DEFAULT_LIGHTING,daylight}=await import('../src/game/lighting-settings.js');
test('solar direction responds to date, latitude and sun time with a normalized warm evening light',()=>{
 const evening=daylight({...DEFAULT_LIGHTING,date:'2026-09-25',hour:17}),noon=daylight({...DEFAULT_LIGHTING,date:'2026-09-25',hour:12}),morning=daylight({...DEFAULT_LIGHTING,date:'2026-09-25',hour:7});assert.ok(evening.altitude>5&&evening.altitude<20);assert.ok(Math.abs(Math.hypot(...evening.direction)-1)<1e-12);assert.ok(evening.color[2]<noon.color[2]);assert.ok(evening.azimuth>180&&evening.azimuth<300);assert.ok(morning.azimuth>60&&morning.azimuth<180);
 const north=daylight({...DEFAULT_LIGHTING,date:'2026-06-21',hour:12},{lat:40,lon:-105}),south=daylight({...DEFAULT_LIGHTING,date:'2026-06-21',hour:12},{lat:-40,lon:150});assert.ok(north.altitude>south.altitude+40);assert.equal(daylight({...DEFAULT_LIGHTING,hour:0}).intensity,0);
});

const {FreeCamera}=await import('../src/game/free-camera.js');
test('free movement is frame-rate independent, clears terrain and preserves the lie',()=>{
 const make=()=>{const free=Object.create(FreeCamera.prototype);free.owner={cameraType:'free',camera:new Camera(),world:{elevation:()=>3},ball:{x:7,z:9},aim:.7,strokes:2};free.owner.camera.position.set(0,5,0);free.keys=new Set(['KeyW','KeyD']);free.yaw=.3;free.pitch=0;return free;};
 const a=make(),b=make();for(let i=0;i<30;i++)a.update(1/30);for(let i=0;i<120;i++)b.update(1/120);assert.ok(a.owner.camera.position.distanceTo(b.owner.camera.position)<.05);const d1=a.owner.camera.position.distanceTo(new Vec3(0,5,0));assert.ok(d1>2&&d1<6);{const c=make();for(let i=0;i<120;i++)c.update(1/30);assert.ok(c.owner.camera.position.distanceTo(new Vec3(0,5,0))-d1>3*6*1.5,'accelerates');}
 a.keys=new Set(['KeyQ','ShiftLeft']);a.update(1);assert.equal(a.owner.camera.position.y,3.4);assert.deepEqual(a.owner.ball,{x:7,z:9});assert.equal(a.owner.strokes,2);assert.equal(a.owner.aim,.7);
 a.owner.cameraType='shot';const p=a.owner.camera.position.clone();a.update(1);assert.ok(p.equals(a.owner.camera.position));
});

const {roundedBoundary}=await import('../src/game/rounded-boundaries.js');
const {polygonValid,polygonArea,pointIn}=await import('../src/game/engine.js');
const {createTeeDivots,insideDivot}=await import('../src/game/tee-divots.js');
test('rounded outlines remain valid, closed and close to mapped boundaries',()=>{
 const raw=[[0,0],[20,0],[20,10],[0,10],[0,0]],smooth=roundedBoundary(raw,1.1);assert.deepEqual(smooth[0],smooth.at(-1));assert.ok(polygonValid(smooth));assert.ok(smooth.length>raw.length);assert.ok(polygonArea(smooth)>polygonArea(raw)*.99);assert.deepEqual(raw[0],[0,0]);assert.deepEqual(smooth,roundedBoundary(raw,1.1));
});
test('each tee gets stable inset divots inside its outline',()=>{
 const features=[0,30].map((x,i)=>({id:'tee'+i,kind:'tee',closed:true,points:roundedBoundary([[x,0],[x+10,0],[x+10,8],[x,8],[x,0]],.55),bounds:{minX:x,maxX:x+10,minZ:0,maxZ:8}}));const divots=createTeeDivots(features);assert.deepEqual(divots,createTeeDivots(features));
 for(const f of features)assert.ok(divots.filter(d=>d.tee===f.id).length>=4);for(const d of divots){assert.ok(pointIn([d.x,d.z],features.find(f=>f.id===d.tee).points));assert.ok(insideDivot(d,d.x,d.z));assert.ok(!insideDivot(d,d.x+1,d.z+1));}
});
test('render resolution changes only through an explicit setting and clamps its range',()=>{let resizes=0;const owner={resize(){resizes++}};for(const [input,expected]of [[.75,.75],[1.5,1.5],[8,2],[.1,.5]]){CourseRenderer.prototype.setResolution.call(owner,input);assert.equal(owner.resolutionScale,expected);}assert.equal(resizes,4);});
