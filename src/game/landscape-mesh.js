import {Geometry,f32} from './core/index.js';

// Keep source elevations unchanged. Spend vertices around the current hole and
// use wider cells for the rest of the course, so a lie view has real surroundings.
export function courseGroundGeometry(world,box,overview){
 const makeAxis=(start,end,nearStart,nearEnd)=>{
  const step=overview?(end-start)/220:Math.max(.5,Math.min(2.5,world.terrainSpacing||1.2)),values=[start];
  let p=start;while(p<end){const fine=overview||p>=nearStart-25&&p<=nearEnd+25;let next=Math.min(end,p+(fine?step:18));if(!overview&&p<nearStart-25&&next>nearStart-25)next=nearStart-25;values.push(next);p=next;}return values;
 };
 const b=world.bbox,xs=makeAxis(box.x,box.x+box.size,b.minX,b.maxX),zs=makeAxis(box.z,box.z+box.size,b.minZ,b.maxZ),positions=[],uv=[],indices=[];
 for(const z of zs)for(const x of xs){positions.push(x,world.elevation(x,z),z);uv.push((x-box.x)/box.size,1-(z-box.z)/box.size)}
 for(let z=0;z<zs.length-1;z++)for(let x=0;x<xs.length-1;x++){const i=z*xs.length+x;indices.push(i,i+xs.length,i+1,i+1,i+xs.length,i+xs.length+1)}
 const geo=new Geometry();geo.setAttribute('position',f32(positions,3));geo.setAttribute('uv',f32(uv,2));geo.setIndex(indices);geo.computeVertexNormals();geo.userData.grid={xs,zs};return geo;
}
