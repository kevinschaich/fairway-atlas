import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const {GAME_NAME,PAGE_TITLE}=await import('../src/game/brand.js');
const {teeSets,whiteTee}=await import('../src/game/tee-sets.js');
const {createTeeDivots}=await import('../src/game/tee-divots.js');
test('the page title mirrors the single game-name constant',()=>{const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');assert.equal(html.match(/<title>([^<]*)<\/title>/)[1],PAGE_TITLE);assert.ok(PAGE_TITLE.startsWith(GAME_NAME));});
const box=(x,z,w=10,d=8)=>({id:`t${x},${z}`,points:[[x-w/2,z-d/2],[x+w/2,z-d/2],[x+w/2,z+d/2],[x-w/2,z+d/2]]});
const route=[{x:0,z:0},{x:0,z:300},{x:0,z:400}];
test('tee set colours follow the number of boxes on the hole',()=>{
 assert.deepEqual(teeSets([box(0,0)],route).map(s=>s.color),['white']);
 assert.deepEqual(teeSets([box(0,40),box(0,-10)],route).map(s=>s.color),['blue','white']);
 assert.deepEqual(teeSets([box(0,60),box(0,-10),box(0,25)],route).map(s=>s.color),['blue','white','red']);
 const w=whiteTee(teeSets([box(0,40),box(0,-10)],route),route);assert.ok(Math.abs(w.point.z-40)<1e-6&&Math.abs(w.yards-360/.9144)<1e-6);});
test('tees nearer another hole are not claimed',()=>{const other=[{x:60,z:0},{x:60,z:300}];assert.equal(teeSets([box(55,0)],route,[route,other]).length,0);});
test('markers sit across the axis 2 ft in from the sides; divots run along it between them',()=>{
 const f={id:'tee',kind:'tee',closed:true,points:[[-6,-4],[6,-4],[6,4],[-6,4],[-6,-4]],bounds:{minX:-6,maxX:6,minZ:-4,maxZ:4}};
 const d=createTeeDivots([f],[],{tee:{x:0,z:0},axis:Math.PI/2});const m=d.markers[0];
 assert.ok(Math.abs(Math.abs(m.left.x)-(6-.61))<.06&&Math.abs(m.left.z)<1e-6&&Math.abs(m.right.z)<1e-6);
 for(const v of d){assert.ok(Math.abs(Math.cos(v.angle))<.2,'long side along the axis');assert.ok(Math.abs(v.z)<=.3+1e-9,'on the marker line');assert.ok(Math.abs(v.x)<6);}});
