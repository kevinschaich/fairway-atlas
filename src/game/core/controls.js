// Fairway Atlas engine core: orbit controls for the plan / map views.
// Left drag orbits around target, right drag (or shift+left) pans, two fingers pan + pinch zoom. Damped.
import {Vec3,MathUtils} from './math.js';
export class OrbitControls{
 constructor(camera,dom){this.camera=camera;this.dom=dom;this.target=new Vec3();this.enabled=true;this.enableDamping=true;this.dampingFactor=.05;this.enableZoom=true;
  this.minDistance=0;this.maxDistance=Infinity;this.minPolarAngle=0;this.maxPolarAngle=Math.PI;this.rotateSpeed=1;
  this._dTheta=0;this._dPhi=0;this._pan=new Vec3();this._scale=1;this._ptr=new Map();this._mode=null;
  const el=dom;el.style.touchAction='none';
  el.addEventListener('contextmenu',e=>{if(this.enabled)e.preventDefault();});
  el.addEventListener('pointerdown',e=>{if(!this.enabled)return;el.setPointerCapture?.(e.pointerId);this._ptr.set(e.pointerId,{x:e.clientX,y:e.clientY});
   if(e.pointerType==='touch')this._mode=this._ptr.size>=2?'touch2':'rotate';else this._mode=e.button===2||e.shiftKey||e.ctrlKey||e.metaKey?'pan':e.button===0?'rotate':null;this._pinch=this._dist();});
  el.addEventListener('pointermove',e=>{if(!this.enabled||!this._ptr.has(e.pointerId))return;const p=this._ptr.get(e.pointerId),dx=e.clientX-p.x,dy=e.clientY-p.y;const h=el.clientHeight||1;
   if(this._mode==='touch2'){p.x=e.clientX;p.y=e.clientY;const d=this._dist();if(this._pinch&&d)this._scale*=this._pinch/d;this._pinch=d;this.panBy(dx/2,dy/2);return;}
   p.x=e.clientX;p.y=e.clientY;
   if(this._mode==='rotate'){this._dTheta-=2*Math.PI*dx/h*this.rotateSpeed;this._dPhi-=2*Math.PI*dy/h*this.rotateSpeed;}else if(this._mode==='pan')this.panBy(dx,dy);});
  const up=e=>{this._ptr.delete(e.pointerId);if(!this._ptr.size)this._mode=null;else if(this._mode==='touch2')this._mode='rotate';};
  el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);}
 _dist(){const p=[...this._ptr.values()];return p.length>=2?Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y):0;}
 panBy(dx,dy){const c=this.camera,off=new Vec3().subVectors(c.position,this.target),dist=off.length()*Math.tan(MathUtils.degToRad(c.fov/2)),h=this.dom.clientHeight||1;
  c.updateWorldMatrix();const e=c.matrixWorld.elements,x=new Vec3(e[0],e[1],e[2]),y=new Vec3(e[4],e[5],e[6]);
  this._pan.addScaledVector(x,-2*dx*dist/h).addScaledVector(y,2*dy*dist/h);}
 update(){const c=this.camera,off=new Vec3().subVectors(c.position,this.target);let r=off.length(),theta=Math.atan2(off.x,off.z),phi=Math.acos(MathUtils.clamp(off.y/(r||1),-1,1));
  const k=this.enableDamping?this.dampingFactor:1;theta+=this._dTheta*k;phi+=this._dPhi*k;phi=MathUtils.clamp(phi,Math.max(1e-6,this.minPolarAngle),Math.min(Math.PI-1e-6,this.maxPolarAngle));
  r=MathUtils.clamp(r*this._scale,this.minDistance,this.maxDistance);this.target.addScaledVector(this._pan,k);
  const s=Math.sin(phi);c.position.set(this.target.x+r*s*Math.sin(theta),this.target.y+r*Math.cos(phi),this.target.z+r*s*Math.cos(theta));c.lookAt(this.target);
  if(this.enableDamping){this._dTheta*=1-k;this._dPhi*=1-k;this._pan.multiplyScalar(1-k);}else{this._dTheta=this._dPhi=0;this._pan.set(0,0,0);}this._scale=1;return true;}
 dispose(){}
}
