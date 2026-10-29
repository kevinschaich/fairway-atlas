import {BUDGET} from './gpu/budget.js';
// Heights on the rendered course ground mesh (the triangulated heightfield that the engine bakes its height map from),
// so the ball, markers, flag and tracer sit exactly on the drawn surface.
const cellIndex=(a,v)=>{let l=0,r=a.length-1;while(l<r){const m=(l+r+1)>>1;if(a[m]<=v)l=m;else r=m-1;}return Math.min(l,a.length-2)};
// Cubic uniform B-spline weights: the GPU draws the ground as a B-spline over the baked height map (shaders-common
// groundH0) and the relief map (reliefAt), not as the raw triangles, so the CPU must reconstruct the same surface or the
// ball, club and markers float above crests and sink into hollows by up to a few centimetres.
export const bspline=f=>[(1-f)**3/6,(4-6*f*f+3*f**3)/6,(1+3*f+3*f*f-3*f**3)/6,f**3/6];
export function splineGrid(N,box,texel,x,z){const tx=(x-box.x)/box.size*N-.5,tz=(z-box.z)/box.size*N-.5,i=Math.floor(tx),j=Math.floor(tz),wx=bspline(tx-i),wz=bspline(tz-j),m=N-1;
 let h=0;for(let b=0;b<4;b++){const jj=Math.min(m,Math.max(0,j+b-1));let r=0;for(let a=0;a<4;a++)r+=wx[a]*texel(Math.min(m,Math.max(0,i+a-1)),jj);h+=wz[b]*r;}return h;}
// Height map texels are the mesh sampled at texel centres (what the GPU rasterises in bakeHeight); cached per geometry.
function bakedHeight(geometry,x,z){const bake=geometry.userData.bake;if(!bake)return meshHeight(geometry,x,z);const {N,box}=bake,cache=bake.cache??=new Map();
 return splineGrid(N,box,(i,j)=>{const k=j*N+i;let v=cache.get(k);if(v===undefined){v=meshHeight(geometry,box.x+(i+.5)/N*box.size,box.z+(j+.5)/N*box.size);if(cache.size>BUDGET.groundCache)cache.clear();cache.set(k,v);}return v;},x,z);}
export function meshHeight(geometry,x,z){
 const {xs,zs}=geometry.userData.grid,p=geometry.attributes.position,ix=cellIndex(xs,x),iz=cellIndex(zs,z),i=iz*xs.length+ix,u=(x-xs[ix])/(xs[ix+1]-xs[ix]),v=(z-zs[iz])/(zs[iz+1]-zs[iz]);
 return u+v<=1?p.getY(i)*(1-u-v)+p.getY(i+1)*u+p.getY(i+xs.length)*v:p.getY(i+xs.length+1)*(u+v-1)+p.getY(i+1)*(1-v)+p.getY(i+xs.length)*(1-u);
}
export function visibleGroundHeight(geometry,x,z){
 const h=bakedHeight(geometry,x,z);
 // + the GPU course micro-relief (maps.js courseRelief, read back by backend.readRelief): the drawn ground is mesh + relief,
 // so everything seated on it (ball, cup, flag, tee markers, divots, tracer) must include it too
 // - the bunker floor: new-engine sand is drawn as its own bowl below the turf (lip.js bunkerGeometry), so balls, marks and
 // physics must sit on that sand, not on the turf level above it
 const rel=geometry.userData.relief,sand=geometry.userData.sandSurface?.(x,z);return sand??h+(rel?rel(x,z):0);
}
// the drawn ground without the sand floor (course mesh + relief): what the sand bowl is dug out of
export function turfHeight(geometry,x,z){const s=geometry.userData.sandSurface;geometry.userData.sandSurface=null;try{return visibleGroundHeight(geometry,x,z);}finally{geometry.userData.sandSurface=s;}}
// sand-floor depth below the turf, d metres inside the bunker outline: 2 in at the lip, then a rounded bowl 28 cm deeper over
// 1.6 m (identical to the GPU sand ribbon in gpu/lip.js and the MESH vertex shader)
export const SAND_DROP=d=>.0508+.28*(1-(1-Math.min(Math.max(d,0)/1.6,1))**2);
// mown heights of cut (m) by surface: the ball sits on top of the sward
export const CUTS={green:{height:.004},tee:{height:.014},fairway:{height:.023},rough:{height:.07}};
// sand-floor depth below the turf at a given distance inside a bunker edge (m)
export const BUNKER_SINK=a=>.03+.25*Math.min(1,Math.max(0,a/2.5))**2*(3-2*Math.min(1,Math.max(0,a/2.5)));
import {BALL_RADIUS} from './ball-physics.js';
export function ballSurfaceY(geometry,x,z){const h=visibleGroundHeight(geometry,x,z),e=.015,dx=(visibleGroundHeight(geometry,x+e,z)-visibleGroundHeight(geometry,x-e,z))/(2*e),dz=(visibleGroundHeight(geometry,x,z+e)-visibleGroundHeight(geometry,x,z-e))/(2*e);return h+BALL_RADIUS*Math.sqrt(1+dx*dx+dz*dz)+.0015;}
export function markerY(world,geometry,x,z){return visibleGroundHeight(geometry,x,z)+(CUTS[world.surface(x,z)]?.height||0)*1.05+.012;}
export function visualBallY(world,geometry,p){if(p.phase==='holed'||p.phase==='rim'||p.phase?.startsWith('cup ')||(world.pin&&Math.hypot(p.x-world.pin.x,p.z-world.pin.z)<.09))return p.y+(world.pin?visibleGroundHeight(geometry,world.pin.x,world.pin.z)-world.elevation(world.pin.x,world.pin.z):0);const rest=ballSurfaceY(geometry,p.x,p.z)-(p.depth||0);return ['roll','skid','rest','plugged'].includes(p.phase)||p.depth?rest:Math.max(p.y,rest);}
export function groundAimPoints(world,geometry,ball,angle,length){const count=Math.ceil(length/.2),points=[];for(let i=0;i<=count;i++){const x=ball.x+Math.sin(angle)*length*i/count,z=ball.z-Math.cos(angle)*length*i/count;points.push({x,y:markerY(world,geometry,x,z),z});}return points;}
