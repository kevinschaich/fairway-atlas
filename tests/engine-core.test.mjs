import test from 'node:test';import assert from 'node:assert/strict';
// The in-house engine core (src/game/core): math, curves, geometry builders, triangulation, scene database; plus the WebGPU
// engine's CPU-side terrain (CDLOD selection, height-cache windows) and the scene producers built on the core.
const E=await import('../src/game/core/index.js');
const {Vec3,Quat,Mat4,Color,Camera,Scene,Group,Mesh,Line,InstancedMesh,Material,Geometry,f32,CatmullRom3,Shape,Path}=E;
const {Terrain,CM_N,CM_L,CM_T0,LEAF}=await import('../src/game/gpu/terrain.js');
const {addBuildings}=await import('../src/game/landscape-buildings.js');
const {waterLevel}=await import('../src/game/water-level.js');
const {createClub}=await import('../src/game/club-models.js');
const {clubs}=await import('../src/game/engine.js');
const near=(a,b,e=1e-9)=>Math.abs(a-b)<=e;
const triArea=(p,a,b,c)=>Math.abs((p[b*2]-p[a*2])*(p[c*2+1]-p[a*2+1])-(p[c*2]-p[a*2])*(p[b*2+1]-p[a*2+1]))/2;

test('quaternion and Euler rotation stay in sync whichever one is written',()=>{
 const n=new Group();n.rotation.y=.7;const q=new Quat().setFromAxisAngle(new Vec3(0,1,0),.7);assert.ok(n.quaternion.angleTo(q)<1e-12);
 for(const [x,y,z] of [[.3,-.4,.2],[-1.1,.5,.9],[0,0,2.5]]){n.rotation.set(x,y,z);const back=n.quaternion.clone();n.quaternion.copy(back);assert.ok(near(n.rotation.x,x,1e-9)&&near(n.rotation.y,y,1e-9)&&near(n.rotation.z,z,1e-9));}
 n.quaternion.setFromAxisAngle(new Vec3(1,0,0),.3);assert.ok(near(n.rotation.x,.3,1e-12)&&near(n.rotation.y,0,1e-12));
});
test('camera lookAt aims -Z at the target, which projects to the screen centre in front of the camera',()=>{
 const c=new Camera(60,1.5,.1,1000);c.position.set(3,4,5);c.lookAt(-2,1,-7);c.updateMatrixWorld();const d=c.getWorldDirection(),w=new Vec3(-5,-3,-12).normalize();assert.ok(d.distanceTo(w)<1e-12);
 const p=new Vec3(-2,1,-7).project(c);assert.ok(Math.abs(p.x)<1e-12&&Math.abs(p.y)<1e-12&&p.z<1&&p.z>-1);
 const behind=new Vec3(8,7,17).project(c);assert.ok(behind.z>1||behind.z<-1);
});
test('matrix inverse, compose and view offset behave like a camera rig',()=>{
 const m=new Mat4().compose(new Vec3(1,2,3),new Quat().setFromAxisAngle(new Vec3(0,0,1).normalize(),.9),new Vec3(2,2,2)),i=m.clone().invert(),id=new Mat4().multiplyMatrices(m,i);
 for(let k=0;k<16;k++)assert.ok(near(id.elements[k],k%5===0?1:0,1e-12));
 const c=new Camera(50,2,.1,100);c.position.set(0,0,10);c.updateMatrixWorld();const x0=new Vec3(0,0,0).project(c).x;c.setViewOffset(1000,500,100,0,1000,500);const x1=new Vec3(0,0,0).project(c).x;
 assert.ok(near(x0-x1,.2,1e-9),'a 100 px window shift moves content 0.2 NDC left');assert.deepEqual(c.viewShift(),[.2,-0]);
});
test('colours are stored linear and round-trip through CSS hex',()=>{
 const c=new Color('#808080');assert.ok(near(c.r,.2158605,1e-6));assert.equal(c.getHex(),0x808080);assert.equal(new Color('#e9ac58').getStyle(),'#e9ac58');assert.equal(new Color('#fff').getHex(),0xffffff);
});
test('centripetal Catmull-Rom passes through its points with arc-length parametrised sampling',()=>{
 const pts=[new Vec3(0,0,0),new Vec3(4,1,0),new Vec3(5,0,6),new Vec3(12,3,7)],c=new CatmullRom3(pts);
 for(let i=0;i<pts.length;i++)assert.ok(c.getPoint(i/(pts.length-1)).distanceTo(pts[i])<1e-9);
 const L=c.getLength(),s=[];for(let i=0;i<=20;i++)s.push(c.getPointAt(i/20));for(let i=1;i<s.length;i++)assert.ok(Math.abs(s[i].distanceTo(s[i-1])-L/20)<L/20*.08);
 const f=c.computeFrenetFrames(24);for(let i=0;i<=24;i++){const t=f.tangents[i],n=f.normals[i],b=f.binormals[i];assert.ok(near(t.length(),1,1e-9)&&near(n.length(),1,1e-6)&&Math.abs(t.dot(n))<1e-6&&Math.abs(b.dot(n))<1e-6);}
});
test('2D paths sample lines, curves and arcs and close cleanly',()=>{
 const s=new Shape();s.moveTo(0,0);s.lineTo(4,0);s.bezierCurveTo(5,1,5,2,4,3);s.absarc(2,3,2,0,Math.PI,false);s.closePath();
 const p=s.getPoints(8);assert.ok(p[0].x===p.at(-1).x&&p[0].y===p.at(-1).y);assert.ok(p.length>=1+1+8+16);assert.ok(p.every(q=>Number.isFinite(q.x+q.y)));
 for(let i=1;i<p.length;i++)assert.ok(!(p[i].x===p[i-1].x&&p[i].y===p[i-1].y));
});
test('earcut triangulates polygons with holes: exact area, valid indices',()=>{
 const tris=E.triangulateShape([[0,0],[10,0],[10,10],[0,10]],[[[3,3],[3,7],[7,7],[7,3]]]),v=[0,0,10,0,10,10,0,10,3,3,3,7,7,7,7,3];let a=0;
 for(const [x,y,z] of tris){for(const k of [x,y,z])assert.ok(k>=0&&k<8);a+=triArea(v,x,y,z);}assert.ok(near(a,84,1e-9));
});
test('earcut keeps concave notches empty',()=>{
 const U=[[0,0],[9,0],[9,9],[6,9],[6,3],[3,3],[3,9],[0,9]],tris=E.triangulateShape(U.map(p=>p.slice())),v=U.flat();let a=0;for(const [x,y,z] of tris)a+=triArea(v,x,y,z);assert.ok(near(a,81-18,1e-9));
 const inside=(px,py,[a,b,c])=>{const s=(i,j)=>(v[j*2]-v[i*2])*(py-v[i*2+1])-(v[j*2+1]-v[i*2+1])*(px-v[i*2]);const d1=s(a,b),d2=s(b,c),d3=s(c,a);return (d1>0&&d2>0&&d3>0)||(d1<0&&d2<0&&d3<0);};
 assert.ok(!tris.some(t=>inside(4.5,6,t)),'the notch is not covered');
});
test('triangulation drops a duplicated closing point like a ring from OSM',()=>{
 const ring=[[0,0],[4,0],[4,4],[0,4],[0,0]];const t=E.triangulateShape(ring);assert.equal(ring.length,4);assert.equal(t.length,2);
});
const volume=g=>{const p=g.attributes.position.array;let v=0;for(let i=0;i<p.length;i+=9){const [ax,ay,az,bx,by,bz,cx,cy,cz]=p.slice(i,i+9);v+=(ax*(by*cz-bz*cy)-ay*(bx*cz-bz*cx)+az*(bx*cy-by*cx))/6;}return Math.abs(v);};
test('extrusion without bevel is a closed prism of area x depth',()=>{
 const s=new Shape([[0,0],[3,0],[3,2],[0,2]].map(([x,y])=>({x,y})));const g=E.extrudeGeometry(s,{depth:5,bevelEnabled:false});assert.ok(near(volume(g),30,1e-5));
 const h=new Shape([[0,0],[4,0],[4,4],[0,4]].map(([x,y])=>({x,y})));const hole=new Path();hole.moveTo(1,1);hole.lineTo(1,3);hole.lineTo(3,3);hole.lineTo(3,1);hole.closePath();h.holes.push(hole);
 assert.ok(near(volume(E.extrudeGeometry(h,{depth:2,bevelEnabled:false})),(16-4)*2,1e-5));
});
test('bevelled extrusion grows by the bevel and keeps unit normals (club heads)',()=>{
 const s=new Shape([[0,0],[.08,0],[.08,.03],[0,.03]].map(([x,y])=>({x,y})));const g=E.extrudeGeometry(s,{depth:.004,bevelEnabled:true,bevelSize:.002,bevelThickness:.0015,bevelSegments:4});const b=g.computeBoundingBox();
 assert.ok(near(b.min.x,-.002,1e-6)&&near(b.max.x,.082,1e-6)&&near(b.min.z,-.0015,1e-7)&&near(b.max.z,.0055,1e-7));const n=g.attributes.normal.array;for(let i=0;i<n.length;i+=3)assert.ok(near(Math.hypot(n[i],n[i+1],n[i+2]),1,1e-5));
});
test('sphere and cylinder normals are unit length and point outward',()=>{
 const s=E.sphereGeometry(2,24,16),p=s.attributes.position.array,n=s.attributes.normal.array;for(let i=0;i<p.length;i+=3){assert.ok(near(Math.hypot(n[i],n[i+1],n[i+2]),1,1e-6));assert.ok(p[i]*n[i]+p[i+1]*n[i+1]+p[i+2]*n[i+2]>0);}
 assert.equal(s.index.count/3,24*16*2-2*24);
 const c=E.cylinderGeometry(.5,.5,2,16),cp=c.attributes.position.array,cn=c.attributes.normal.array;for(let i=0;i<cp.length;i+=3)assert.ok(cp[i]*cn[i]+cp[i+1]*cn[i+1]+cp[i+2]*cn[i+2]>=0);
});
test('a ground plane faces up after rotateX(-90 deg) and keeps its uv layout',()=>{
 const g=E.planeGeometry(4,2,4,2).rotateX(-Math.PI/2),n=g.attributes.normal,uv=g.attributes.uv;for(let i=0;i<n.count;i++)assert.ok(near(n.getY(i),1,1e-12));
 assert.deepEqual([uv.getX(0),uv.getY(0)],[0,1]);const b=g.computeBoundingBox();assert.ok(near(b.max.x-b.min.x,4,1e-6)&&near(b.max.z-b.min.z,2,1e-6)&&near(b.max.y-b.min.y,0,1e-6));
});
test('non-indexed geometry gets flat face normals; geometry dispose notifies the GPU cache',()=>{
 const g=new Geometry();g.setAttribute('position',f32([0,0,0,1,0,0,0,0,-1],3));g.computeVertexNormals();for(let i=0;i<3;i++)assert.ok(near(g.attributes.normal.getY(i),1,1e-12));
 let freed=0;g.onDispose(()=>freed++);g.dispose();g.dispose();assert.equal(freed,1);
});
test('scene transforms update only when something moved (dirty tracking)',()=>{
 const s=new Scene(),a=new Group(),b=new Mesh(E.boxGeometry(),new Material());s.add(a);a.add(b);s.collect();const v0=b.worldVersion;s.collect();s.collect();assert.equal(b.worldVersion,v0,'static subtree is not recomputed');
 a.position.x=3;s.collect();assert.equal(b.worldVersion,v0+1,'a moved parent re-derives its children');assert.equal(b.matrixWorld.elements[12],3);
 b.rotation.y=Math.PI/2;s.collect();assert.equal(b.worldVersion,v0+2);s.collect();assert.equal(b.worldVersion,v0+2);
});
test('scene collect flattens visible drawables with inherited effect tags and honours skips',()=>{
 const s=new Scene(),fx=new Group(),hidden=new Group(),m1=new Mesh(E.boxGeometry(),new Material()),m2=new Mesh(E.boxGeometry(),new Material()),m3=new Mesh(E.boxGeometry(),new Material({visible:false})),l=new Line(new Geometry().setFromPoints([new Vec3(),new Vec3(1,0,0)]),new Material({kind:'unlit'})),skip=new Mesh(E.boxGeometry(),new Material());
 fx.userData.effect='buildings';fx.add(m1);hidden.visible=false;hidden.add(m2);s.add(fx,hidden,m3,l,skip);const list=s.collect(new Set([skip]));
 assert.deepEqual(list,[m1,l]);assert.equal(m1._fx,'buildings');const again=s.collect(new Set([skip]));assert.equal(again,list,'the list object is reused (no per-frame allocation)');
});
test('instanced meshes version their instance transforms',()=>{
 const im=new InstancedMesh(E.boxGeometry(),new Material(),3),m=new Mat4().makeTranslation(1,2,3);const v=im.instanceMatrix.version;im.setMatrixAt(2,m);assert.equal(im.instanceMatrix.version,v+1);assert.equal(im.instanceMatrix.array[2*16+13],2);
});

// ---- WebGPU engine terrain (CPU side)
const box={x:-1000,z:-1200,size:2300};
const terrain=()=>{const t=Object.create(Terrain.prototype);t.dev={queue:{writeBuffer(){}}};t.win=Array.from({length:CM_L},()=>({x:0,z:0,valid:false}));t.key=null;t.R0=16;t.regions=[];t.instData=new Float32Array(4096*4);t.instBuf={};t.full={count:32*32*6};t.half={count:16*16*6};t.stats={};
 t.setWorld(box,(x,z)=>20+10*Math.sin(x/90)*Math.cos(z/70));return t;};
const all=[{},{},{},{},{},{}].map(()=>0).flatMap(()=>[0,0,0,1]);   // six planes that accept everything
test('CDLOD selection tiles the whole course exactly once with neighbouring LODs at most one apart',()=>{
 const t=terrain();t.select({x:10,y:30,z:-20},all);const nodes=[];for(let i=0;i<t.stats.nodes;i++){const [x,z,cell,lod]=t.instData.slice(i*4,i*4+4);nodes.push({x,z,size:cell*(t.groups&&i>=t.groups[0]&&i<t.groups[0]+t.groups[1]?16:32),lod});}
 // node sizes come from the groups (full / half patches): recompute them exactly from the group ranges
 let k=0;const G=t.groups,sizes=[];for(let g=0;g<6;g++)for(let j=0;j<G[g];j++)sizes.push(g&1?16:32);nodes.forEach((n,i)=>n.size=t.instData[i*4+2]*sizes[i]);
 let area=0;for(const n of nodes){const x0=Math.max(n.x,box.x),x1=Math.min(n.x+n.size,box.x+box.size),z0=Math.max(n.z,box.z),z1=Math.min(n.z+n.size,box.z+box.size);area+=Math.max(0,x1-x0)*Math.max(0,z1-z0);}
 assert.ok(Math.abs(area-box.size*box.size)<1e-3*box.size*box.size,'no gaps or overlaps');
 const touch=(a,b)=>{const ox=Math.min(a.x+a.size,b.x+b.size)-Math.max(a.x,b.x),oz=Math.min(a.z+a.size,b.z+b.size)-Math.max(a.z,b.z);return (ox===0&&oz>0)||(oz===0&&ox>0);};
 let pairs=0;for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++)if(touch(nodes[i],nodes[j])){pairs++;assert.ok(Math.abs(nodes[i].lod-nodes[j].lod)<=1);}assert.ok(pairs>50);
});
test('CDLOD is finest under the camera, coarser with distance, and front-to-back within each draw group',()=>{
 const t=terrain(),cam={x:100,y:25,z:100};t.select(cam,all);const n=t.stats.nodes,d=i=>{const x=t.instData[i*4],z=t.instData[i*4+1];return Math.hypot(x-cam.x,z-cam.z);};
 let under=null;for(let i=0;i<n;i++){const x=t.instData[i*4],z=t.instData[i*4+1],s=t.instData[i*4+2]*32;if(cam.x>=x&&cam.x<x+s&&cam.z>=z&&cam.z<z+s)under=t.instData[i*4+3];}assert.equal(under,0);
 const lods=Array.from({length:n},(_,i)=>t.instData[i*4+3]);assert.ok(Math.max(...lods)>=6);
 let o=0;for(const cnt of t.groups){for(let i=o+1;i<o+cnt;i++)assert.ok(d(i)+1e-9>=d(i-1)-t.instData[i*4+2]*32*1.5);o+=cnt;}
});
test('frustum culling drops terrain behind the camera',()=>{
 const t=terrain();t.select({x:0,y:30,z:0},all);const everything=t.stats.nodes;const front=[0,0,-1,0,...Array(20).fill(0).map((_,i)=>i%4===3?1:0)];   // keep only z<0
 t.select({x:0,y:30,z:0},front);assert.ok(t.stats.nodes<everything*.9);for(let i=0;i<t.stats.nodes;i++)assert.ok(t.instData[i*4+1]<1e-6,'every kept node reaches z<0');
});
test('height-cache windows update only newly exposed strips as the camera moves; data changes rebuild all levels',()=>{
 const t=terrain(),out=new Float32Array(32);assert.equal(t.plan({x:0,z:0},'k1',out),CM_L,'first frame builds every level');
 assert.equal(t.plan({x:0,z:0},'k1',out),0,'still camera: nothing to do');
 t.plan({x:3.1,z:0},'k1',out);const r=t.regions;assert.ok(r.length>=1&&r.every(([,,, w,h])=>w*h<CM_N*CM_N/8),'only thin strips');assert.ok(r.every(([l])=>l===0||l===1));
 assert.equal(t.plan({x:3.1,z:0},'k2',out),CM_L,'new ground data rebuilds every level');
 for(let l=0;l<CM_L;l++){assert.equal(out[l*4+2],CM_T0*2**l);assert.equal(out[l*4+3],1);const cx=(out[l*4]+CM_N/2)*out[l*4+2];assert.ok(Math.abs(cx-3.1)<=CM_T0*2**l*16);}
 t.plan({x:3.1,z:0},'k2',out,.4);assert.ok(near(out[31],.4,1e-6),'vertical reveal scale rides along');
});
test('bunker footprint test finds nodes that contain sand and only those',()=>{
 const t=terrain(),pos=[];for(let a=0;a<6.28;a+=.1)pos.push(50+6*Math.cos(a),0,60+4*Math.sin(a));t.setBunkers(new Float32Array(pos),[0,0,300]);
 assert.equal(t.hasBunker(40,50,20),true);assert.equal(t.hasBunker(100,100,16),false);assert.equal(t.hasBunker(-400,-400,64),false);assert.equal(t.hasBunker(0,0,512),true);
});

// ---- producers built on the core
test('buildings extrude footprints with outward walls and upward roofs, merged per cell',()=>{
 const sq=(x,z,s)=>[[x,z],[x+s,z],[x+s,z+s],[x,z+s],[x,z]];const f=(pts,tags={})=>({kind:'building',closed:true,points:pts,tags,bounds:{minX:Math.min(...pts.map(p=>p[0])),maxX:Math.max(...pts.map(p=>p[0])),minZ:Math.min(...pts.map(p=>p[1])),maxZ:Math.max(...pts.map(p=>p[1]))}});
 const group=new Group(),owner={group,terrainBox:{x:-500,z:-500,size:1000},world:{features:[f(sq(0,0,10),{height:'9'}),f(sq(30,0,8).reverse()),f([[60,0],[80,0],[80,5],[60,5],[60,0]],{'roof:shape':'gabled'})],elevation:()=>2}};
 addBuildings(owner);assert.equal(group.children.length,2,'one roof mesh and one wall mesh for the cell');const [roof,wall]=[group.children.find(m=>m.material.color.getStyle()==='#665f51'),group.children.find(m=>m.material.color.getStyle()==='#bfb9a8')];
 for(const m of group.children)assert.equal(m.userData.effect,'buildings');const rn=roof.geometry.attributes.normal;for(let i=0;i<rn.count;i++)assert.ok(rn.getY(i)>-1e-9,'roof faces up (gable ends vertical)');
 const wp=wall.geometry.attributes.position,wn=wall.geometry.attributes.normal;for(let i=0;i<wp.count;i++){const x=wp.getX(i),z=wp.getZ(i),c=x<20?[5,5]:x<50?[34,4]:[70,2.5];assert.ok((x-c[0])*wn.getX(i)+(z-c[1])*wn.getZ(i)>0,'walls face out of the footprint');assert.ok(Math.abs(wn.getY(i))<1e-9);}
 const tall=Math.max(...Array.from({length:wp.count},(_,i)=>wp.getY(i)));assert.equal(tall,11);
});
test('water level: sea level on the coast, the prominent pond inland, none without water',()=>{
 const tee={x:0,z:0},box={x:-500,z:-500,size:1000};assert.equal(waterLevel({features:[],tee},box),undefined);
 assert.equal(waterLevel({features:[{id:'coast-water-1',kind:'water',closed:true,points:[[0,0],[10,0],[10,10]]}],tee},box),.65);
 const pond={id:'p',kind:'water',closed:true,points:[[20,20],[60,20],[60,60],[20,60],[20,20]],tags:{}};const lvl=waterLevel({features:[pond],tee,elevation:()=>12},box);assert.ok(near(lvl,12.12,1e-9),'pond level: lower-quartile shore height + 12 cm');
});
test('every club model is finite geometry with a head and a grip in address pose',()=>{
 for(let i=0;i<clubs.length;i++){const g=createClub(i);let tris=0;g.traverse(o=>{if(!o.isMesh)return;const p=o.geometry.attributes.position.array;for(const v of p)assert.ok(Number.isFinite(v));tris+=o.geometry.index?o.geometry.index.count/3:p.length/9;});
  assert.ok(tris>2000);assert.ok(g.children[0].children.length>0);assert.ok(g.userData.hand[1]>.7);}
});
test('terrain entirely inside mapped sea gets the cheap sea pipeline, and is skipped under a drawn ocean',()=>{
 const t=terrain(),N=512,k=new Uint8Array(N*N);for(let z=0;z<N;z++)for(let x=0;x<N;x++)k[z*N+x]=x>=N/2?6:1;t.setWater(k,N,box,6);   // east half of the box is sea
 const cam={x:box.x+box.size/2,y:40,z:box.z+box.size/2};t.select(cam,all,1,.65,true);const sea=t.groups[4]+t.groups[5];assert.ok(sea>10);
 let o=t.groups[0]+t.groups[1]+t.groups[2]+t.groups[3];for(let i=o;i<o+sea;i++){const x=t.instData[i*4],s=t.instData[i*4+2]*32;assert.ok(x-3>=box.x+box.size/2-1e-6,'sea nodes lie wholly in the sea (3 m margin)');}
 const total=t.stats.nodes;t.select(cam,all,1,.65,false);assert.equal(t.groups[4]+t.groups[5],0);assert.equal(t.stats.nodes,total-sea);
 t.select(cam,all,.5,.65,true);assert.equal(t.groups[4]+t.groups[5],0,'not while the course is still rising');
});
