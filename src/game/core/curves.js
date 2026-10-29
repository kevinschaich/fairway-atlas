// Fairway Atlas engine core: curves (centripetal Catmull-Rom splines, 2D shape paths).
import {Vec2,Vec3,Mat4,MathUtils} from './math.js';

class Curve{
 constructor(){this.arcLengthDivisions=200;this._lengths=null;}
 getPoints(n=5){const out=[];for(let d=0;d<=n;d++)out.push(this.getPoint(d/n));return out;}
 getLengths(n=this.arcLengthDivisions){if(this._lengths&&this._lengths.length===n+1)return this._lengths;const L=[0];let prev=this.getPoint(0),sum=0;
  for(let p=1;p<=n;p++){const c=this.getPoint(p/n);sum+=c.distanceTo(prev);L.push(sum);prev=c;}return this._lengths=L;}
 getLength(){const L=this.getLengths();return L[L.length-1];}
 // arc-length parameter u -> curve parameter t
 getUtoTmapping(u){const L=this.getLengths(),n=L.length,target=u*L[n-1];let lo=0,hi=n-1;
  while(lo<=hi){const i=Math.floor(lo+(hi-lo)/2),c=L[i]-target;if(c<0)lo=i+1;else if(c>0)hi=i-1;else{hi=i;break;}}
  const i=hi;if(i<0)return 0;if(L[i]===target)return i/(n-1);const a=L[i],b=L[i+1]??a;return (i+(b>a?(target-a)/(b-a):0))/(n-1);}
 getPointAt(u){return this.getPoint(this.getUtoTmapping(u));}
 getTangent(t){const d=1e-4,a=this.getPoint(Math.max(0,t-d)),b=this.getPoint(Math.min(1,t+d));return b.sub(a).normalize();}
 getTangentAt(u){return this.getTangent(this.getUtoTmapping(u));}
 // parallel-transport frames along the curve (for tubes)
 computeFrenetFrames(segments,closed=false){const T=[],N=[],B=[],m=new Mat4();
  for(let i=0;i<=segments;i++)T.push(this.getTangentAt(i/segments));
  let min=Infinity;const t0=T[0],ax=Math.abs(t0.x),ay=Math.abs(t0.y),az=Math.abs(t0.z),axis=new Vec3();
  if(ax<=min){min=ax;axis.set(1,0,0);}if(ay<=min){min=ay;axis.set(0,1,0);}if(az<=min)axis.set(0,0,1);
  const v=new Vec3().crossVectors(t0,axis).normalize();N[0]=new Vec3().crossVectors(t0,v);B[0]=new Vec3().crossVectors(t0,N[0]);
  for(let i=1;i<=segments;i++){N[i]=N[i-1].clone();B[i]=B[i-1].clone();const w=new Vec3().crossVectors(T[i-1],T[i]);
   if(w.length()>Number.EPSILON){w.normalize();const th=Math.acos(MathUtils.clamp(T[i-1].dot(T[i]),-1,1));N[i].applyMatrix4(rotAxis(m,w,th));}
   B[i].crossVectors(T[i],N[i]);}
  if(closed){let th=Math.acos(MathUtils.clamp(N[0].dot(N[segments]),-1,1))/segments;if(T[0].dot(new Vec3().crossVectors(N[0],N[segments]))>0)th=-th;
   for(let i=1;i<=segments;i++){N[i].applyMatrix4(rotAxis(m,T[i],th*i));B[i].crossVectors(T[i],N[i]);}}
  return {tangents:T,normals:N,binormals:B};}
}
function rotAxis(m,a,t){const c=Math.cos(t),s=Math.sin(t),k=1-c,x=a.x,y=a.y,z=a.z,tx=k*x,ty=k*y;
 return m.set(tx*x+c,tx*y-s*z,tx*z+s*y,0,tx*y+s*z,ty*y+c,ty*z-s*x,0,tx*z-s*y,ty*z+s*x,k*z*z+c,0,0,0,0,1);}

const cubic=(x0,x1,t0,t1)=>{const c2=-3*x0+3*x1-2*t0-t1,c3=2*x0-2*x1+t0+t1;return t=>x0+t0*t+c2*t*t+c3*t*t*t;};
const nonUniform=(x0,x1,x2,x3,d0,d1,d2)=>{let t1=(x1-x0)/d0-(x2-x0)/(d0+d1)+(x2-x1)/d1,t2=(x2-x1)/d1-(x3-x1)/(d1+d2)+(x3-x2)/d2;return cubic(x1,x2,t1*d1,t2*d1);};
// Centripetal Catmull-Rom through 3D points (no cusps or self-intersections on uneven spacing)
export class CatmullRom3 extends Curve{
 constructor(points=[],closed=false){super();this.points=points;this.closed=closed;}
 getPoint(t){const P=this.points,l=P.length,p=(l-(this.closed?0:1))*t;let i=Math.floor(p),w=p-i;
  if(this.closed)i+=i>0?0:(Math.floor(Math.abs(i)/l)+1)*l;else if(w===0&&i===l-1){i=l-2;w=1;}
  const p0=this.closed||i>0?P[(i-1+l)%l]:new Vec3().subVectors(P[0],P[1]).add(P[0]),p1=P[i%l],p2=P[(i+1)%l],
   p3=this.closed||i+2<l?P[(i+2)%l]:new Vec3().subVectors(P[l-1],P[l-2]).add(P[l-1]);
  let d0=Math.pow(p0.distanceToSquared(p1),.25),d1=Math.pow(p1.distanceToSquared(p2),.25),d2=Math.pow(p2.distanceToSquared(p3),.25);
  if(d1<1e-4)d1=1;if(d0<1e-4)d0=d1;if(d2<1e-4)d2=d1;
  return new Vec3(nonUniform(p0.x,p1.x,p2.x,p3.x,d0,d1,d2)(w),nonUniform(p0.y,p1.y,p2.y,p3.y,d0,d1,d2)(w),nonUniform(p0.z,p1.z,p2.z,p3.z,d0,d1,d2)(w));}
}

// ---- 2D paths ------------------------------------------------------------------------------
class Seg2{constructor(kind,fn){this.kind=kind;this.getPoint=fn;}}
const bez3=(t,p0,p1,p2,p3)=>{const k=1-t;return k*k*k*p0+3*k*k*t*p1+3*k*t*t*p2+t*t*t*p3;};
const bez2=(t,p0,p1,p2)=>{const k=1-t;return k*k*p0+2*k*t*p1+t*t*p2;};
export class Path{
 constructor(points){this.curves=[];this.current=new Vec2();this.autoClose=false;if(points)this.setFromPoints(points);}
 setFromPoints(pts){this.moveTo(pts[0].x??pts[0][0],pts[0].y??pts[0][1]);for(let i=1;i<pts.length;i++)this.lineTo(pts[i].x??pts[i][0],pts[i].y??pts[i][1]);return this;}
 moveTo(x,y){this.current.set(x,y);return this;}
 lineTo(x,y){const a=this.current.clone(),b=new Vec2(x,y);this.curves.push(new Seg2('line',t=>new Vec2(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t)));this.current.set(x,y);return this;}
 quadraticCurveTo(cx,cy,x,y){const a=this.current.clone();this.curves.push(new Seg2('curve',t=>new Vec2(bez2(t,a.x,cx,x),bez2(t,a.y,cy,y))));this.current.set(x,y);return this;}
 bezierCurveTo(c1x,c1y,c2x,c2y,x,y){const a=this.current.clone();this.curves.push(new Seg2('curve',t=>new Vec2(bez3(t,a.x,c1x,c2x,x),bez3(t,a.y,c1y,c2y,y))));this.current.set(x,y);return this;}
 absarc(x,y,r,a0,a1,cw=false){let d=a1-a0;const eps=Number.EPSILON;while(d<0)d+=2*Math.PI;while(d>2*Math.PI)d-=2*Math.PI;const same=Math.abs(d)<eps;if(d<eps)d=same?0:2*Math.PI;
  if(cw&&!same)d=d===2*Math.PI?-2*Math.PI:d-2*Math.PI;const seg=new Seg2('arc',t=>new Vec2(x+r*Math.cos(a0+t*d),y+r*Math.sin(a0+t*d)));
  if(this.curves.length){const f=seg.getPoint(0);if(f.x!==this.current.x||f.y!==this.current.y)this.lineTo(f.x,f.y);}this.curves.push(seg);this.current.copy(seg.getPoint(1));return this;}
 closePath(){if(!this.curves.length)return this;const s=this.curves[0].getPoint(0),e=this.curves[this.curves.length-1].getPoint(1);if(s.x!==e.x||s.y!==e.y)this.lineTo(s.x,s.y);this.autoClose=true;return this;}
 getPoints(div=12){const out=[];let last=null;for(const c of this.curves){const n=c.kind==='arc'?div*2:c.kind==='line'?1:div;
   for(let j=0;j<=n;j++){const p=c.getPoint(j/n);if(last&&last.x===p.x&&last.y===p.y)continue;out.push(p);last=p;}}
  if(this.autoClose&&out.length>1&&(out[0].x!==last.x||out[0].y!==last.y))out.push(out[0]);return out;}
}
export class Shape extends Path{
 constructor(points){super(points);this.holes=[];}
 extractPoints(div=12){return {shape:this.getPoints(div),holes:this.holes.map(h=>h.getPoints(div))};}
}
