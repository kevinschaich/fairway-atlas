// Course renderer: owns the scene database (dist/core) and hands it to the WebGPU engine (dist/gpu/backend.js) every
// frame. There is no other renderer. The scene holds only what the engine draws as objects or reads as data: the
// course ground heightfield (height bake + ball contact), ball, club, flag and cup, buildings, the shot tracer, the
// map/overview overlays and the aim line. Terrain surfaces, turf, flora, water, sky and lighting are the engine's own.
import {windVector} from './physics-conditions.js';
import {cupMesh} from './cup-rendering.js';import {BUDGET} from './gpu/budget.js';
import {clubBackswing,clubReleaseMs,clubSwingAt} from './club-animation.js';
import {readShareState} from './share-state.js';
import {DEFAULT_EFFECTS,cleanEffects} from './render-effects.js';
import {CameraMotion,cameraPose,createDroneFlight,ease,greenTarget} from './camera-motion.js';
import {ballSurfaceY,markerY,visualBallY,groundAimPoints,visibleGroundHeight,turfHeight} from './ground-contact.js';
import {DEFAULT_LIGHTING,daylight,sunWindow} from './lighting-settings.js';
import {FreeCamera} from './free-camera.js';
import {sampleShot,followPose,smoothFactor} from './follow-camera.js';
import {createClub} from './club-models.js';
import {createTracer} from './shot-tracer.js';
import {BALL_RADIUS} from './ball-physics.js';
import {pointIn,caddieTarget,teeClub,clubs} from './engine.js';import {teeSets} from './tee-sets.js';
// every tee on the course, with its hole's set colour, teeing point and axis (the opening leg)
function allTeeSets(w){const map=new Map(),tees=w.features.filter(f=>f.kind==='tee'&&f.closed),routes=(w.courseRoutes||[]).map(r=>r.route);
 for(const r of w.courseRoutes||[]){if(!r.route?.[1])continue;const ax=Math.atan2(r.route[1].z-r.route[0].z,r.route[1].x-r.route[0].x);for(const s of teeSets(tees,r.route,routes))if(!map.has(s.id))map.set(s.id,{...s,axis:ax});}
 for(const s of w.teeSets||[])map.set(s.id,{...s,axis:null});return map;}
import {GROUND} from './ground-palette.js';
import {courseGroundGeometry} from './landscape-mesh.js';
import {addBuildings} from './landscape-buildings.js';
import {paintInferredSea} from './coast.js';
import {createTeeDivots} from './tee-divots.js';
import {waterLevel} from './water-level.js';import {GAME_NAME} from './brand.js';import {createGolfBall,updateBallMaterial} from './golf-ball.js';import {createFlagstick} from './flagstick.js';import {createTeeDressing,createSwingDivot} from './tee-dressing.js';import {createPuttGrid} from './putt-grid.js';import {sandSurfaceFn} from './gpu/lip.js';
import {lonLatToTile,tileToLonLat,sampleTerrain} from './terrain.js';
import {Vec3,Quat,MathUtils,Node,Group,Mesh,Line,LineSegments,Scene,Camera,Material,Texture,Geometry,OrbitControls,sphereGeometry,ringGeometry,cylinderGeometry,planeGeometry} from './core/index.js';

export const SUN=new Vec3(-.68,.42,.60).normalize();
const palette=GROUND;

export class CourseRenderer {
 constructor(container,onFrame,{manual=false}={}){
  this.manual=manual;let stored={};try{stored=cleanEffects(JSON.parse(localStorage.getItem('fairway-effects-v1')))}catch{}
  this.effects={...DEFAULT_EFFECTS,...stored,...readShareState(location.href).effects};this.userEffects={...this.effects};
  this.lighting={...DEFAULT_LIGHTING};this.sunState=daylight(this.lighting);SUN.set(...this.sunState.direction);
  this.container=container;this.onFrame=onFrame;this.scene=new Scene();this.camera=new Camera(80,1,.06,30000);
  this.canvas=document.createElement('canvas');this.canvas.id='gpuCanvas';Object.assign(this.canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',display:'block'});container.insertBefore(this.canvas,container.firstChild);
  this.group=new Group();this.flag=new Group();this.scene.add(this.group,this.flag);
  this.time={value:0};this.natural={value:1};
  this.ball=createGolfBall();this.scene.add(this.ball);
  this.ring=new Mesh(ringGeometry(.10,.13,32),new Material({kind:'unlit',color:'#eef5c9',transparent:true,opacity:.4}));this.ring.rotation.x=-Math.PI/2;this.scene.add(this.ring);
  this.line=new Line(new Geometry(),new Material({kind:'unlit',color:'#e8ffc3',transparent:true,opacity:.5}));this.scene.add(this.line);
  this.tracer=new Mesh(new Geometry(),new Material({kind:'tracer',visible:false}));this.tracer.visible=false;this.scene.add(this.tracer);
  this.followEnabled=true;this.addClub();this.last=performance.now();this.frames=0;this.fps=0;this.mode='natural';this.cameraType='shot';this.pitch=-.52;
  this.freeCamera=new FreeCamera(this);this.cameraMotion=new CameraMotion(this);this.setLighting(this.lighting);
  this.controls=new OrbitControls(this.camera,this.canvas);this.controls.enableDamping=true;this.controls.enableZoom=false;this.controls.maxDistance=20000;this.controls.maxPolarAngle=Math.PI*.49;this.controls.enabled=false;
  // Mouse-look: any movement over the scene turns the camera (no button needed); raw deltas so it works from anywhere.
  // Middle mouse button toggles mouse-look (pivot) on/off, e.g. to park the view and move the cursor over the scene.
  this.mouseLook=true;this.canvas.addEventListener('mousedown',e=>{if(e.button!==1)return;e.preventDefault();this.mouseLook=!this.mouseLook;document.body.classList.toggle('look-paused',!this.mouseLook);this.onMouseLook?.(this.mouseLook);});
  this.canvas.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault()});
  this.canvas.addEventListener('pointermove',e=>{if(e.pointerType==='touch'||!this.mouseLook||!['shot','free'].includes(this.cameraType)||this.shot||this.cameraMotion.active)return;const dx=e.movementX||0,dy=e.movementY||0;if(!dx&&!dy)return;if(Math.abs(dx)>200||Math.abs(dy)>200)return;if(this.cameraType==='free'&&this.freeCamera.frozen)return;const pose=this.cameraType==='free'?this.freeCamera:this;pose.yaw+=dx*.003;pose.pitch=MathUtils.clamp(pose.pitch-dy*.003,-1.48,1.48);pose.look()});
  this.canvas.addEventListener('wheel',e=>{if(['shot','free','fly'].includes(this.cameraType)){this.zoom(e.deltaY*.025);}else if(this.cameraType==='plan'){const radius=this.targetDistance??this.camera.position.distanceTo(this.controls.target);this.targetDistance=MathUtils.clamp(radius*Math.exp(e.deltaY*.001),20,20000);}},{passive:true});
  new ResizeObserver(()=>this.resize()).observe(container);this.resize();this.tick=this.tick.bind(this);if(!this.manual)requestAnimationFrame(this.tick);
  if(navigator.gpu)import('./gpu/backend.js').then(m=>{const g=new m.GpuBackend(this);return g.init().then(()=>{this.gpu=g;this.applyGpuEffects()})}).catch(e=>{console.error('WebGPU engine failed:',e);this.showUnsupported(e.message)});
  else this.showUnsupported('This browser does not support WebGPU.');
 }
 showUnsupported(msg){const d=document.createElement('div');d.className='engine-error';d.style.cssText='position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:#e9f1dd;background:#12211d;font:15px/1.5 system-ui';
  d.innerHTML=`<div><b>${GAME_NAME} needs WebGPU.</b><br>${String(msg).replace(/</g,'&lt;')}<br>Use a current Chrome, Edge or Safari.</div>`;this.container.append(d);}
 addClub(){this.clubModel=new Group();this.clubPivot=new Group();this.clubModel.add(this.clubPivot);this.scene.add(this.clubModel);this.setClub(4)}
 resize(){const{width,height}=this.container.getBoundingClientRect();if(!width||!height)return;this.camera.aspect=width/height;this.camera.updateProjectionMatrix();if(this.world&&this.cameraType==='plan')this.setCamera('plan');else if(this.overviewRings&&this.overview)this.fitOverviewBoundary(this.overviewRings)}
 disposeGroup(g){if(!g)return;g.traverse(o=>{o.geometry?.dispose();o.material?.map?.dispose?.();});g.clear();}
 effectGroup(key,build){if(this.userEffects[key]===false)return;const before=new Set(this.group.children);build();for(const o of this.group.children)if(!before.has(o))o.userData.effect=key;}
 // Build-time reveal: terrain rises from flat, then buildings grow out of it, then foliage.
 // this.reveal = {want:{elev,buildings,trees}, p:{...}} while a course is being built; null = show all.
 applyReveal(dt){const r=this.reveal;if(!r)return;const dur=r.fast?{elev:.9,buildings:.5,trees:.6}:{elev:2.4,buildings:1.6,trees:1.8},E=t=>t<=0?0:t>=1?1:1-Math.pow(1-t,3);let moving=false;
  for(const k of ['elev','buildings','trees'])if(r.want[k]&&r.p[k]<1){r.p[k]=Math.min(1,r.p[k]+Math.min(dt,1/20)/dur[k]);moving=true;}
  if(this.group)this.group.scale.y=.012+.988*E(r.p.elev);
  const b=E(r.p.buildings);for(const o of this.group?.children||[])if(o.userData.effect==='buildings'){o.visible=b>0;o.scale.y=Math.max(.001,b);}
  this.treeReveal=E(r.p.trees);
  if(moving)this.invalidateShadows();if(r.p.elev>=1&&r.p.buildings>=1&&r.p.trees>=1&&r.finishing){if(this.group)this.group.scale.y=1;this.treeReveal=1;this.reveal=null;}}
 revealDone(){return !this.reveal||(this.reveal.p.elev>=1&&this.reveal.p.buildings>=1&&this.reveal.p.trees>=1)}
 clearEffectGroup(key){for(const o of [...this.group.children])if(o.userData.effect===key){this.group.remove(o);this.disposeGroup(o);}}
 // Rendering effects toggles -> engine switches (passes skipped, shader terms killed with the profiler's kill bits)
 applyGpuEffects(){const u=this.userEffects||{};if(!this.gpu)return;this.gpu.noGrass=u.grass===false;this.gpu.skip={...(this.gpu.skip||{}),shadow:u.shadows===false,vol:u.atmosphere===false,bloom:u.bloom===false,ocean:u.water===false};this.gpu.noClouds=u.clouds===false;this.gpu.noFlora=u.trees===false;
  const B=(on,...bits)=>on===false?bits.reduce((m,b)=>m|(1<<b),0):0;
  this.gpu.effectMask=B(u.shadows,0,2)|B(u.terrainShadows,3)|B(u.clouds,4)|B(u.atmosphere,5)|B(u.ao,1,9)|B(u.surfaceDetail,6,7,8,10,15);}
 setEffects(change){const c=cleanEffects(change),prev=this.userEffects;this.userEffects={...prev,...c};this.effects={...this.effects,...c};const u=this.userEffects;this.applyGpuEffects();this.invalidateShadows();
  if('buildings' in c&&c.buildings!==prev.buildings&&this.world){this.clearEffectGroup('buildings');this.effectGroup('buildings',()=>addBuildings(this));}
  if('tracer' in c&&c.tracer!==prev.tracer){if(!u.tracer)this.clearTracer();else if(this.lastTracerPath&&this.world)this.replaceTracer(this.lastTracerPath);}
  this.effectChangedAt=performance.now();this.frames=0;this.last=performance.now();}
 clearTracer(){this.scene.remove(this.tracer);this.tracer.geometry.dispose();this.tracer=new Mesh(new Geometry(),new Material({kind:'tracer',visible:false}));this.tracer.visible=false;this.scene.add(this.tracer);this.tracerDone=null;}
 replaceTracer(path){this.lastTracerPath=path;this.scene.remove(this.tracer);this.tracer.geometry.dispose();this.tracer=createTracer(path,this.world,this.terrain.geometry);this.tracer.material.uniforms.viewport.value.set(this.container.clientWidth,this.container.clientHeight);this.tracer.material.uniforms.elapsed.value=this.shot?Math.max(0,(performance.now()-this.shot.start)/1000):path.at(-1).t;this.tracer.userData.update();this.scene.add(this.tracer);}
 renderStats(){const g=this.gpu,st=g?.drawStats||{},mem=g?.mem?.total();return{fps:this.fps,frameMs:this.frameMilliseconds||0,drawCalls:st.draws||0,triangles:st.tris||0,textures:mem?.count||0,geometries:0,programs:0,renderScale:1,effects:{...this.userEffects},gpu:g?.timer?{...g.timer.avg}:{}};}

 load(world,courseView=false){
  this.loadTimings={};let phase=performance.now();const mark=k=>{this.loadTimings[k]=performance.now()-phase;phase=performance.now();};
  this.cameraMotion?.cancel();this.droneFlight=null;this.lastTracerPath=null;this.tracerDone=null;this.clearTracer();
  this.courseView=courseView;this.overview=false;this.ball.visible=this.ring.visible=this.line.visible=true;this.world=world;this.setLighting(this.lighting);
  {const dk=world.features.length+'|'+(world.courseRoutes||[]).length+'|'+world.features.reduce((n,f)=>n+(f.points?.length||0),0)+'|'+(world.tee?.x??'')+','+(world.tee?.z??'')+','+(world.pin?.x??'')+','+(world.pin?.z??'');if(this.divotCache?.key!==dk)this.divotCache={key:dk,value:createTeeDivots(world.features,world.courseRoutes,{sets:allTeeSets(world),tee:world.tee,axis:world.tee&&world.pin?(()=>{const t=caddieTarget(world,world.tee,teeClub(world));return Math.atan2(t.z-world.tee.z,t.x-world.tee.x);})():null})};world.divots=this.divotCache.value;}mark('divots');
  this.generation=(this.generation||0)+1;const generation=this.generation;this.disposeGroup(this.group);this.swingDivots=null;this.disposeGroup(this.flag);this.mappingMesh=null;
  const b=courseView?world.courseBBox:world.bbox;this.center={x:(b.minX+b.maxX)/2,z:(b.minZ+b.maxZ)/2};const cb=world.courseBBox,size=Math.max(cb.maxX-cb.minX,cb.maxZ-cb.minZ)+320;this.terrainBox={x:(cb.minX+cb.maxX)/2-size/2,z:(cb.minZ+cb.maxZ)/2-size/2,size};
  // base colour map of the mapped surfaces (the engine's ground albedo and its surface classes start from it)
  const canvas=document.createElement('canvas');canvas.width=canvas.height=courseView?2048:BUDGET.baseMap;const resolution=canvas.width,ctx=canvas.getContext('2d'),scale=resolution/size,box0=this.terrainBox;
  const paintBase=()=>{ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle=palette.rough;ctx.fillRect(0,0,resolution,resolution);ctx.save();ctx.scale(scale,scale);ctx.translate(-box0.x,-box0.z);
   for(const kind of['wood','scrub','bare_rock','sand','rough','fairway','bunker','tee','green','water'])if(!this.revealHide?.has(kind))for(const f of world.features.filter(f=>f.kind===kind&&f.closed)){ctx.beginPath();f.points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();for(const ring of f.innerPoints||[]){ring.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();}ctx.fillStyle=palette[kind];ctx.fill('evenodd');}
   ctx.restore();if(!courseView)paintInferredSea(canvas,world,box0,palette,(f,x,z)=>x>=f.bounds.minX&&x<=f.bounds.maxX&&z>=f.bounds.minZ&&z<=f.bounds.maxZ&&pointIn([x,z],f.points));};
  paintBase();if(!courseView)this.paintStripes(world);
  const texture=new Texture(canvas,{colorSpace:'srgb'});this.repaintBase=()=>{paintBase();texture.needsUpdate=true;};mark('baseMap');
  const geo=courseGroundGeometry(world,this.terrainBox,courseView);if(!courseView){geo.userData.bake={box:{...this.terrainBox},N:BUDGET.heightBake(this.terrainBox.size)};world.__ground=(x,z)=>visibleGroundHeight(geo,x,z);}else world.__ground=null;   /* mirrors backend.bakeHeight; physics uses the drawn ground */mark('groundGeometry');
  this.terrain=new Mesh(geo,new Material({kind:'ground',map:texture}));this.group.add(this.terrain);
  this.mappingMesh=new Mesh(geo,new Material({kind:'unlit',transparent:true,opacity:0,depthWrite:false}));this.mappingMesh.position.y=.08;this.mappingMesh.visible=false;this.group.add(this.mappingMesh);
  this.water={level:waterLevel(world,this.terrainBox)};mark('water');this.addFlag();this.setBall(world.tee);this.surfacesReady=true;
  setTimeout(()=>{if(this.generation!==generation)return;this.effectGroup('buildings',()=>addBuildings(this));this.onDetail?.()},0);
 }
 showOverview(item,signal,onStage){
  document.body.classList.remove('free-view');this.freeCamera.keys.clear();this.camera.clearViewOffset();this.overview=true;this.overviewItem=item;this.overviewTerrain=null;this.overviewRings=null;this.overviewBoundary=null;this.overviewTiles=[];this.overviewOpacity=.5;this.world=null;this.fly=false;
  this.generation=(this.generation||0)+1;const generation=this.generation;this.disposeGroup(this.group);this.swingDivots=null;this.disposeGroup(this.flag);this.mappingMesh=null;this.ball.visible=this.ring.visible=this.line.visible=this.clubModel.visible=false;this.tracer.visible=false;
  const z=15,c=lonLatToTile(item.center.lon,item.center.lat,z),x0=Math.floor(c[0]-.5),y0=Math.floor(c[1]-.5),cos=Math.cos(item.center.lat*Math.PI/180),local=(x,y)=>{const g=tileToLonLat(x,y,z);return[(g[0]-item.center.lon)*111320*cos,(item.center.lat-g[1])*111320]};
  const nw=local(x0,y0),se=local(x0+2,y0+2),cx=(nw[0]+se[0])/2,cz=(nw[1]+se[1])/2,span=se[0]-nw[0];this.center={x:cx,z:cz};this.cameraType='plan';this.camera.near=10;this.controls.enabled=true;this.camera.fov=48;this.camera.updateProjectionMatrix();this.controls.target.set(0,0,0);const h=span*.90/Math.min(1,this.camera.aspect);this.camera.position.set(0,h,h*.48);this.controls.update();
  const baseGeo=planeGeometry(se[0]-nw[0],se[1]-nw[1],128,128);baseGeo.rotateX(-Math.PI/2);baseGeo.translate(cx,-.1,cz);this.overviewBase=new Mesh(baseGeo,new Material({color:'#66816a',roughness:1}));this.group.add(this.overviewBase);
  onStage?.('blank mapper');let ready=0;
  for(let x=x0;x<x0+2;x++)for(let y=y0;y<y0+2;y++)(async()=>{try{
   const url=`https://tile.openstreetmap.org/${z}/${x}/${y}.png`,r=await fetch(url,{signal,referrerPolicy:'strict-origin-when-cross-origin'});if(!r.ok)throw Error(`Overview tile HTTP ${r.status}`);const bitmap=await createImageBitmap(await r.blob(),{imageOrientation:'flipY'});if(signal.aborted||generation!==this.generation){bitmap.close();return}
   const a=local(x,y),b=local(x+1,y+1),tex=new Texture(bitmap,{colorSpace:'srgb'});tex.onDispose=()=>bitmap.close();const geo=planeGeometry(b[0]-a[0],b[1]-a[1],64,64);geo.rotateX(-Math.PI/2);geo.translate((a[0]+b[0])/2,0,(a[1]+b[1])/2);
   const mesh=new Mesh(geo,new Material({kind:'unlit',map:tex,transparent:true,opacity:this.overviewOpacity,depthWrite:false}));mesh.position.y=.05;this.group.add(mesh);this.overviewTiles.push(mesh);if(this.overviewTerrain)this.sculptOverview(this.overviewTerrain);ready++;if(ready===1)onStage?.('first raster tile');if(ready===4)onStage?.('raster complete');
  }catch(e){if(!signal.aborted&&generation===this.generation)this.onOverviewError?.(e.message)}})();
 }
 setOverviewBoundary(rings){
  if(!this.overview)return;this.overviewRings=rings;this.fitOverviewBoundary(rings);if(this.overviewBoundary){this.group.remove(this.overviewBoundary);this.disposeGroup(this.overviewBoundary)}this.overviewBoundary=new Group();
  const c=this.overviewItem.center,cos=Math.cos(c.lat*Math.PI/180);
  for(const ring of rings){const positions=ring.map(([lon,lat])=>new Vec3((lon-c.lon)*111320*cos,1.5,(c.lat-lat)*111320)),line=new Line(new Geometry().setFromPoints(positions),new Material({kind:'unlit',color:'#f0ff9c',transparent:true,opacity:this.overviewOpacity,depthTest:false}));this.overviewBoundary.add(line)}
  this.group.add(this.overviewBoundary);if(this.overviewTerrain)this.sculptOverview(this.overviewTerrain);
 }
 fitOverviewBoundary(rings){const panelWidth=document.getElementById('mappingPanel')?.getBoundingClientRect().width||0;this.camera.setViewOffset(this.container.clientWidth,this.container.clientHeight,panelWidth/2,0,this.container.clientWidth,this.container.clientHeight);
  const c=this.overviewItem.center,cos=Math.cos(c.lat*Math.PI/180),pts=rings.flat().map(([lon,lat])=>[(lon-c.lon)*111320*cos,(c.lat-lat)*111320]),xs=pts.map(p=>p[0]),zs=pts.map(p=>p[1]),minX=Math.min(...xs)-80,maxX=Math.max(...xs)+80,minZ=Math.min(...zs)-80,maxZ=Math.max(...zs)+80,width=maxX-minX,depth=maxZ-minZ;this.center={x:(minX+maxX)/2,z:(minZ+maxZ)/2};
  const tan=Math.tan(this.camera.fov*Math.PI/360),height=Math.max(depth*.5*(1/tan+.55)/1.3025,(width*.5/(tan*this.camera.aspect)*this.container.clientWidth/Math.max(220,this.container.clientWidth-(panelWidth||0)-100)+.55*depth*.5/Math.sqrt(1.3025))/Math.sqrt(1.3025))*1.5;
  this.controls.target.set(this.center.x,0,this.center.z);this.camera.position.set(this.center.x,height,this.center.z+height*.55);this.controls.update();this.overviewBase.geometry.dispose();const geo=planeGeometry(width,depth,128,128);geo.rotateX(-Math.PI/2);geo.translate(this.center.x,-.1,this.center.z);this.overviewBase.geometry=geo;}
 setOverviewOpacity(opacity){this.overviewOpacity=opacity;for(const mesh of this.overviewTiles||[])mesh.material.opacity=opacity;this.overviewBoundary?.traverse(o=>{if(o.material)o.material.opacity=opacity})}
 sculptOverview(terrain){
  if(!this.overview)return;this.overviewTerrain=terrain;const c=this.overviewItem.center,cos=Math.cos(c.lat*Math.PI/180),base=sampleTerrain(terrain,c.lon,c.lat)??terrain.values.find(Number.isFinite)??0;
  const shape=(object,lift)=>{const a=object.geometry.attributes.position;for(let i=0;i<a.count;i++){const lon=c.lon+a.getX(i)/(111320*cos),lat=c.lat-a.getZ(i)/111320;a.setY(i,(sampleTerrain(terrain,lon,lat)??base)-base+lift)}a.needsUpdate=true;if(object.isMesh)object.geometry.computeVertexNormals();object.geometry.computeBoundingSphere()};
  if(this.overviewBase)shape(this.overviewBase,-.1);for(const tile of this.overviewTiles||[])shape(tile,0);this.overviewBoundary?.children.forEach(line=>shape(line,1.5));
 }
 setMapping(enabled,layers={},opacity=.5,imagery=null){
  this.mappingEnabled=enabled;this.mappingLayers=layers;this.mappingOpacity=opacity;this.mappingImagery=imagery;if(!this.mappingMesh)return;this.mappingMesh.visible=Boolean(enabled)&&opacity>0;this.mappingMesh.material.opacity=opacity;if(!enabled||opacity===0)return;
  const b=this.terrainBox,canvas=document.createElement('canvas');canvas.width=canvas.height=2048;const ctx=canvas.getContext('2d'),scale=2048/b.size;ctx.scale(scale,scale);ctx.translate(-b.x,-b.z);
  if(imagery?.image){const r=imagery.b;ctx.drawImage(imagery.image,r.x,r.z,r.w,r.h)}
  const colors={green:'#dbeab4',tee:'#f1f4df',fairway:'#a9c98a',bunker:'#eadbb0',water:'#a5d4d6',rough:'#8fa780'};
  for(const f of [...this.world.surfaces].reverse())if(layers[f.kind]){ctx.beginPath();f.points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.fillStyle=colors[f.kind]||'#aac688';ctx.globalAlpha=.3;ctx.fill();ctx.globalAlpha=.9;ctx.strokeStyle=colors[f.kind]||'#aac688';ctx.lineWidth=.45;ctx.stroke();ctx.globalAlpha=1;ctx.lineWidth=0;ctx.stroke()}
  if(layers.routing){ctx.beginPath();for(const h of this.world.courseRoutes)h.route.forEach((p,i)=>i?ctx.lineTo(p.x,p.z):ctx.moveTo(p.x,p.z));ctx.strokeStyle='#ffffffb3';ctx.lineWidth=Math.max(.6,b.size/1600);ctx.setLineDash([b.size/160,b.size/230]);ctx.stroke();ctx.setLineDash([]);}
  this.mappingMesh.material.map?.dispose();this.mappingMesh.material.map=new Texture(canvas,{colorSpace:'srgb'});this.mappingMesh.material.needsUpdate=true;
 }
 addFlag(){const w=this.world;
  // Flagstick (flagstick.js): polished stainless stick, ferrule and cap; a cloth flag on a pivot that turns downwind and waves.
  const fs=createFlagstick();const pole=fs.pole,pivot=fs.pivot;this.flagPivot=pivot;this.flagCloth=fs;
  // when the GPU's course relief is read back, the ground everything sits on moves: re-seat the ball, cup/flag and tee dressing
  this.onReliefReady=()=>{const ww=this.world;if(!ww||!this.terrain)return;const g=this.terrain.geometry;this.installSandFloor();if(!this.shot&&this.ball)this.setBall({x:this.ball.position.x,z:this.ball.position.z});
   if(ww.pin)this.flag.position.y=visibleGroundHeight(g,ww.pin.x,ww.pin.z);
   if(this.teeDressing){this.group.remove(this.teeDressing);this.disposeGroup(this.teeDressing);this.teeDressing=null;}
   if(ww.divots){this.teeDressing=createTeeDressing(ww.divots,g,ww);this.group.add(this.teeDressing);}this.buildTeeAxis();};
  this.buildTeeAxis();
  const cup=cupMesh(w);this.flag.add(pole,pivot,cup);if(w.divots){const td=createTeeDressing(w.divots,this.terrain.geometry,w);this.group.add(td);this.teeDressing=td;}this.flag.position.set(w.pin.x,visibleGroundHeight(this.terrain.geometry,w.pin.x,w.pin.z),w.pin.z);this.updatePin();}
 // Visual debug: the tee reference axis, from the teeing position to the caddie's first aim point (markers across it,
 // divots along it, club face square to it). renderer.showTeeAxis toggles it.
 buildTeeAxis(){const w=this.world;if(this.teeAxisLine){this.group.remove(this.teeAxisLine);this.teeAxisLine.geometry.dispose();this.teeAxisLine=null;}if(!w?.tee||!w.pin||!this.terrain)return;
  const t=caddieTarget(w,w.tee,teeClub(w)),g=this.terrain.geometry,pts=[],n=Math.ceil(Math.hypot(t.x-w.tee.x,t.z-w.tee.z)/.5);
  for(let i=0;i<=n;i++){const x=w.tee.x+(t.x-w.tee.x)*i/n,z=w.tee.z+(t.z-w.tee.z)*i/n;pts.push(new Vec3(x,visibleGroundHeight(g,x,z)+.03,z));}
  const mk=w.divots?.markers?.find(m=>Math.hypot(m.anchor.x-w.tee.x,m.anchor.z-w.tee.z)<.01);
  const segs=[];for(let i=0;i<pts.length-1;i++)segs.push(pts[i],pts[i+1]);
  if(mk)for(const p of [mk.left,mk.right])segs.push(new Vec3(w.tee.x,visibleGroundHeight(g,w.tee.x,w.tee.z)+.03,w.tee.z),new Vec3(p.x,visibleGroundHeight(g,p.x,p.z)+.03,p.z));
  this.teeAxisLine=new LineSegments(new Geometry().setFromPoints(segs),new Material({kind:'unlit',color:'#ff3df2'}));this.teeAxisLine.visible=!!this.showTeeAxis;this.group.add(this.teeAxisLine);}
 // One ground for everything: inside the GPU's new-bunker box the sand is drawn as a bowl below the turf; publish its depth
 // to the CPU ground (visibleGroundHeight) and to the physics (engine.simulate) so a ball in a trap lands and rests on the sand.
 installSandFloor(){const w=this.world,g=this.terrain?.geometry,box=this.gpu?.sdfInfo?.box;if(!w||!g)return;g.userData.sandSurface=null;
  const surf=box?sandSurfaceFn(w,box,(x,z)=>turfHeight(g,x,z)):null;g.userData.sandSurface=surf;
  w.__sand=surf?(x,z)=>{const s=surf(x,z);return s==null?0:turfHeight(g,x,z)-s;}:null;
  /* physics lands, rolls and rests on exactly the drawn ground (B-spline height map + relief + sand floor) */w.__ground=g.userData.bake?(x,z)=>visibleGroundHeight(g,x,z):null;}
 // Green-reading grid: shown when the ball rests on the green (or the putter is out within 45 m of the pin); G toggles it.
 updatePuttGrid(frameDt){const w=this.world,b=this.ball?.position;if(!w?.pin||!b||!this.terrain)return;
  const onGreen=w.surface(b.x,b.z)==='green',near=Math.hypot(w.pin.x-b.x,w.pin.z-b.z)<45;
  const want=!this.shot&&!this.overview&&!this.courseView&&this.showPuttGrid!==false&&this.ball.visible!==false&&(onGreen||(this.clubIndex===5&&near));
  const key=[w.pin.x,w.pin.z,Math.atan2(b.z-w.pin.z,b.x-w.pin.x).toFixed(2),this.terrain.geometry.userData.relief?1:0].join('|');
  if(want&&this.puttGrid?.userData.key!==key&&this._pgMiss!==key){if(this.puttGrid){this.flag.parent?.remove?.(this.puttGrid);this.scene.remove(this.puttGrid);this.puttGrid.geometry.dispose();}this.puttGrid=createPuttGrid(w,this.terrain.geometry,b);if(!this.puttGrid)this._pgMiss=key;if(this.puttGrid){this.puttGrid.userData.key=key;this.scene.add(this.puttGrid);}}
  const g=this.puttGrid;if(!g)return;const m=g.material;m.opacity+=((want?.9:0)-m.opacity)*Math.min(1,frameDt*(want?3:6));g.visible=m.opacity>.01;}
 updateFlag(){if(this.teeAxisLine)this.teeAxisLine.visible=!!this.showTeeAxis;const p=this.flagPivot;if(!p||!this.world)return;const c=this.world.physicsConditions,v=c?windVector(c):{x:1,z:0},speed=Math.hypot(v.x,v.z),target=speed>.05?Math.atan2(-v.z,v.x):0;
  p.rotation.y+=(((target-p.rotation.y+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI)*.04;
  if(this.flagCloth&&p.visible!==false){const now=this.time.value,dt=Math.min(.1,Math.max(0,now-(this._flagT??now)));this._flagT=now;this.flagCloth.animate(now,speed,dt);}}
 // Bunker edge field (stripes-worker.js): signed distance into the sand, so a ball at rest sits on the sunk sand floor.
 paintStripes(world){
  const box=this.terrainBox,N=Math.min(box.size>1100?4096:2048,BUDGET.stripes??4096),texel=box.size/N;
  const feats=world.features.filter(f=>f.closed&&['fairway','tee','green','bunker'].includes(f.kind)).map(f=>({kind:f.kind,closed:true,points:f.points,innerPoints:f.innerPoints}));
  const routes=(world.courseRoutes||[]).map(r=>({route:(r.route||[]).map(p=>({x:p.x,z:p.z}))}));
  const key=[box.x,box.z,box.size,N,feats.length,feats.reduce((s,f)=>s+f.points.length,0),routes.length].join('|');
  const apply=r=>{const {mown,sand}=r;
   const sample=(f,x,z)=>{const u=(x-box.x)/texel-.5,v=(z-box.z)/texel-.5,i=Math.max(0,Math.min(N-2,Math.floor(u))),j=Math.max(0,Math.min(N-2,Math.floor(v))),fu=Math.min(1,Math.max(0,u-i)),fv=Math.min(1,Math.max(0,v-j)),k=j*N+i;return (f[k]*(1-fu)+f[k+1]*fu)*(1-fv)+(f[k+N]*(1-fu)+f[k+N+1]*fu)*fv;};
   this.edgeField={mown:(x,z)=>sample(mown,x,z),sand:(x,z)=>sample(sand,x,z)};this.installSandFloor();
   if(this.ball&&this.world)this.setBall({x:this.ball.position.x,z:this.ball.position.z});this.onBuildStep?.('stripes');};
  if(this.stripeCache?.key===key){apply(this.stripeCache.result);return;}this.edgeField=null;
  const id=(this.stripeJob=(this.stripeJob||0)+1);
  this.stripeWorker??=new Worker(new URL('./stripes-worker.js',import.meta.url));
  this.stripeWorker.onmessage=({data:r})=>{if(r.id!==this.stripeJob)return;this.stripeCache={key,result:r};apply(r);};
  // coalesce the burst of rebuilds during a course build so the worker only paints the latest layout
  clearTimeout(this.stripeTimer);this.stripeTimer=setTimeout(()=>{if(id===this.stripeJob)this.stripeWorker.postMessage({id,world:{features:feats,courseRoutes:routes},box:{x:box.x,z:box.z,size:box.size},N})},250);
 }
 setBall(p){this.ball.visible=true;if(p.depth!=null||!this.ballLie||Math.hypot(p.x-this.ballLie.x,p.z-this.ballLie.z)>1e-3)this.ballLie={x:p.x,z:p.z,depth:p.depth||0};const lieDepth=this.ballLie.depth;queueMicrotask(()=>this.updatePin());const geo=this.terrain?.geometry,y=geo?visibleGroundHeight(geo,p.x,p.z):this.world.elevation(p.x,p.z);const sink=lieDepth;   /* sand floor is part of visibleGroundHeight; this is the ball's own burial (plugged/settled in sand) */this.ball.position.set(p.x,(geo?ballSurfaceY(geo,p.x,p.z):y+BALL_RADIUS)-sink,p.z);
  const ring=this.ring.geometry.attributes.position;if(!this.ring.userData.flat)this.ring.userData.flat=ring.array.slice();const flat=this.ring.userData.flat;this.ring.rotation.set(0,0,0);this.ring.position.set(p.x,0,p.z);
  for(let i=0;i<ring.count;i++){const x=flat[i*3],z=flat[i*3+1];ring.setXYZ(i,x,geo?markerY(this.world,geo,p.x+x,p.z+z):y+.02,z);}ring.needsUpdate=true;this.ring.geometry.computeBoundingSphere();if(this.aim!=null&&!this.shot)this.poseClub(p);}
 setClub(index){queueMicrotask(()=>this.updatePin());if(this.clubIndex===index)return;this.clubIndex=index;this.disposeGroup(this.clubPivot);const model=createClub(index),hand=new Vec3(...model.userData.hand);
  this.clubSoles??=[];if(this.clubSoles[index]==null){let low=Infinity;model.updateMatrixWorld(true);model.traverse(o=>{const q=o.geometry?.attributes?.position;if(!q)return;for(let i=0;i<q.count;i++){const v=_v.set(q.getX(i),q.getY(i),q.getZ(i)).applyMatrix4(o.matrixWorld);if(v.y<.15&&v.y<low)low=v.y;}});this.clubSoles[index]=Number.isFinite(low)?Math.max(0,-low)+.002:0;}this.clubHand=hand;this.clubPivot.position.copy(hand);model.position.copy(hand).negate();this.clubPivot.add(model);this.clubPivot.rotation.set(0,0,0);
  /* lowest point of the head (sole/leading edge) in address coordinates: lifted so the sole rests on, not in, the ground */
  this.clubSole=this.clubSoles[index];if(this.clubAddress)this.poseClub(this.clubAddress);}
 // Address pose: the club's ground plane is the drawn ground under the ball (normal fitted over the ~25 cm footprint of the
 // head), its origin is the contact point directly below the ball centre, and it is raised just enough that no ground
 // within the low part of the swing arc pokes through the sole.
 poseClub(ball){this.clubAddress={x:ball.x,z:ball.z};const g=this.terrain?.geometry;if(!g)return;const H=(x,z)=>visibleGroundHeight(g,x,z),e=.12;
  const n=new Vec3(-(H(ball.x+e,ball.z)-H(ball.x-e,ball.z))/(2*e),1,-(H(ball.x,ball.z+e)-H(ball.x,ball.z-e))/(2*e)).normalize();
  const b=this.ball.position,c=new Vec3(b.x,b.y,b.z).addScaledVector(n,-BALL_RADIUS-.0015+(this.ballLie?.depth||0));   /* a buried ball sits below the surface; the club still rests on it */
  let lift=0;for(let r=.08;r<=.36;r+=.07)for(let k=0;k<12;k++){const a=k*Math.PI/6,x=c.x+Math.cos(a)*r,z=c.z+Math.sin(a)*r,plane=c.y-(n.x*(x-c.x)+n.z*(z-c.z))/n.y;lift=Math.max(lift,H(x,z)-plane);}
  lift=Math.min(.03,lift);this.clubModel.position.copy(c).addScaledVector(n,this.clubSole+lift);
  this.clubModel.quaternion.setFromAxisAngle(new Vec3(0,1,0),-this.aim).premultiply(new Quat().setFromUnitVectors(new Vec3(0,1,0),n));}
 // Flagstick stays in unless we're putting from inside 10 ft (3.05 m), like tending/pulling it.
 updatePin(){const w=this.world;if(!w?.pin||this.flag.children.length<2)return;const b=this.ball.position,near=Math.hypot(b.x-w.pin.x,b.z-w.pin.z)<3.05,pulled=this.clubIndex===5&&near;this.flag.children[0].visible=!pulled;this.flag.children[1].visible=!pulled;}
 setSwing(fraction){const angle=-clubBackswing(fraction,this.clubIndex===5);this.clubPivot.quaternion.setFromAxisAngle(new Vec3(.86,.52,0).normalize(),angle);}
 setAim(ball,angle,power=100){this.aim=angle*Math.PI/180;const len=Math.min(80,Math.max(8,power)),pts=groundAimPoints(this.world,this.terrain.geometry,ball,this.aim,len).map(p=>new Vec3(p.x,p.y,p.z));this.line.geometry.dispose();this.line.geometry=new Geometry().setFromPoints(pts);
  // Estimated-carry marker position (the HUD draws the caret at carryScreen())
  this.carryMarker??=new Node();{const a=pts[0],b=pts[pts.length-1],dx=b.x-a.x,dz=b.z-a.z,l=Math.hypot(dx,dz)||1,x=ball.x+dx/l*power,z=ball.z+dz/l*power;this.carryMarker.position.set(x,visibleGroundHeight(this.terrain.geometry,x,z)+.05,z);this.carryMarker.visible=!this.courseView&&this.cameraType!=='fly';}
  this.line.material.visible=false;this.ring.material.visible=false;this.poseClub(ball);if(this.cameraType==='shot'&&!this.shot){this.yaw=this.aim;this.look()}}
 look(immediate=false){if(!this.world)return;const from=cameraPose(this.camera),p=this.ball.position;this.camera.position.set(p.x-Math.sin(this.yaw)*2.95,p.y+1.62,p.z+Math.cos(this.yaw)*2.95);
  if(this.aimAtPin&&this.world?.pin){this.aimAtPin=false;const pin=this.world.pin,px=pin.x-this.camera.position.x,pz=pin.z-this.camera.position.z,py=(pin.y??this.world.elevation(pin.x,pin.z))-this.camera.position.y;this.yaw=Math.atan2(px,-pz);this.pitch=Math.atan2(py,Math.hypot(px,pz));this.camera.position.set(p.x-Math.sin(this.yaw)*2.95,p.y+1.62,p.z+Math.cos(this.yaw)*2.95);}
  const cp=Math.cos(this.pitch);this.camera.lookAt(this.camera.position.x+Math.sin(this.yaw)*cp,this.camera.position.y+Math.sin(this.pitch),this.camera.position.z-Math.cos(this.yaw)*cp);
  if(!immediate&&this.cameraWorld===this.world){this.lookTarget=this.camera.quaternion.clone();this.lookPosition=this.camera.position.clone();this.camera.position.copy(from.position);this.camera.quaternion.copy(from.quaternion);}}
 setCamera(type,ball,animate=true){this.invalidateShadows();if(!this.world)return;const previousPose=cameraPose(this.camera),sameWorld=this.cameraWorld===this.world;this.cameraWorld=this.world;this.cameraMotion.cancel();this.lookTarget=null;this.lookPosition=null;this.targetFov=null;this.targetDistance=null;this.flyZoomFov=null;this.droneFlight=null;
  if(!this.world.terrainReady&&type!=='plan'&&!this.allowFlatShot){type='plan';this.autoPlan=true;}const position={x:ball?.x??this.ball.position.x,z:ball?.z??this.ball.position.z};
  if((type==='plan'&&!this.planInGame)!==this.courseView){this.load(this.world,type==='plan'&&!this.planInGame);this.setBall(position);this.setMapping(this.mappingEnabled,this.mappingLayers,this.mappingOpacity,this.mappingImagery)}
  this.cameraType=type;if(this.carryMarker)this.carryMarker.visible=type==='shot'||type==='plan'||type==='follow'||type==='free';this.fly=type==='fly';this.controls.enabled=type==='plan';this.clubModel.visible=type==='shot'||type==='free';this.camera.near=type==='plan'?10:.06;this.camera.fov=type==='shot'?80:48;this.camera.clearViewOffset();
  const panel=document.getElementById('mappingPanel'),panelWidth=type==='plan'&&panel&&!panel.hidden?panel.getBoundingClientRect().width:0;if(panelWidth)this.camera.setViewOffset(this.container.clientWidth,this.container.clientHeight,panelWidth/2,0,this.container.clientWidth,this.container.clientHeight);this.camera.updateProjectionMatrix();
  const p=position,w=this.world;this.drag=null;document.body.classList.toggle('free-view',type==='free');document.body.classList.toggle('fly-view',type==='fly');
  if(type==='free'){if(previousPose.fov){this.camera.fov=previousPose.fov;this.camera.updateProjectionMatrix();}if(previousPose.position)this.camera.position.copy(previousPose.position);if(previousPose.quaternion)this.camera.quaternion.copy(previousPose.quaternion);this.freeCamera.enter();this.ring.visible=this.line.visible=false;return;}
  this.ring.visible=this.line.visible=true;
  if(type==='shot'){this.yaw=this.aim??Math.atan2(w.pin.x-p.x,-(w.pin.z-p.z));this.pitch=-.52;this.setSwing(0);this.aimAtPin=true;this.look(true)}
  else{const b=type==='plan'?w.courseBBox:w.bbox,width=b.maxX-b.minX,depth=b.maxZ-b.minZ,y=w.elevation(this.center.x,this.center.z),tan=Math.tan(this.camera.fov*Math.PI/360),height=type==='plan'?Math.max(depth*.5*(1/tan+.55)/1.3025,(width*.5/(tan*this.camera.aspect)*this.container.clientWidth/Math.max(220,this.container.clientWidth-(panelWidth||0)-100)+.55*depth*.5/Math.sqrt(1.3025))/Math.sqrt(1.3025))*1.2:Math.max(230,Math.hypot(w.pin.x-p.x,w.pin.z-p.z)*1.1)/Math.min(1,this.camera.aspect);
   this.controls.target.set(this.center.x,y,this.center.z);this.camera.position.set(this.center.x,y+height,this.center.z+height*.55);this.controls.update()}
  if(type==='fly'){this.yaw=this.aim??this.yaw;this.pitch=-.12;this.aimAtPin=false;const saveWorld=this.cameraWorld;this.cameraWorld=null;this.look(true);this.cameraWorld=saveWorld;const fpv=cameraPose(this.camera);this.droneFlight=createDroneFlight(this.world,fpv.position,this.ball.position);this.droneElapsed=0;this.flyBlend={from:fpv,t:0,orientOnly:true};const s=this.droneFlight.sample(0);this.camera.fov=s.fov;this.camera.updateProjectionMatrix();this.ring.visible=this.line.visible=false;}
  if(animate&&sameWorld&&type!=='fly')this.cameraMotion.toCurrent(previousPose,1.25);
  if(this.cameraMotion.active&&type==='shot'&&previousPose.position&&previousPose.position.y-this.cameraMotion.active.to.position.y>150){const b=this.ball.position;this.cameraMotion.active.focus=new Vec3(b.x,b.y,b.z);this.cameraMotion.active.duration=Math.max(this.cameraMotion.active.duration,2.2);}
 }
 zoom(amount){if(this.cameraType==='fly'){this.flyZoomFov=MathUtils.clamp((this.flyZoomFov??this.camera.fov)+amount,30,80);return;}if(['shot','free'].includes(this.cameraType)){this.targetFov=MathUtils.clamp((this.targetFov??this.camera.fov)+amount,30,80);return;}const from=cameraPose(this.camera);this.camera.position.sub(this.controls.target).multiplyScalar(amount>0?1.2:.8).add(this.controls.target);this.cameraMotion.toCurrent(from,.7);}
 invalidateShadows(){if(this.gpu)this.gpu.shadowDirty=true;}
 setRenderScale(value){this.renderScaleSetting=value;}
 setResolution(scale){this.resolutionScale=MathUtils.clamp(Number(scale)||1,.5,2);this.resize();}
 setLighting(settings){this.invalidateShadows();this.lighting={...this.lighting,...settings};const geo=this.world?.toGeo(this.world.tee),loc=geo?{lon:geo[0],lat:geo[1]}:undefined;this.sunWindow=sunWindow(this.lighting,loc);
  this.lighting.hour=Math.min(this.sunWindow.end,Math.max(this.sunWindow.start,this.lighting.hour??12));   /* the day runs sunrise+20 min .. sunset-20 min */
  const next=daylight(this.lighting,loc);SUN.set(...next.direction);this.sunState=next;}
 setMode(mode){this.mode=mode;this.natural.value=mode==='natural'?1:.25;}
 animateShot(result,onDone){this.cameraMotion.cancel();this.lookTarget=null;this.lookPosition=null;this.targetFov=null;this.fly=false;this.line.visible=this.ring.visible=false;const back=clubBackswing(result.input.power/100,this.clubIndex===5),release=clubReleaseMs(this.clubIndex===5);
  this.shot={result,start:performance.now()+release,release,back,onDone,launchCamera:this.camera.position.clone(),aim:this.aim};this.controls.enabled=false;this.lastTracerPath=result.path;if(this.userEffects.tracer!==false)this.replaceTracer(result.path);this.tracerDone=null;}
 tick(now){const cpuStart=performance.now();this.tickBody(now);this.cpuMs=(this.cpuMs??0)*.9+(performance.now()-cpuStart)*.1;}
 tickBody(now){// exactly one rAF chain, even if tick() is also called directly (e.g. to capture a frame)
  if(!this.manual){cancelAnimationFrame(this.rafId);this.rafId=requestAnimationFrame(this.tick);}
  const frameDt=Math.max(0,Math.min(.1,(now-(this.lastRender??now))/1000));this.frameMilliseconds=(this.frameMilliseconds??frameDt*1000)*.95+(now-(this.lastRender??now))*.05;this.lastRender=now;this.time.value=now/1000;this.frames++;if(now-this.last>1000){this.fps=Math.round(this.frames*1000/(now-this.last));this.last=now;this.frames=0}
  this.applyReveal(frameDt);
  const transitioning=this.cameraMotion.update(frameDt);if(!transitioning)this.freeCamera.update(frameDt);
  if(!transitioning&&this.lookTarget){const k=1-Math.exp(-18*frameDt);this.camera.quaternion.slerp(this.lookTarget,k);if(this.lookPosition)this.camera.position.lerp(this.lookPosition,k);}
  if(!transitioning&&this.targetFov!=null){this.camera.fov=MathUtils.lerp(this.camera.fov,this.targetFov,1-Math.exp(-10*frameDt));this.camera.updateProjectionMatrix();if(Math.abs(this.camera.fov-this.targetFov)<.01)this.targetFov=null;}
  if(this.fly&&this.world&&this.droneFlight&&!transitioning){this.droneElapsed=Math.min(this.droneFlight.duration,this.droneElapsed+frameDt*1.5);const pose=this.droneFlight.sample(this.droneElapsed/this.droneFlight.duration);this.camera.position.copy(pose.position);this.camera.lookAt(pose.target);
   if(this.flyBlend){this.flyBlend.t+=frameDt;const k=this.flyBlend.t/2.6,e=k>=1?1:k*k*k*(k*(k*6-15)+10);if(e<1){const q=this.camera.quaternion.clone();this.camera.quaternion.slerpQuaternions(this.flyBlend.from.quaternion,q,e);}else this.flyBlend=null;}
   if(this.droneElapsed>=this.droneFlight.duration){this.flyBlend=null;queueMicrotask(()=>{if(this.cameraType==='fly')this.setCamera('free',null,false)});}this.camera.fov=MathUtils.lerp(this.camera.fov,this.flyZoomFov??pose.fov,1-Math.exp(-10*frameDt));this.camera.updateProjectionMatrix();}
  if(this.shot){const s=this.shot,t=(now-s.start)/1000,path=s.result.path;const swing=clubSwingAt(t,s.back,s.release,this.clubIndex===5);this.clubPivot.quaternion.setFromAxisAngle(_swingAxis,swing);this.clubModel.visible=(this.cameraType==='shot'||this.cameraType==='free')&&t<.8;
   // divot: irons and wedges off turf take a scrape that opens from the ball toward the target as the club passes through
   if(t>=0&&!s.divot){s.divot=true;const inp=s.result.input||{},type=clubs[inp.club??this.clubIndex]?.type,lie=inp.lie||this.world.surface(path[0].x,path[0].z);
    if((type==='iron'||type==='wedge')&&['tee','fairway','rough'].includes(lie)){const hd=Math.atan2(-Math.cos(this.aim),Math.sin(this.aim)),m=createSwingDivot(this.terrain.geometry,path[0].x,path[0].z,hd);(this.swingDivots??=new Group());if(!this.swingDivots.parent)this.group.add(this.swingDivots);this.swingDivots.add(m);s.divotMesh=m;s.divotAt=now;}}
   if(s.divotMesh){const k=Math.min(1,(now-s.divotAt)/90);s.divotMesh.scale.x=Math.max(.001,1-(1-k)**3);}
   const ball=sampleShot(path,Math.max(0,t));const visualY=visualBallY(this.world,this.terrain.geometry,ball);this.ball.position.set(ball.x,visualY,ball.z);const rotation=_v.set(ball.wx||0,ball.wy||0,ball.wz||0),rate=rotation.length();if(rate>0)this.ball.rotateOnWorldAxis(rotation.divideScalar(rate),rate*frameDt);this.ballSpin={axis:rotation.clone(),arc:rate>0?rate*Math.min(frameDt,1/60)*.5:0};
   if(this.tracer.material.uniforms)this.tracer.material.uniforms.elapsed.value=Math.max(0,t);
   if(this.cameraType==='shot'&&t>.22){
    if(this.followEnabled){const pose=followPose(ball,s.aim,this.world.elevation,s.result.input.club===5),rate=smoothFactor(frameDt,3.5)*ease((t-.22)/.65);this.camera.position.lerp(_v.set(pose.position.x,pose.position.y,pose.position.z),rate);this.camera.position.y=Math.max(this.camera.position.y,this.world.elevation(this.camera.position.x,this.camera.position.z)+1.4);this.camera.fov=MathUtils.lerp(this.camera.fov,pose.fov,rate);this.camera.updateProjectionMatrix();}
    else{this.camera.position.lerp(s.launchCamera,smoothFactor(frameDt,4));this.camera.fov=MathUtils.lerp(this.camera.fov,80,smoothFactor(frameDt,4));this.camera.updateProjectionMatrix();}
    const q=this.camera.quaternion.clone();if(this.followEnabled){const lead=Math.min(.35,.12+Math.hypot(ball.vx,ball.vz)*.002);this.camera.lookAt(ball.x+ball.vx*lead,visualY+Math.max(0,ball.vy*lead*.5),ball.z+ball.vz*lead)}else this.camera.lookAt(greenTarget(this.world,this.camera.position));this.camera.quaternion.slerpQuaternions(q,this.camera.quaternion.clone(),smoothFactor(frameDt,9));
   }
   if(t>=path.at(-1).t+(this.followEnabled?1.15:0)){this.shot=null;this.tracerDone=now;this.line.visible=this.ring.visible=true;s.onDone()}
  }else if(this.tracerDone&&this.tracer.material.uniforms){this.tracer.material.uniforms.fade.value=Math.max(0,1-(now-this.tracerDone)/7000);}
  this.tracer.userData.update?.();this.updateFlag();if(!this.shot)this.ballSpin=null;updateBallMaterial(this.ball,this.ballSpin?.axis,this.ballSpin?.arc||0);this.updatePuttGrid(frameDt);{const cup=this.flag.children[2];cup?.userData.update?.(this.ball,this.flag.children[0]?.visible!==false);}
  if(this.controls.enabled&&!transitioning){if(this.targetDistance!=null){const offset=this.camera.position.clone().sub(this.controls.target),distance=offset.length(),next=MathUtils.lerp(distance,this.targetDistance,1-Math.exp(-12*frameDt));this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(),next);if(Math.abs(next-this.targetDistance)<.01)this.targetDistance=null;}this.controls.update();}
  this.camera.updateMatrixWorld();this.gpu?.render(now);this.onFrame?.(this,now);this.onEffectsFrame?.(this,now)
 }
 holeScreens(){if(!this.world||!this.courseHoles)return[];const w=this.container.clientWidth,h=this.container.clientHeight;return this.courseHoles.map(o=>{const q=this.world.toLocal(o.route.at(-1)),v=new Vec3(q.x,this.world.elevation(q.x,q.z)+2,q.z).project(this.camera);return{n:o.number,x:(v.x+1)/2*w,y:(1-v.y)/2*h,visible:v.z<1&&Math.abs(v.x)<1.05&&Math.abs(v.y)<1.05}})}
 carryScreen(){const m=this.carryMarker;if(!m||!m.visible||this.courseView)return null;const p=m.position.clone().project(this.camera);return{x:(p.x+1)/2*this.container.clientWidth,y:(1-p.y)/2*this.container.clientHeight,visible:p.z<1&&Math.abs(p.x)<1&&Math.abs(p.y)<1}}
 flagScreen(){if(!this.world)return null;const p=this.flag.position.clone().add(new Vec3(0,3.2,0)).project(this.camera);return{x:(p.x+1)/2*this.container.clientWidth,y:(1-p.y)/2*this.container.clientHeight,visible:p.z<1&&Math.abs(p.x)<1&&Math.abs(p.y)<1}}
}
const _swingAxis=new Vec3(.92,.38,0).normalize(),_v=new Vec3();
