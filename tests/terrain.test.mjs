import test from 'node:test';import assert from 'node:assert/strict';
import {decodeTerrarium,sampleTerrain,lonLatToTile,tileToLonLat} from '../src/game/terrain.js';
import {makeWorld} from '../src/game/engine.js';
test('Terrarium bytes decode in metres, including sub-metre detail',()=>{assert.equal(decodeTerrarium(128,10,128),10.5);assert.equal(decodeTerrarium(127,255,0),-1)});
test('native Mercator pixel centers survive projection without a resampling grid',()=>{const t={zoom:16,tileSize:512,pixelOrigin:[10569*512,25608*512],width:2,height:2,values:[10,10,2,2]};const at=(x,y)=>tileToLonLat(10569+(x+.5)/512,25608+(y+.5)/512,16);assert.ok(Math.abs(sampleTerrain(t,...at(.5,0))-10)<1e-6);assert.ok(Math.abs(sampleTerrain(t,...at(.5,.9))-2.8)<1e-5);const p=lonLatToTile(...at(.5,.5),16);assert.ok(Math.abs(p[0]-10569-1/512)<1e-9)});
test('coastal masks cannot flatten measured land or spread a cliff across a green',()=>{const box=[[0,0],[.001,0],[.001,.001],[0,.001],[0,0]],course={boundary:[box],terrain:null,features:[{id:'coast-water-test',kind:'water',closed:true,coords:box},{id:'green',kind:'green',closed:true,coords:box}],terrainByHole:{1:{width:4,height:2,bounds:[0,0,.001,.001],values:[10,10,10,1,10,10,10,1],spacing:1}}},hole={number:1,route:[[.0001,.0005],[.0005,.0005]]};const w=makeWorld(course,hole),p=w.toLocal([.0005,.0005]);assert.equal(w.elevation(p.x,p.z),10);assert.equal(w.terrainSpacing,1);});
test('legacy coarse snapshot never flashes as measured terrain before native detail arrives',()=>{const box=[[0,0],[.001,0],[.001,.001],[0,.001],[0,0]],course={boundary:[box],features:[{id:'green',kind:'green',closed:true,coords:box}],terrain:{width:2,height:2,bounds:[0,0,.001,.001],values:[20,1,20,1]}};const hole={number:1,route:[[.0001,.0005],[.0005,.0005]]},preview=makeWorld(course,hole);assert.equal(preview.terrainReady,false);assert.equal(preview.elevation(0,0),0);course.terrainByHole={1:{width:4,height:2,bounds:[0,0,.001,.001],values:[10,10,10,1,10,10,10,1],spacing:1}};const ready=makeWorld(course,hole);assert.equal(ready.terrainReady,true);assert.equal(ready.elevation(0,0),10);assert.equal(ready.elevation(ready.pin.x,ready.pin.z),10);});

test('missing high-resolution tiles fall back to native lower-zoom samples without rescaling',async t=>{
 const {fetchHoleTerrain}=await import('../src/game/terrain.js'),requests=[],messages=[];
 t.mock.method(globalThis,'fetch',async url=>{requests.push(url);return {ok:!url.includes('/16/'),status:404,blob:async()=>new Blob()}});
 const oldBitmap=globalThis.createImageBitmap,oldCanvas=globalThis.OffscreenCanvas;
 globalThis.createImageBitmap=async()=>({width:512,height:512,close(){}});globalThis.OffscreenCanvas=class{getContext(){return{drawImage(){},getImageData(){const data=new Uint8ClampedArray(512*512*4);for(let i=0;i<data.length;i+=4){data[i]=133;data[i+1]=220;}return{data}}}}};
 t.after(()=>{globalThis.createImageBitmap=oldBitmap;globalThis.OffscreenCanvas=oldCanvas});
 const terrain=await fetchHoleTerrain({}, {route:[[-115.536,51.173],[-115.535,51.174]]},new AbortController().signal,m=>messages.push(m));
 assert.equal(terrain.zoom,15);assert.equal(terrain.fallback,true);assert.equal(terrain.tileSize,512);assert.equal(terrain.values[0],1500);assert.ok(requests.some(u=>u.includes('/16/')));assert.match(messages[0],/HTTP 404.*z16 tile/);
});
test('cancelled elevation does not fall through to additional zoom levels',async t=>{
 const {fetchHoleTerrain}=await import('../src/game/terrain.js'),controller=new AbortController();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;controller.abort();throw controller.signal.reason});
 await assert.rejects(fetchHoleTerrain({}, {route:[[0,0],[.001,.001]]},controller.signal),{name:'AbortError'});assert.ok(calls<=4);
});

test('outside regional pixel centers retains nearest measured height, never sea level',()=>{
 const t={zoom:12,tileSize:512,pixelOrigin:[730*512,1368*512],width:2,height:2,values:[1350,1351,1352,1353]};
 const far=tileToLonLat(740,1378,12);assert.equal(sampleTerrain(t,...far),null);assert.equal(sampleTerrain(t,...far,true),1353);
 const sw=tileToLonLat(730,1368+2/512,12),ne=tileToLonLat(730+2/512,1368,12);t.bounds=[...sw,...ne];
 const ring=[sw,[ne[0],sw[1]],ne,[sw[0],ne[1]],sw],hole={number:1,route:[sw,ne]},w=makeWorld({terrain:t,boundary:[ring],features:[]},hole);
 assert.ok(w.elevation(1000,1000)>1300);assert.ok(w.elevation(-1000,-1000)>1300);
});
