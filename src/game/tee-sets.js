// Tee sets per hole. A hole's teeing areas are the mapped tee polygons lying along its opening leg (behind or a little
// ahead of the route start, near the line, and closer to this hole than to any other hole's route). Colours by count:
// 1 box: white; 2: furthest blue, closest white; 3+: furthest blue, middle white, closest red. White is the tee played
// by default; its teeing point (where the hole axis crosses the box) sets the ball, the yardage and the scorecard.
export const TEE_COLORS={blue:'#1f4fc6',white:'#efefe9',red:'#c52a1f'};
const YARD=.9144;
function inside([x,z],pts){let c=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const [xi,zi]=pts[i],[xj,zj]=pts[j];if((zi>z)!==(zj>z)&&x<(xj-xi)*(z-zi)/(zj-zi)+xi)c=!c;}return c;}
function segDist(p,a,b){const dx=b.x-a.x,dz=b.z-a.z,l=dx*dx+dz*dz||1,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/l));return Math.hypot(p.x-a.x-dx*t,p.z-a.z-dz*t);}
function polyDist(p,route){let d=Infinity;for(let i=1;i<route.length;i++)d=Math.min(d,segDist(p,route[i-1],route[i]));return d;}
const routeRest=route=>route.slice(2).reduce((s,p,i)=>s+Math.hypot(p.x-route[i+1].x,p.z-route[i+1].z),0);
// tees: [{id, points:[[x,z]...]}] in the same local frame as route/otherRoutes ([{x,z}...])
export function teeSets(tees,route,otherRoutes=[]){
 if(!route?.[1])return [];
 const o=route[0],r1=route[1],leg=Math.hypot(r1.x-o.x,r1.z-o.z)||1,dx=(r1.x-o.x)/leg,dz=(r1.z-o.z)/leg,rest=routeRest(route);
 const back={x:o.x-dx*140,z:o.z-dz*140};
 const sets=[];
 for(const f of tees){if(!f.points?.length)continue;const n=f.points.length,c={x:f.points.reduce((s,p)=>s+p[0],0)/n,z:f.points.reduce((s,p)=>s+p[1],0)/n};
  const along=(c.x-o.x)*dx+(c.z-o.z)*dz,lat=Math.abs(-(c.x-o.x)*dz+(c.z-o.z)*dx);
  if(along<-140||along>Math.min(150,leg*.6)||lat>22+Math.max(0,-along)*.08)continue;   // near the centre line (back tees may sit a little wider)
  const mine=segDist(c,back,r1);if(otherRoutes.some(r=>r!==route&&polyDist(c,r)<mine-1))continue;
  let p={x:o.x+dx*along,z:o.z+dz*along};if(!inside([p.x,p.z],f.points))p=c;
  sets.push({id:f.id,feature:f,point:p,along,yards:(Math.hypot(r1.x-p.x,r1.z-p.z)+rest)/YARD});}
 sets.sort((a,b)=>b.yards-a.yards);
 const n=sets.length,names=n===1?['white']:n===2?['blue','white']:null;
 sets.forEach((s,i)=>{s.color=names?names[i]:i===0?'blue':i===n-1?'red':i===Math.floor((n-1)/2)?'white':null;});
 return sets;}
export function whiteTee(sets,route){return sets.find(s=>s.color==='white')||{color:'white',point:{...route[0]},yards:(Math.hypot(route[1].x-route[0].x,route[1].z-route[0].z)+routeRest(route))/YARD,virtual:true};}
// Scorecard yardages for every hole, straight from course data (lon/lat), without building a world.
export function courseTeeYards(course){if(course.__teeYards)return course.__teeYards;const out={};
 for(const h of course.holes||[]){if(!h.route?.[1])continue;const origin=h.route[0],cos=Math.cos(origin[1]*Math.PI/180),L=p=>({x:(p[0]-origin[0])*111320*cos,z:(origin[1]-p[1])*111320});
  const route=h.route.map(L),others=(course.holes||[]).filter(o=>o!==h&&o.route?.length>1).map(o=>o.route.map(L));
  const tees=(course.features||[]).filter(f=>f.kind==='tee'&&f.closed&&f.coords?.length>2).map(f=>({id:f.id,points:f.coords.map(L).map(p=>[p.x,p.z])}));
  const sets=teeSets(tees,route,others),row={};for(const s of sets)if(s.color)row[s.color]=Math.round(s.yards);if(!row.white)row.white=Math.round(whiteTee(sets,route).yards);out[h.number]=row;}
 return course.__teeYards=out;}
