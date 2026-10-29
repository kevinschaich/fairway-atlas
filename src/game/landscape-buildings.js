import {Geometry,f32,Mesh,Material,triangulateShape} from './core/index.js';
// OSM building footprints, extruded to their tagged (or inferred) height. Walls and roofs are merged per 256 m cell into
// one mesh each (the engine's building shading adds the facade detail: stucco tones, window bands, contact darkening).
export function buildingHeight(tags={}){
 const value=String(tags.height||''),number=parseFloat(value),unit=/ft|feet|'/.test(value)? .3048:1;
 return Math.min(45,Math.max(2.5,Number.isFinite(number)?number*unit:Number(tags['building:levels'])*3.2||4.6));
}
export function addBuildings(owner){
 const w=owner.world,box=owner.terrainBox,cells=new Map();
 const cell=(x,z)=>{const k=Math.floor(x/256)+':'+Math.floor(z/256);let c=cells.get(k);if(!c)cells.set(k,c={roof:{p:[],n:[]},wall:{p:[],n:[]}});return c;};
 const tri=(o,a,b,c,n)=>{o.p.push(...a,...b,...c);for(let i=0;i<3;i++)o.n.push(...n);};
 const faceN=(a,b,c)=>{const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;const l=Math.hypot(nx,ny,nz)||1;return [nx/l,ny/l,nz/l];};
 for(const f of w.features){if(!['building','clubhouse'].includes(f.kind)||!f.closed||f.points.length<4)continue;
  const x=(f.bounds.minX+f.bounds.maxX)/2,z=(f.bounds.minZ+f.bounds.maxZ)/2;if(x<box.x||x>box.x+box.size||z<box.z||z>box.z+box.size)continue;
  const height=buildingHeight(f.tags),pts=f.points.slice();if(pts[0][0]===pts.at(-1)[0]&&pts[0][1]===pts.at(-1)[1])pts.pop();if(pts.length<3)continue;
  const base=w.elevation(x,z),top=base+height,b=cell(x,z);let area=0;for(let i=0;i<pts.length;i++){const p=pts[i],q=pts[(i+1)%pts.length];area+=p[0]*q[1]-q[0]*p[1];}
  // walls (outward normals from the footprint's winding)
  for(let i=0;i<pts.length;i++){const p=pts[i],q=pts[(i+1)%pts.length],dx=q[0]-p[0],dz=q[1]-p[1],l=Math.hypot(dx,dz)||1,n=area>0?[dz/l,0,-dx/l]:[-dz/l,0,dx/l];
   const a=[p[0],base,p[1]],bb=[q[0],base,q[1]],c=[q[0],top,q[1]],d=[p[0],top,p[1]];tri(b.wall,a,bb,c,n);tri(b.wall,a,c,d,n);}
  const pitched=pts.length===4&&f.tags?.['roof:shape']!=='flat'&&height<12;
  if(!pitched){for(const [i,j,k] of triangulateShape(pts.map(p=>[p[0],p[1]])))tri(b.roof,[pts[i][0],top,pts[i][1]],[pts[j][0],top,pts[j][1]],[pts[k][0],top,pts[k][1]],[0,1,0]);}
  else{const edges=pts.map((p,i)=>Math.hypot(p[0]-pts[(i+1)%4][0],p[1]-pts[(i+1)%4][1]));const s=edges.indexOf(Math.max(...edges)),p=Array.from({length:4},(_,j)=>pts[(s+j)%4]);
   const r0=[(p[0][0]+p[3][0])/2,(p[0][1]+p[3][1])/2],r1=[(p[1][0]+p[2][0])/2,(p[1][1]+p[2][1])/2],rise=Math.min(2.8,Math.min(...edges)*.28);
   const V=[...p.map(q=>[q[0],top,q[1]]),[r0[0],top+rise,r0[1]],[r1[0],top+rise,r1[1]]];
   for(const [i,j,k] of [[0,4,1],[1,4,5],[3,2,4],[2,5,4],[0,3,4],[1,5,2]]){let n=faceN(V[i],V[j],V[k]);if(n[1]<0)n=n.map(v=>-v);tri(b.roof,V[i],V[j],V[k],n);}}
 }
 const roof=new Material({color:'#665f51',roughness:.96}),wall=new Material({color:'#bfb9a8',roughness:.98});
 for(const c of cells.values())for(const [part,mat] of [[c.roof,roof],[c.wall,wall]]){if(!part.p.length)continue;const g=new Geometry();g.setAttribute('position',f32(part.p,3));g.setAttribute('normal',f32(part.n,3));g.computeBoundingSphere();
  const mesh=new Mesh(g,mat);mesh.userData.effect='buildings';owner.group.add(mesh);}
}
