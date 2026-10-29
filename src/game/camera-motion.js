import {Vec3,Quat,Mat4,MathUtils,CatmullRom3} from './core/index.js';
export const ease=t=>{t=Math.max(0,Math.min(1,t));return t*t*t*(t*(t*6-15)+10)};
export function cameraPose(camera){return{position:camera.position.clone(),quaternion:camera.quaternion.clone(),fov:camera.fov,near:camera.near};}
export class CameraMotion{
 constructor(owner){this.owner=owner;this.active=null;}
 cancel(){this.active=null;}
 toCurrent(from,duration=1.25,minLift=0){const c=this.owner.camera;const to=cameraPose(c);let lift=Math.max(minLift,Math.min(12,from.position.distanceTo(to.position)*.06));if(this.owner.world)for(let i=1;i<64;i++){const t=i/64,p=from.position.clone().lerp(to.position,t);lift=Math.max(lift,(this.owner.world.elevation(p.x,p.z)+1-p.y)/Math.sin(Math.PI*t));}this.owner.lookTarget=null;this.owner.lookPosition=null;this.active={from,to,lift,elapsed:0,duration};c.position.copy(from.position);c.quaternion.copy(from.quaternion);c.fov=from.fov;c.near=Math.min(from.near,this.active.to.near);c.updateProjectionMatrix();}
 update(dt){const a=this.active;if(!a)return false;// a hitch (e.g. the heavy view swap on the first frame) advances one nominal frame so the move never skips
 a.elapsed+=dt>.1?1/60:dt;const t=ease(a.elapsed/a.duration),c=this.owner.camera;c.position.lerpVectors(a.from.position,a.to.position,t);c.position.y+=Math.sin(Math.PI*t)*a.lift;if(this.owner.world)c.position.y=Math.max(c.position.y,this.owner.world.elevation(c.position.x,c.position.z)+.5);if(a.focus){// big descents keep the target framed, then settle into the final heading near the end
  const m=new Mat4().lookAt(c.position,a.focus,new Vec3(0,1,0)),look=new Quat().setFromRotationMatrix(m),k=ease(Math.max(0,(t-.55)/.45)),early=ease(Math.min(1,t/.25));const q=a.from.quaternion.clone().slerp(look,early);c.quaternion.copy(q.slerp(a.to.quaternion,k));}else c.quaternion.slerpQuaternions(a.from.quaternion,a.to.quaternion,t);c.fov=MathUtils.lerp(a.from.fov,a.to.fov,t);c.updateProjectionMatrix();if(a.elapsed>=a.duration){c.position.copy(a.to.position);c.quaternion.copy(a.to.quaternion);c.near=a.to.near;c.updateProjectionMatrix();this.active=null;this.owner.freeCamera?.enter();}return true;}
}
export function createDroneFlight(world,start=null,ball=null){
 const route=world.route.map(p=>new Vec3(p.x,0,p.z)),end=route.at(-1),lastHeading=end.clone().sub(route.at(-2)).normalize(),beyond=end.clone().addScaledVector(lastHeading,-Math.min(42,end.distanceTo(route.at(-2))*.6));
 let lead;
 if(start){// begin exactly at the given (play-view) camera and only move forward from the ball
  const b=new Vec3((ball??start).x,0,(ball??start).z),pin=new Vec3(world.pin.x,0,world.pin.z),left=b.distanceTo(pin);
  const ahead=route.slice(1,-1).filter(p=>p.distanceTo(pin)<left-8&&p.distanceTo(b)>8);
  lead=[new Vec3(start.x,0,start.z),b.clone().lerp(ahead[0]??beyond,.12),...ahead];
 }else{const first=route[0],heading=route[1].clone().sub(first).normalize();lead=[first.clone().addScaledVector(heading,-18),...route.slice(0,-1)];}
 const horizontal=new CatmullRom3([...lead,beyond],false,'centripetal'),length=horizontal.getLength(),count=Math.max(24,Math.ceil(length/5)),points=[];
 for(let i=0;i<=count;i++){const u=i/count,p=horizontal.getPointAt(u),dir=horizontal.getTangentAt(u),sweep=Math.sin(Math.PI*u)*Math.sin(Math.PI*u*.9)*5;p.x-=dir.z*sweep;p.z+=dir.x*sweep;p.y=world.elevation(p.x,p.z)+10+Math.sin(Math.PI*u)*10;points.push(p);}
 // Smooth the camera altitude, not the terrain. A wide clearance envelope avoids
 // following each DEM pixel up and down, while retaining hill clearance.
 for(let pass=0;pass<5;pass++){const ys=points.map(p=>p.y);for(let i=1;i<points.length-1;i++)points[i].y=Math.max(world.elevation(points[i].x,points[i].z)+7,(ys[i-1]+ys[i]*2+ys[i+1])/4);}
 const RAMP=.17;
 if(start){points[0].set(start.x,start.y,start.z);for(let i=1;i<points.length;i++){const u=i/count;if(u>=RAMP)break;const k=ease(u/RAMP);points[i].y=MathUtils.lerp(start.y,points[i].y,k);}}
 const curve=new CatmullRom3(points,false,'centripetal');
 return{duration:Math.max(16,Math.min(45,length/10)),sample(progress){const u=ease(progress),position=curve.getPointAt(u);const floor=start&&u<RAMP?MathUtils.lerp(1.2,5,ease(u/RAMP)):5;position.y=Math.max(position.y,world.elevation(position.x,position.z)+floor);const target=greenTarget(world,position,12);return{position,target,fov:MathUtils.lerp(56,46,ease(progress))};}};
}

// Keep the green on the horizontal bearing while limiting pitch for a level drone.
export function greenTarget(world,position,maxPitch=89){
 const pin=world.pin,d=Math.hypot(pin.x-position.x,pin.z-position.z),height=world.elevation(pin.x,pin.z)+.7,limit=Math.tan(maxPitch*Math.PI/180)*d;
 return new Vec3(pin.x,MathUtils.clamp(height,position.y-limit,position.y+limit),pin.z);
}
