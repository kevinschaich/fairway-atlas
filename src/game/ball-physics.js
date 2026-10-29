import {PHYSICS_VERSION} from './physics-version.js';
// Deterministic SI simulation. Rendering only samples these calculated states.
import {R,M,G,I,dot,cross,length,scale,add,sub,unit,tangent,clamp,zero} from './physics-math.js';
import {acceleration,integrateFlight,airDensityAt,atmosphere} from './ball-aerodynamics.js';
import {CONTACT,conditions,materialFor,windVector,windAtHeight} from './physics-conditions.js';
import {launchState} from './launch-input.js';
export {acceleration,integrateFlight,airDensityAt,CONTACT};
export const BALL_RADIUS=R,BALL_MASS=M,GRAVITY=G,CUP_RADIUS=.053975,CUP_DEPTH=.1016;
export function groundNormal(world,x,z){const e=.05;return unit({x:-(world.elevation(x+e,z)-world.elevation(x-e,z))/(2*e),y:1,z:-(world.elevation(x,z+e)-world.elevation(x,z-e))/(2*e)});}
export function bounce(v,omega,n,mat){
 const vn=dot(v,n);if(vn>=0)return{v,omega};
 const jn=-(1+mat.e)*vn,arm=scale(n,-R),normalV=add(v,scale(n,jn)),slip=tangent(add(normalV,cross(omega,arm)),n);
 const jt=scale(unit(slip),-Math.min(length(slip)/3.5,mat.mu*jn));
 return{v:add(normalV,jt),omega:add(omega,scale(cross(arm,jt),2.5/(R*R)))};
}
export function surfaceStep(v,omega,n,mat,dt){
 const gravity=tangent({x:0,y:-G,z:0},n),arm=scale(n,-R),slip=tangent(add(v,cross(omega,arm)),n),normalG=G*n.y;
 // Include this step's gravity in slip cancellation; no discontinuous spin reset.
 const predictedSlip=add(slip,scale(gravity,dt)),limit=mat.mu*normalG*dt;
 if(length(predictedSlip)>3.5*limit+1e-9){
  const j=scale(unit(predictedSlip),-limit);
  const skidV=add(add(v,scale(gravity,dt)),j),ss=length(skidV),drag=(mat.plow||0)*ss*ss*dt;
  return{v:scale(skidV,Math.max(0,1-drag/(ss||1))),omega:add(omega,scale(cross(arm,j),2.5/(R*R))),phase:'skid'};
 }
 const j=scale(predictedSlip,-1/3.5),rollingV=add(add(v,scale(gravity,dt)),j),speed=length(rollingV),resistance=mat.roll*n.y+(mat.plow||0)*speed*speed;
 if(speed<=resistance*dt&&length(scale(gravity,5/7))<=resistance)return{v:zero(),omega:zero(),phase:'rest'};
 const next=scale(rollingV,Math.max(0,1-resistance*dt/(speed||1)));
 const normalSpin=scale(n,dot(omega,n)*Math.exp(-dt*8));
 return{v:next,omega:add(scale(cross(n,next),1/R),normalSpin),phase:'roll'};
}
// Cup geometry is defined in the local tangent plane. The ball collides with
// the circular turf lip, inner cylinder and floor; there is no capture-speed gate.
export function cupFrame(world){const center={...world.pin,y:world.elevation(world.pin.x,world.pin.z)},n=groundNormal(world,center.x,center.z);return{center,n};}
export function cupCoordinates(p,cup){const d=sub(p,cup.center),y=dot(d,cup.n),radial=sub(d,scale(cup.n,y));return{y,radial,r:length(radial)};}
export function cupContact(p,cup){
 const {y,radial,r}=cupCoordinates(p,cup),out=unit(radial);
 if(y>=0){
  if(r>=CUP_RADIUS)return{gap:y-R,n:cup.n,kind:'ground'};
  const dr=CUP_RADIUS-r,d=Math.hypot(dr,y);return{gap:d-R,n:unit(add(scale(out,-dr),scale(cup.n,y))),kind:'rim'};
 }
 // Inside the cup the ball can touch the wall and the floor at once (the corner). Test both and report the deeper one;
 // testing only the wall whenever the ball was within one radius of it let a ball skimming the wall fall straight
 // through the floor, leave the cup region below it, and be snapped back up onto the green by the terrain collision —
 // the "went in, cup sound, popped out" bug.
 const wall=CUP_RADIUS-r-R,floor=y+CUP_DEPTH-R;
 if(wall<floor)return{gap:wall,n:scale(out,-1),kind:'cup wall'};
 return{gap:floor,n:cup.n,kind:'cup floor'};
}
export function impactNormal(v,n,mat){
 // Equivalent crater normal (Penner 2002): the ball rebounds as if from a rigid plane tilted back against its travel.
 // Penner's tilt, 15.4°·(v/18.6 m/s)·(θi/44.4°), was fitted to Haake's approach shots on greens (~18 m/s, ~45°) and
 // grows linearly with speed and with incidence from the vertical, so a fast, shallow driver landing (30 m/s at 15–25°
 // above the ground) extrapolated to the 45° cap: the ball met a near-vertical "wall", lost ~80% of its forward speed
 // and was thrown straight up. Refitted against measured bounces on natural turf (Biber et al. 2023, arXiv 2302.02758,
 // campaign B: 2–39 m/s, 16–90°, −3.9k to 16k rpm) the tilt tracks the tangential sliding speed and saturates:
 // θc = min(0.40 rad, 0.0207 s/m·|vt|) (0.0207 also reproduces Penner's 15.4° at Haake's green reference impact, 13.0 m/s tangential). RMS error vs that data fell from 3.9 to 1.4 (m/s, m/s, krpm/√2 combined).
 // Low-speed putts remain on the geometric surface.
 const vt=tangent(v,n),vn=Math.max(0,-dot(v,n)),softness=mat.deformation?1+(mat.deformation-.12):0;
 const blend=clamp((vn-1)/2,0,1);
 const angle=Math.min(.40,.0207*length(vt))*softness*blend;
 return unit(sub(scale(n,Math.cos(angle)),scale(unit(vt),Math.sin(angle))));
}
// Soft media (rough, sand): the ball digs a crater of depth d with ½m·vn² = πRP·d²
// (spherical-cap contact area 2πRd against dynamic bearing pressure P). The work
// done is not returned, so restitution scales with the unburied fraction, and the
// embedded cap must plough its frontal segment through the medium for the contact
// time τ ≈ πd/(2vn), removing Δvt = P·A_front·τ/m of tangential speed. Beyond the
// medium's plug depth the ball stays embedded.
export function craterDepth(vn,mat){return mat.bearing&&vn>0?vn*Math.sqrt(M/(2*Math.PI*R*mat.bearing)):0;}
export function softImpact(v,omega,n,mat){
 const vn=Math.max(0,-dot(v,n)),d=craterDepth(vn,mat);
 if(!d)return{...bounce(v,omega,n,mat),depth:0,plugged:false};
 const f=Math.min(1,d/R);
 if(f>=(mat.plug??2))return{v:zero(),omega:zero(),depth:Math.min(d,2*R),plugged:true};
 const hit=bounce(v,omega,n,{...mat,e:mat.e*(1-f)}),h=Math.min(d,R),front=R*R*Math.acos((R-h)/R)-(R-h)*Math.sqrt(Math.max(0,2*R*h-h*h));
 const dv=mat.bearing*front/M*(Math.PI*d/(2*Math.max(vn,.1))),vt=tangent(hit.v,n),st=length(vt),keep=st>1e-9?Math.max(0,st-dv)/st:0;
 return{v:add(scale(n,dot(hit.v,n)),scale(vt,keep)),omega:scale(hit.omega,(1-f)*keep),depth:d,plugged:false};
}
export function turfBounce(v,omega,n,surface,c){
 const initial=materialFor(surface,c,-dot(v,n)),contactNormal=impactNormal(v,n,initial);
 return bounce(v,omega,contactNormal,materialFor(surface,c,-dot(v,contactNormal)));
}
export function flight(world,input,club,lieFactor){
 const baseDt=clamp(input.timeStep??1/240,1/2000,1/60),c=conditions({...world.physicsConditions,...input.conditions}),start={...input.ball},launch=launchState(input,club,lieFactor,c.dampness),putting=club.type==='putter';
 let p={x:start.x,y:world.elevation(start.x,start.z)+R,z:start.z},v=launch.v,omega=launch.omega;
 if(putting&&input.puttRollRatio!=null&&!input.launchData){v={x:Math.sin(input.aim*Math.PI/180)*club.speed*input.power/100,y:0,z:-Math.cos(input.aim*Math.PI/180)*club.speed*input.power/100};omega=scale(cross(groundNormal(world,p.x,p.z),v),input.puttRollRatio/R);}
 const wind10=input.wind||windVector(c),air=atmosphere(p.y,c.temperature,c.humidity),rho=input.airDensity??air.density,cup=cupFrame(world),cupEnabled=world.surface(cup.center.x,cup.center.z)==='green';
 let plugged=false,lieDepth=0,airborne=dot(v,groundNormal(world,p.x,p.z))>.02,t=0,carry=0,flightTime=0,apex=p.y,travel=0,phase=airborne?'flight':'skid',outcome='rest',holed=false,landed=false,nextSample=0,steps=0;
 const path=[],contacts=[],lastSafe={...start};
 const record=()=>{const s={...p,t,phase,vx:v.x,vy:v.y,vz:v.z,wx:omega.x,wy:omega.y,wz:omega.z};if(path.length&&Math.abs(path.at(-1).t-t)<1e-9)path[path.length-1]=s;else path.push(s);};record();
 const contact=(normal,mat,kind)=>{if(!landed){carry=Math.hypot(p.x-start.x,p.z-start.z);flightTime=t;landed=true;}const before={...v},spinBefore={...omega},hit=kind==='ground'&&mat.bearing?softImpact(v,omega,normal,mat):bounce(v,omega,normal,mat);v=hit.v;omega=hit.omega;if(hit.plugged){plugged=true;lieDepth=hit.depth;}contacts.push({t,...p,kind,depth:hit.depth||0,plugged:!!hit.plugged,surface:world.surface(p.x,p.z),normal:{...normal},groundNormal:groundNormal(world,p.x,p.z),speedBefore:length(before),speedAfter:length(v),velocityBefore:before,velocityAfter:{...v},spinBefore,spinAfter:{...omega}});phase=kind==='ground'?'bounce':kind;record();};
 while(t<60&&steps++<160000){
  const local=cupCoordinates(p,cup),nearCup=cupEnabled&&local.r<.25&&local.y<.3&&local.y>-.2;
  const dt=nearCup?Math.min(baseDt,1/2000,.001/(length(v)+.001)):baseDt,previous={...p},oldV={...v};
  const wind=windAtHeight(wind10,p.y-R-world.elevation(p.x,p.z));
  if(nearCup){
   // Gravity acts while spanning the opening. Tiny local steps resolve mm lips.
   const state=integrateFlight(p,v,omega,wind,rho,dt,air.viscosity);p=state.p;v=state.v;omega=state.omega;t+=dt;
   const hit=cupContact(p,cup),q=cupCoordinates(p,cup);
   if(hit.gap<0){
    p=add(p,scale(hit.n,-hit.gap+1e-8));
    const closing=-dot(v,hit.n);
    if(closing>.06){contact(hit.n,hit.kind==='ground'?materialFor('green',c,closing):{e:hit.kind==='cup floor'?.15:.65,mu:.20},hit.kind);}
    else {v=tangent(v,hit.n);const s=surfaceStep(v,omega,hit.n,materialFor('green',c),dt);v=s.v;omega=s.omega;phase=hit.kind==='ground'?s.phase:hit.kind;}
    if(hit.kind==='cup floor'&&length(v)<.18){holed=true;outcome='holed';phase='holed';record();break;}
   }else phase=q.y<R?'cup flight':'flight';
   airborne=true;
  }else if(airborne){
   const next=integrateFlight(p,v,omega,wind,rho,dt,air.viscosity),gap=q=>q.y-world.elevation(q.x,q.z)-R;
   if(gap(next.p)<=0){
    let lo=0,hi=dt;for(let j=0;j<14;j++){const mid=(lo+hi)/2;if(gap(integrateFlight(p,v,omega,wind,rho,mid,air.viscosity).p)>0)lo=mid;else hi=mid;}
    const impactDt=Math.max(hi,1e-7),s=integrateFlight(p,v,omega,wind,rho,impactDt,air.viscosity);p=s.p;v=s.v;omega=s.omega;t+=impactDt;p.y=world.elevation(p.x,p.z)+R;
    if(!landed){carry=Math.hypot(p.x-start.x,p.z-start.z);flightTime=t;landed=true;}
    const n=groundNormal(world,p.x,p.z),surface=world.surface(p.x,p.z),m0=materialFor(surface,c,-dot(v,n)),contactN=m0.bearing?n:impactNormal(v,n,m0);   /* soft media: the crater is modelled explicitly (softImpact), not as a tilted normal */contact(contactN,materialFor(surface,c,-dot(v,contactN)),'ground');
    if(plugged){phase='plugged';record();break;}
    /* in rough/sand a low rebound stays in the grass/sand (and keeps being ploughed) instead of skipping over it */if(dot(v,n)<(m0.bearing?1.2:.12)){airborne=false;v=tangent(v,n);phase='skid';}
   }else{p=next.p;v=next.v;omega=next.omega;t+=dt;phase='flight';}
  }else{
   const n=groundNormal(world,p.x,p.z),s=surfaceStep(v,omega,n,materialFor(world.surface(p.x,p.z),c),dt);v=s.v;omega=s.omega;phase=s.phase;
   p=add(p,scale(add(oldV,v),dt/2));t+=dt;
   const h=world.elevation(p.x,p.z)+R,nn=groundNormal(world,p.x,p.z);
   if(h<p.y-.015){airborne=true;phase='flight';}else{p.y=h;v=tangent(v,nn);}
   if(phase==='rest'){if(world.surface(p.x,p.z)==='water')outcome='water';record();break;}
  }
  if(p.y<=world.elevation(p.x,p.z)+R+.01){const surface=world.surface(p.x,p.z);if(surface==='water'){outcome='water';break;}if(!world.inside(p)){outcome='out of bounds';break;}lastSafe.x=p.x;lastSafe.z=p.z;}
  travel+=Math.hypot(p.x-previous.x,p.z-previous.z);apex=Math.max(apex,p.y);
  // Fine sampling wherever the path bends sharply: coming in to land (descending within a few
  // metres of the ground), every bounce/roll-out, and around the cup. 60 Hz is plenty for the
  // smooth middle of a flight.
  if(t>=nextSample){record();const gapNow=p.y-world.elevation(p.x,p.z)-R,landing=airborne?(v.y<0&&gapNow<Math.max(3,-v.y*.35)):length(v)>.4;nextSample=t+(nearCup||landing?1/240:1/60);}
  if(Math.hypot(p.x-start.x,p.z-start.z)>1000){outcome='out of bounds';break;}
  if(nearCup&&length(v)<.001&&local.r>CUP_RADIUS){phase='rest';break;}
 }
 if(t>=60||steps>=160000)outcome='simulation limit';
 if(!plugged&&!holed){const m=CONTACT[world.surface(p.x,p.z)];lieDepth=m?.rest?m.rest*R:0;}
 phase=holed?'holed':plugged?'plugged':outcome;record();path.at(-1).depth=lieDepth;
 return{modelVersion:PHYSICS_VERSION,end:{x:p.x,z:p.z,...(lieDepth?{depth:lieDepth}:{})},plugged,path,outcome,holed,carry:putting?0:carry,total:Math.hypot(p.x-start.x,p.z-start.z),flightTime,duration:t,apex:apex-path[0].y,roll:Math.max(0,travel-carry),contacts,airDensity:rho,conditions:c,stats:launch.stats,input:structuredClone(input),lastSafe,solver:{steps,baseHz:1/baseDt,cupHz:2000}};
}
