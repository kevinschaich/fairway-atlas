// Bound inland water to loaded scenery before looking up elevation. Long rivers
// retain a local grade; a remote vertex must never set the whole river to sea level.
export function clipWater(points,box){
 let ring=points;for(const [axis,bound,sign] of [[0,box.x,1],[0,box.x+box.size,-1],[1,box.z,1],[1,box.z+box.size,-1]]){
 const next=[];for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],ai=(a[axis]-bound)*sign>=0,bi=(b[axis]-bound)*sign>=0;if(ai)next.push(a);if(ai!==bi){const t=(bound-a[axis])/(b[axis]-a[axis]);next.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);}}ring=next;if(!ring.length)break;}return ring;
}
export function waterProfile(feature,points,elevation){
 const xs=points.map(p=>p[0]),zs=points.map(p=>p[1]),span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...zs)-Math.min(...zs));
 const river=feature.tags?.water==='river'||['river','riverbank'].includes(feature.tags?.waterway)||span>700;
 const heights=points.map(p=>elevation(...p)).filter(Number.isFinite).sort((a,b)=>a-b);
 const level=heights[Math.floor((heights.length-1)*.25)]+.12;
 return {river,level,height:river?(x,z)=>elevation(x,z)+.12:()=>level};
}
export function gradedTriangles(points,indices,height,maxEdge=24){
 const out=[];function emit(a,b,c,depth=0){const pairs=[[a,b,c],[b,c,a],[c,a,b]].sort((u,v)=>Math.hypot(v[0][0]-v[1][0],v[0][1]-v[1][1])-Math.hypot(u[0][0]-u[1][0],u[0][1]-u[1][1]));const [p,q,r]=pairs[0];if(depth<16&&Math.hypot(p[0]-q[0],p[1]-q[1])>maxEdge){const m=[(p[0]+q[0])/2,(p[1]+q[1])/2];emit(p,m,r,depth+1);emit(m,q,r,depth+1);}else for(const p of [a,b,c])out.push(p[0],height(...p),p[1]);}
 for(let i=0;i<indices.length;i+=3)emit(points[indices[i]],points[indices[i+1]],points[indices[i+2]]);return out;
}
