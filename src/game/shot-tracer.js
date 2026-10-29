import {Vec2,Vec3,Color,CatmullRom3,Geometry,f32,Mesh,Material} from './core/index.js';
import {markerY,visualBallY} from './ground-contact.js';
import {BALL_RADIUS} from './ball-physics.js';
// Glowing tube tracer. The flight path is resampled along a centripetal spline so it is
// smooth in the air and on the ground (roll heights are low-passed but never dip under the
// turf marker). Each ring stores its centre + outward normal; the vertex shader inflates the
// tube to a minimum on-screen width so it reads at any distance. Revealed by physical time.
const RAD=12;
export function createTracer(path,world,ground){
 // 1. centreline = the physics path itself (sampled at 60-240 Hz, smooth in the air).
 const pts=[];
 for(let i=0;i<path.length;i++){const p=path[i],onGround=!!(world&&p.y-world.elevation(p.x,p.z)<BALL_RADIUS+.03);
  const last=pts.at(-1);if(last&&Math.hypot(p.x-last.x,p.y-last.y,p.z-last.z)<.01)continue;
  pts.push({x:p.x,y:p.y,z:p.z,t:p.t,g:onGround});}
 if(pts.length<2)pts.push({...pts[0],x:pts[0].x+.001});
 // 2. dense arc-length resample (~3 cm) along a centripetal spline; times interpolated.
 const curve=new CatmullRom3(pts.map(p=>new Vec3(p.x,p.y,p.z)));
 curve.arcLengthDivisions=Math.min(20000,pts.length*16);
 const cum=[0];for(let i=1;i<pts.length;i++)cum.push(cum[i-1]+Math.hypot(pts[i].x-pts[i-1].x,pts[i].y-pts[i-1].y,pts[i].z-pts[i-1].z));const total=cum.at(-1)||1;
 const n=Math.max(2,Math.min(12000,Math.ceil(total/.03)));
 const S=[];let k=1;for(let i=0;i<=n;i++){const u=i/n,d=u*total;while(k<cum.length-1&&cum[k]<d)k++;const a=pts[k-1],b=pts[k],f=(d-cum[k-1])/Math.max(1e-6,cum[k]-cum[k-1]);S.push({p:curve.getPointAt(u),t:a.t+(b.t-a.t)*f,g:f<.5?a.g:b.g})}
 // 3. rolling height comes from bilinear DEM cells: blur it so cell edges don't read as kinks.
 for(let pass=0;pass<16;pass++){const ys=S.map(s=>s.p.y);for(let i=1;i<S.length-1;i++)if(S[i].g&&S[i-1].g&&S[i+1].g)S[i].p.y=(ys[i-1]+2*ys[i]+ys[i+1])/4}
 //    Lift onto the *rendered* turf with one smooth offset along the whole path (no per-point
 //    clamp, which is what traced the flat triangles of the ground mesh).
 if(ground&&world){const need=S.map(s=>Math.max(0,markerY(world,ground,s.p.x,s.p.z)+BALL_RADIUS*.5-s.p.y)),W=40,env=new Float32Array(S.length);
  for(let i=0;i<S.length;i++){let m=0;for(let j=Math.max(0,i-W);j<=Math.min(S.length-1,i+W);j++)m=Math.max(m,need[j]);env[i]=m}
  for(let pass=0;pass<10;pass++){const c=env.slice();for(let i=1;i<env.length-1;i++)env[i]=(c[i-1]+2*c[i]+c[i+1])/4}
  S.forEach((s,i)=>{const h=s.p.y-world.elevation(s.p.x,s.p.z)-BALL_RADIUS,w=Math.max(0,Math.min(1,1-h/3));s.p.y+=env[i]*w})}
 // 4. camera-facing ribbon. Direction is averaged over ±0.35 m so bounces curve instead of
 //    folding the glow; the ribbon is widened in screen space in the vertex shader.
 const arc=[0];for(let i=1;i<S.length;i++)arc.push(arc[i-1]+S[i].p.distanceTo(S[i-1].p));
 const K=12,pos=[],tan=[],side=[],dst=[],born=[],gr=[],idx=[];
 for(let i=0;i<S.length;i++){const a=S[Math.max(0,i-K)].p,b=S[Math.min(S.length-1,i+K)].p,T=new Vec3().subVectors(b,a);if(!T.lengthSq())T.set(0,0,1);T.normalize();
  for(const sd of[-1,1]){pos.push(S[i].p.x,S[i].p.y,S[i].p.z);tan.push(T.x,T.y,T.z);side.push(sd);dst.push(arc[i]);born.push(S[i].t);gr.push(S[i].g?1:0)}
  if(i<S.length-1){const k=i*2;idx.push(k,k+1,k+2,k+1,k+3,k+2)}}
 const geo=new Geometry();geo.setAttribute('position',f32(pos,3));geo.setAttribute('ribbonTangent',f32(tan,3));geo.setAttribute('side',f32(side,1));geo.setAttribute('arcDist',f32(dst,1));geo.setAttribute('sampleTime',f32(born,1));geo.setAttribute('grounded',f32(gr,1));geo.setIndex(idx);
 // Drawn by the engine's tracer pass (gpu/shaders.js TRACER): screen-space widened ribbon, white-hot core + neon glow,
 // premultiplied "light" blend, revealed up to headDist (the ball's arc position at the elapsed physical time).
 const mat=new Material({kind:'tracer',transparent:true,uniforms:{elapsed:{value:0},viewport:{value:new Vec2(1000,800)},fade:{value:1},glow:{value:new Color('#c2ec78')},headDist:{value:1e9}}});
 const times=S.map(s=>s.t);
 const mesh=new Mesh(geo,mat);
 mesh.userData.update=()=>{const t=mat.uniforms.elapsed.value;let lo=0,hi=times.length-1;if(t>=times[hi]){mat.uniforms.headDist.value=arc[hi];return}while(lo<hi){const m=(lo+hi)>>1;if(times[m]<t)lo=m+1;else hi=m}const a=Math.max(0,lo-1),f=(t-times[a])/Math.max(1e-6,times[lo]-times[a]);mat.uniforms.headDist.value=arc[a]+(arc[lo]-arc[a])*Math.min(1,Math.max(0,f));};mesh.frustumCulled=false;return mesh;
}
