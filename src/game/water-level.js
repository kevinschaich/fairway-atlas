import {clipWater,waterProfile} from './water-geometry.js';
// Resting water level (m) that the engine's ocean and the ground's "under water" test use: sea level for coastal courses,
// otherwise the level of the most prominent pond/lake near the tee (largest, closest). undefined when the course has no water.
export function waterLevel(world,box){
 if(!world.features.some(f=>f.kind==='water'&&f.closed))return undefined;
 if(world.features.some(f=>String(f.id).startsWith('coast-water')))return .65;
 let best=null,score=-1;
 for(const f of world.features){if(f.kind!=='water'||!f.closed||String(f.id).startsWith('coast-water'))continue;const points=clipWater(f.points,box);if(points.length<3)continue;
  const profile=waterProfile(f,points,world.elevation),cx=points.reduce((s,p)=>s+p[0],0)/points.length,cz=points.reduce((s,p)=>s+p[1],0)/points.length;
  const s=Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1]},0))/Math.pow(1+Math.hypot(cx-world.tee.x,cz-world.tee.z)/300,2);
  if(s>score){score=s;best=profile.level;}}
 return best??undefined;
}
