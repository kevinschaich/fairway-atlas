import test from 'node:test';import assert from 'node:assert/strict';
import {clipWater,waterProfile,gradedTriangles} from '../src/game/water-geometry.js';
import {sampleCanopy,canopyTiles} from '../src/game/canopy-data.js';
import {featuresFrom} from '../src/game/course-data.js';
test('long river uses local mountain elevation despite remote polygon vertices',()=>{
 const points=clipWater([[-10000,-20],[10000,-20],[10000,20],[-10000,20]],{x:-100,z:-100,size:200});assert.ok(points.every(p=>Math.abs(p[0])<=100));
 const profile=waterProfile({tags:{water:'river'}},points,(x,z)=>Math.abs(x)>100?0:1350+x*.01);assert.ok(profile.level>1300);assert.equal(profile.height(50,0),1350.62);
 const vertices=gradedTriangles(points,[0,1,2,0,2,3],profile.height,24);for(let i=1;i<vertices.length;i+=3)assert.ok(vertices[i]>1349&&vertices[i]<1352);assert.ok(vertices.length>18);
});
test('categorical canopy coverage is not interpolated as class IDs',()=>{
 assert.equal(canopyTiles([-115.6,51.1,-115.5,51.2])[0].lat,51);
 const t={origin:[0,2],resolution:[1,-1],width:2,height:2,values:[10,80,30,20]};const c=sampleCanopy({tiles:[t]},1,1);assert.equal(c.trees,.25);assert.equal(c.shrubs,.25);assert.equal(sampleCanopy({tiles:[t]},9,9),null);
});
test('woodland relation inner rings preserve mapped clearings',()=>{
 const geometry=r=>r.map(([lon,lat])=>({lon,lat})),outer=[[0,0],[10,0],[10,10],[0,10],[0,0]],inner=[[2,2],[4,2],[4,4],[2,4],[2,2]];
 const [f]=featuresFrom([{id:1,type:'relation',tags:{natural:'wood'},members:[{role:'outer',geometry:geometry(outer)},{role:'inner',geometry:geometry(inner)}]}]);assert.deepEqual(f.holes,[inner]);
});

import {withEstimatedPar} from '../src/game/par-estimate.js';
test('estimated par uses full route yardage while preserving authoritative par',()=>{
 const hole=y=>({route:[[0,0],[y*.9144/111195,0]]});
 assert.equal(withEstimatedPar(hole(175)).par,3);assert.equal(withEstimatedPar(hole(400)).par,4);assert.equal(withEstimatedPar(hole(550)).par,5);assert.equal(withEstimatedPar(hole(720)).par,6);
 const known={...hole(175),par:4};assert.equal(withEstimatedPar(known),known);
 const dogleg={route:[[0,0],[.002,0],[.002,.002],[0,.002]]};assert.equal(withEstimatedPar(dogleg).par,6);assert.equal(withEstimatedPar(hole(175)).parEstimated,true);
});
