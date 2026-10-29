import test from 'node:test';import assert from 'node:assert/strict';import {sampleShot,followPose,smoothFactor} from '../src/game/follow-camera.js';
const path=[{x:0,y:0,z:0,t:0},{x:0,y:10,z:-50,t:1},{x:0,y:0,z:-100,t:2}];
test('playback interpolates the physical path without showing future ball positions',()=>{const p=sampleShot(path,.5);assert.equal(p.z,-25);assert.equal(p.y,5);assert.equal(sampleShot(path,10).z,-100);});
test('follow rig stays behind the shot and clears intervening hills',()=>{const b=sampleShot(path,.5),pose=followPose(b,0,(x,z)=>z>-10?12:0);assert.ok(pose.position.z>b.z);for(let i=0;i<9;i++){const f=i/9,y=pose.position.y*(1-f)+b.y*f,z=pose.position.z*(1-f)+b.z*f;assert.ok(y>(z>-10?12:0));}assert.equal(pose.target.z,b.z);});
test('camera smoothing is independent of display refresh rate',()=>{let a=0,b=0;for(let i=0;i<60;i++)a+=(1-a)*smoothFactor(1/60);for(let i=0;i<120;i++)b+=(1-b)*smoothFactor(1/120);assert.ok(Math.abs(a-b)<1e-12);});
