// Green-reading grid (PGA 2K-style, kept subtle): a 1-yard lattice draped over the green 12 mm above the surface, oriented
// toward the ball. Thin anti-aliased white ribbons, widened in the vertex shader to hold ~2 px at any distance and viewing angle (unlit, blended);
// light pulses travel downhill along every line, faster where it is steeper.
// Heights come from visibleGroundHeight, the same ground the ball and cup sit on. MESH special 'grid'.
import {Mesh,Material,Geometry,f32} from './core/index.js';
import {visibleGroundHeight} from './ground-contact.js';
const S=.9144,LIFT=.012,STEP=.15;
export function createPuttGrid(world,geometry,ball){
 const green=world.green||world.features.find(f=>f.kind==='green'&&f.closed&&f.points.some(()=>true));if(!green||!world.pin)return null;
 const pin=world.pin,H=(x,z)=>visibleGroundHeight(geometry,x,z),onG=(x,z)=>world.surface(x,z)==='green'||world.surface(x,z)==='fringe';
 const ang=Math.atan2(ball.z-pin.z,ball.x-pin.x),ax=[Math.cos(ang),Math.sin(ang)],ay=[-ax[1],ax[0]];
 let R=0;for(const [x,z] of green.points)R=Math.max(R,Math.hypot(x-pin.x,z-pin.z));R+=1;
 const P=[],N=[],U=[],C=[],I=[];   // ribbons: both edge vertices at the centre line, pushed apart in the vertex shader by N
 const grad=(x,z)=>{const e=.25;return [(H(x+e,z)-H(x-e,z))/(2*e),(H(x,z+e)-H(x,z-e))/(2*e)];};
 for(const [dir,nrm] of [[ax,ay],[ay,ax]])for(let k=-Math.ceil(R/S);k<=Math.ceil(R/S);k++){
  let run=[];let flow=0;
  const flush=()=>{if(run.length>1){const base=P.length/3;for(const r of run){P.push(r.x,r.y,r.z,r.x,r.y,r.z);N.push(nrm[0],0,nrm[1],-nrm[0],0,-nrm[1]);U.push(r.s,1,r.s,-1);C.push(...r.c,r.g,...r.c,r.g);}
    for(let i=0;i<run.length-1;i++){const a=base+i*2;I.push(a,a+1,a+2,a+1,a+3,a+2);}}run=[];};
  for(let t=-R;t<=R;t+=STEP){const x=pin.x+dir[0]*t+nrm[0]*(k+.5)*S,z=pin.z+dir[1]*t+nrm[1]*(k+.5)*S;   // lines half a cell off the pin: the cup sits in the middle of a square
   if(!onG(x,z)){flush();continue;}
   const [gx,gz]=grad(x,z),slope=Math.hypot(gx,gz),along=-(gx*dir[0]+gz*dir[1]);flow+=STEP*Math.sign(along||1e-6)*Math.min(1,Math.abs(along)/.004+.15);
   run.push({x,y:H(x,z)+LIFT,z,s:flow,c:[1,1,1],g:Math.min(1,slope*28)});}   /* all white; the slope reads through the pulse speed */
  flush();}
 const geo=new Geometry();geo.setAttribute('position',f32(P,3));geo.setAttribute('normal',f32(N,3));geo.setAttribute('uv',f32(U,2));geo.setAttribute('color',f32(C,4));geo.setIndex(I);
 const mat=new Material({kind:'unlit',color:'#ffffff',transparent:true,opacity:0,vertexColors:true,special:'grid',depthWrite:false});
 const m=new Mesh(geo,mat);m.castShadow=false;m.visible=false;m.userData.key=[pin.x,pin.z,ang.toFixed(2)].join('|');return m;}
