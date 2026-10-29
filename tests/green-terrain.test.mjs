import test from 'node:test';import assert from 'node:assert/strict';
import {greenTerrain} from '../src/game/green-terrain.js';
import {groundNormal,surfaceStep,CONTACT} from '../src/game/ball-physics.js';
const green={id:'green',kind:'green',closed:true,points:[[-12,-10],[12,-10],[12,10],[-12,10],[-12,-10]],bounds:{minX:-12,maxX:12,minZ:-10,maxZ:10}};
test('regional hillside green is corrected locally and a stationary ball can rest',()=>{
 const raw=(x,z)=>1352+x*.21+z*.08,model=greenTerrain([green],raw),world={elevation:model.elevation};assert.equal(model.patches.length,1);assert.ok(model.patches[0].estimated);assert.ok(Math.abs(model.elevation(0,0)-1352)<.2);
 for(let x=-10;x<=10;x+=2)for(let z=-8;z<=8;z+=2){const n=groundNormal(world,x,z);assert.ok(Math.hypot(n.x,n.z)/n.y<.026);assert.equal(surfaceStep({x:0,y:0,z:0},{x:0,y:0,z:0},n,CONTACT.green,1/240).phase,'rest');}
 for(const p of [[21,0],[-21,0],[0,19],[0,-19]])assert.equal(model.elevation(...p),raw(...p));
});
test('ordinary slopes and isolated steep tiers are not globally flattened',()=>{
 const gentle=(x,z)=>20+x*.02+z*.01;assert.equal(greenTerrain([green],gentle).patches.length,0);
 const tier=(x,z)=>20+Math.max(0,x-9)*.25;assert.equal(greenTerrain([green],tier).patches.length,0);
 assert.equal(greenTerrain([green],()=>0).patches.length,0);
});
test('green collar blends continuously without moving a neighboring cliff',()=>{
 const raw=(x,z)=>x>22?5:30+x*.2,model=greenTerrain([green],raw);
 assert.ok(Math.abs(model.elevation(12-.0001,0)-model.elevation(12+.0001,0))<.001);
 assert.ok(Math.abs(model.elevation(20-.0001,0)-model.elevation(20+.0001,0))<.001);
 assert.equal(model.elevation(22.1,0),5);assert.equal(model.elevation(21.9,0),raw(21.9,0));
});
test('tees are levelled, fairways keep their tilt but lose implausible lumps, 6 ft buffer holds',()=>{
 const box=(kind,w,h)=>({id:kind,kind,closed:true,points:[[-w,-h],[w,-h],[w,h],[-w,h],[-w,-h]],bounds:{minX:-w,maxX:w,minZ:-h,maxZ:h}});
 const tee=box('tee',8,5),teeModel=greenTerrain([tee],(x,z)=>10+x*.12);assert.equal(teeModel.patches.length,1);
 assert.ok(Math.abs(teeModel.elevation(4,0)-teeModel.elevation(-4,0))/8<.016);
 // full correction inside the 6 ft buffer, continuous at the buffer edge
 assert.ok(Math.abs(teeModel.elevation(8+1.8,0)-(teeModel.elevation(8,0)+(8+1.8-8)*.015))<.03);
 assert.ok(Math.abs(teeModel.elevation(8+1.83-1e-4,0)-teeModel.elevation(8+1.83+1e-4,0))<.001);
 const fw=box('fairway',60,15);
 const hill=(x,z)=>50+x*.15;assert.equal(greenTerrain([fw],hill).patches.length,0);         // steady 15% hill: untouched
 const lumpy=(x,z)=>50+x*.15+Math.sin(x*.8)*1.2,m=greenTerrain([fw],lumpy);assert.equal(m.patches.length,1);
 let worst=0;for(let x=-50;x<50;x+=.5){const s=Math.abs(m.elevation(x+.25,0)-m.elevation(x-.25,0))/.5;worst=Math.max(worst,s)}
 assert.ok(worst<.27,'lumps softened while the 15% tilt is kept: '+worst);
 assert.ok(Math.abs((m.elevation(40,0)-m.elevation(-40,0))/80-.15)<.03);
});
