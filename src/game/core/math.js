// Fairway Atlas engine core: math. Column-major 4x4 matrices (Float64), right-handed, Y up, cameras look down -Z.
export const MathUtils={
 clamp:(v,a,b)=>v<a?a:v>b?b:v,
 lerp:(a,b,t)=>a+(b-a)*t,
 degToRad:d=>d*Math.PI/180,
 radToDeg:r=>r*180/Math.PI,
 smoothstep:(x,a,b)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);},
 euclideanModulo:(n,m)=>((n%m)+m)%m,
};

export class Vec2{
 constructor(x=0,y=0){this.x=x;this.y=y;}
 set(x,y){this.x=x;this.y=y;return this;}
 copy(v){this.x=v.x;this.y=v.y;return this;}
 clone(){return new Vec2(this.x,this.y);}
 lengthSq(){return this.x*this.x+this.y*this.y;}
 length(){return Math.hypot(this.x,this.y);}
 normalize(){const l=this.length()||1;this.x/=l;this.y/=l;return this;}
}

export class Vec3{
 constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
 set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
 setScalar(s){this.x=this.y=this.z=s;return this;}
 copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;}
 clone(){return new Vec3(this.x,this.y,this.z);}
 fromArray(a,o=0){this.x=a[o];this.y=a[o+1];this.z=a[o+2];return this;}
 toArray(a=[],o=0){a[o]=this.x;a[o+1]=this.y;a[o+2]=this.z;return a;}
 add(v){this.x+=v.x;this.y+=v.y;this.z+=v.z;return this;}
 addVectors(a,b){this.x=a.x+b.x;this.y=a.y+b.y;this.z=a.z+b.z;return this;}
 addScaledVector(v,s){this.x+=v.x*s;this.y+=v.y*s;this.z+=v.z*s;return this;}
 sub(v){this.x-=v.x;this.y-=v.y;this.z-=v.z;return this;}
 subVectors(a,b){this.x=a.x-b.x;this.y=a.y-b.y;this.z=a.z-b.z;return this;}
 multiplyScalar(s){this.x*=s;this.y*=s;this.z*=s;return this;}
 multiply(v){this.x*=v.x;this.y*=v.y;this.z*=v.z;return this;}
 divideScalar(s){return this.multiplyScalar(1/s);}
 negate(){this.x=-this.x;this.y=-this.y;this.z=-this.z;return this;}
 dot(v){return this.x*v.x+this.y*v.y+this.z*v.z;}
 cross(v){return this.crossVectors(this,v);}
 crossVectors(a,b){const x=a.y*b.z-a.z*b.y,y=a.z*b.x-a.x*b.z,z=a.x*b.y-a.y*b.x;this.x=x;this.y=y;this.z=z;return this;}
 lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z;}
 length(){return Math.sqrt(this.lengthSq());}
 normalize(){return this.divideScalar(this.length()||1);}
 setLength(l){return this.normalize().multiplyScalar(l);}
 distanceTo(v){return Math.sqrt(this.distanceToSquared(v));}
 distanceToSquared(v){const dx=this.x-v.x,dy=this.y-v.y,dz=this.z-v.z;return dx*dx+dy*dy+dz*dz;}
 lerp(v,t){this.x+=(v.x-this.x)*t;this.y+=(v.y-this.y)*t;this.z+=(v.z-this.z)*t;return this;}
 lerpVectors(a,b,t){this.x=a.x+(b.x-a.x)*t;this.y=a.y+(b.y-a.y)*t;this.z=a.z+(b.z-a.z)*t;return this;}
 equals(v){return v.x===this.x&&v.y===this.y&&v.z===this.z;}
 min(v){this.x=Math.min(this.x,v.x);this.y=Math.min(this.y,v.y);this.z=Math.min(this.z,v.z);return this;}
 max(v){this.x=Math.max(this.x,v.x);this.y=Math.max(this.y,v.y);this.z=Math.max(this.z,v.z);return this;}
 applyQuaternion(q){const x=this.x,y=this.y,z=this.z,qx=q.x,qy=q.y,qz=q.z,qw=q.w;
  const tx=2*(qy*z-qz*y),ty=2*(qz*x-qx*z),tz=2*(qx*y-qy*x);
  this.x=x+qw*tx+qy*tz-qz*ty;this.y=y+qw*ty+qz*tx-qx*tz;this.z=z+qw*tz+qx*ty-qy*tx;return this;}
 applyMatrix4(m){const e=m.elements,x=this.x,y=this.y,z=this.z,w=1/(e[3]*x+e[7]*y+e[11]*z+e[15]||1);
  this.x=(e[0]*x+e[4]*y+e[8]*z+e[12])*w;this.y=(e[1]*x+e[5]*y+e[9]*z+e[13])*w;this.z=(e[2]*x+e[6]*y+e[10]*z+e[14])*w;return this;}
 transformDirection(m){const e=m.elements,x=this.x,y=this.y,z=this.z;this.x=e[0]*x+e[4]*y+e[8]*z;this.y=e[1]*x+e[5]*y+e[9]*z;this.z=e[2]*x+e[6]*y+e[10]*z;return this.normalize();}
 setFromMatrixPosition(m){const e=m.elements;this.x=e[12];this.y=e[13];this.z=e[14];return this;}
 // world -> normalized device coordinates of a camera (x,y in [-1,1] on screen; z<1 in front)
 project(camera){camera.updateMatrixWorld();return this.applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);}
}

export class Quat{
 constructor(x=0,y=0,z=0,w=1){this._x=x;this._y=y;this._z=z;this._w=w;this._cb=null;}
 get x(){return this._x}set x(v){this._x=v;this._cb?.()}
 get y(){return this._y}set y(v){this._y=v;this._cb?.()}
 get z(){return this._z}set z(v){this._z=v;this._cb?.()}
 get w(){return this._w}set w(v){this._w=v;this._cb?.()}
 _set(x,y,z,w){this._x=x;this._y=y;this._z=z;this._w=w;this._cb?.();return this;}
 set(x,y,z,w){return this._set(x,y,z,w);}
 copy(q){return this._set(q.x,q.y,q.z,q.w);}
 clone(){return new Quat(this._x,this._y,this._z,this._w);}
 identity(){return this._set(0,0,0,1);}
 length(){return Math.hypot(this._x,this._y,this._z,this._w);}
 normalize(){const l=this.length();return l?this._set(this._x/l,this._y/l,this._z/l,this._w/l):this._set(0,0,0,1);}
 invert(){return this._set(-this._x,-this._y,-this._z,this._w);}
 dot(q){return this._x*q.x+this._y*q.y+this._z*q.z+this._w*q.w;}
 setFromAxisAngle(a,angle){const h=angle/2,s=Math.sin(h);return this._set(a.x*s,a.y*s,a.z*s,Math.cos(h));}
 setFromUnitVectors(from,to){let r=from.dot(to)+1,x,y,z,w;
  if(r<1e-8){r=0;if(Math.abs(from.x)>Math.abs(from.z)){x=-from.y;y=from.x;z=0;w=r;}else{x=0;y=-from.z;z=from.y;w=r;}}
  else{x=from.y*to.z-from.z*to.y;y=from.z*to.x-from.x*to.z;z=from.x*to.y-from.y*to.x;w=r;}
  this._x=x;this._y=y;this._z=z;this._w=w;return this.normalize();}
 multiply(q){return this.multiplyQuaternions(this,q);}
 premultiply(q){return this.multiplyQuaternions(q,this);}
 multiplyQuaternions(a,b){const ax=a.x,ay=a.y,az=a.z,aw=a.w,bx=b.x,by=b.y,bz=b.z,bw=b.w;
  return this._set(ax*bw+aw*bx+ay*bz-az*by,ay*bw+aw*by+az*bx-ax*bz,az*bw+aw*bz+ax*by-ay*bx,aw*bw-ax*bx-ay*by-az*bz);}
 setFromRotationMatrix(m){const e=m.elements,m11=e[0],m12=e[4],m13=e[8],m21=e[1],m22=e[5],m23=e[9],m31=e[2],m32=e[6],m33=e[10],tr=m11+m22+m33;let s;
  if(tr>0){s=.5/Math.sqrt(tr+1);return this._set((m32-m23)*s,(m13-m31)*s,(m21-m12)*s,.25/s);}
  if(m11>m22&&m11>m33){s=2*Math.sqrt(1+m11-m22-m33);return this._set(.25*s,(m12+m21)/s,(m13+m31)/s,(m32-m23)/s);}
  if(m22>m33){s=2*Math.sqrt(1+m22-m11-m33);return this._set((m12+m21)/s,.25*s,(m23+m32)/s,(m13-m31)/s);}
  s=2*Math.sqrt(1+m33-m11-m22);return this._set((m13+m31)/s,(m23+m32)/s,.25*s,(m21-m12)/s);}
 setFromEuler(e,update=true){const c1=Math.cos(e._x/2),c2=Math.cos(e._y/2),c3=Math.cos(e._z/2),s1=Math.sin(e._x/2),s2=Math.sin(e._y/2),s3=Math.sin(e._z/2);   // XYZ order
  this._x=s1*c2*c3+c1*s2*s3;this._y=c1*s2*c3-s1*c2*s3;this._z=c1*c2*s3+s1*s2*c3;this._w=c1*c2*c3-s1*s2*s3;if(update)this._cb?.();return this;}
 slerp(qb,t){if(t===0)return this;if(t===1)return this.copy(qb);const x=this._x,y=this._y,z=this._z,w=this._w;let cos=w*qb.w+x*qb.x+y*qb.y+z*qb.z,bx=qb.x,by=qb.y,bz=qb.z,bw=qb.w;
  if(cos<0){bx=-bx;by=-by;bz=-bz;bw=-bw;cos=-cos;}
  if(cos>=1)return this;const sq=1-cos*cos;
  if(sq<=Number.EPSILON){const s=1-t;return this._set(s*x+t*bx,s*y+t*by,s*z+t*bz,s*w+t*bw).normalize();}
  const sin=Math.sqrt(sq),half=Math.atan2(sin,cos),ra=Math.sin((1-t)*half)/sin,rb=Math.sin(t*half)/sin;
  return this._set(x*ra+bx*rb,y*ra+by*rb,z*ra+bz*rb,w*ra+bw*rb);}
 slerpQuaternions(a,b,t){return this.copy(a).slerp(b,t);}
 angleTo(q){return 2*Math.acos(Math.abs(MathUtils.clamp(this.dot(q),-1,1)));}
 toArray(a=[],o=0){a[o]=this._x;a[o+1]=this._y;a[o+2]=this._z;a[o+3]=this._w;return a;}
}

// XYZ Euler angles, kept in sync with a node's quaternion (either can be written)
export class Euler{
 constructor(x=0,y=0,z=0){this._x=x;this._y=y;this._z=z;this._cb=null;}
 get x(){return this._x}set x(v){this._x=v;this._cb?.()}
 get y(){return this._y}set y(v){this._y=v;this._cb?.()}
 get z(){return this._z}set z(v){this._z=v;this._cb?.()}
 set(x,y,z){this._x=x;this._y=y;this._z=z;this._cb?.();return this;}
 copy(e){return this.set(e.x,e.y,e.z);}
 setFromQuaternion(q,update=true){const m=new Mat4().makeRotationFromQuaternion(q),e=m.elements,m11=e[0],m12=e[4],m13=e[8],m22=e[5],m23=e[9],m32=e[6],m33=e[10];
  this._y=Math.asin(MathUtils.clamp(m13,-1,1));
  if(Math.abs(m13)<.9999999){this._x=Math.atan2(-m23,m33);this._z=Math.atan2(-m12,m11);}else{this._x=Math.atan2(m32,m22);this._z=0;}
  if(update)this._cb?.();return this;}
}

export class Mat4{
 constructor(){this.elements=new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);}
 identity(){this.elements.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);return this;}
 copy(m){this.elements.set(m.elements);return this;}
 clone(){return new Mat4().copy(this);}
 set(...v){const e=this.elements;for(let r=0;r<4;r++)for(let c=0;c<4;c++)e[c*4+r]=v[r*4+c];return this;}   // row-major arguments
 fromArray(a,o=0){for(let i=0;i<16;i++)this.elements[i]=a[o+i];return this;}
 multiply(m){return this.multiplyMatrices(this,m);}
 premultiply(m){return this.multiplyMatrices(m,this);}
 multiplyMatrices(a,b){const ae=a.elements,be=b.elements,o=this.elements,t=_t16;
  for(let c=0;c<4;c++)for(let r=0;r<4;r++)t[c*4+r]=ae[r]*be[c*4]+ae[4+r]*be[c*4+1]+ae[8+r]*be[c*4+2]+ae[12+r]*be[c*4+3];o.set(t);return this;}
 compose(p,q,s){const e=this.elements,x=q.x,y=q.y,z=q.z,w=q.w,x2=x+x,y2=y+y,z2=z+z,xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2,sx=s.x,sy=s.y,sz=s.z;
  e[0]=(1-(yy+zz))*sx;e[1]=(xy+wz)*sx;e[2]=(xz-wy)*sx;e[3]=0;e[4]=(xy-wz)*sy;e[5]=(1-(xx+zz))*sy;e[6]=(yz+wx)*sy;e[7]=0;
  e[8]=(xz+wy)*sz;e[9]=(yz-wx)*sz;e[10]=(1-(xx+yy))*sz;e[11]=0;e[12]=p.x;e[13]=p.y;e[14]=p.z;e[15]=1;return this;}
 makeRotationFromQuaternion(q){return this.compose(_zero,q,_one);}
 makeTranslation(x,y,z){this.identity();const e=this.elements;e[12]=x;e[13]=y;e[14]=z;return this;}
 makeRotationX(a){const c=Math.cos(a),s=Math.sin(a);return this.set(1,0,0,0,0,c,-s,0,0,s,c,0,0,0,0,1);}
 makeRotationY(a){const c=Math.cos(a),s=Math.sin(a);return this.set(c,0,s,0,0,1,0,0,-s,0,c,0,0,0,0,1);}
 makeRotationZ(a){const c=Math.cos(a),s=Math.sin(a);return this.set(c,-s,0,0,s,c,0,0,0,0,1,0,0,0,0,1);}
 makeScale(x,y,z){return this.set(x,0,0,0,0,y,0,0,0,0,z,0,0,0,0,1);}
 makeBasis(x,y,z){return this.set(x.x,y.x,z.x,0,x.y,y.y,z.y,0,x.z,y.z,z.z,0,0,0,0,1);}
 setPosition(x,y,z){const e=this.elements;if(typeof x==='object'){e[12]=x.x;e[13]=x.y;e[14]=x.z;}else{e[12]=x;e[13]=y;e[14]=z;}return this;}
 // rotation that points -Z from eye to target (camera convention)
 lookAt(eye,target,up){const e=this.elements;let zx=eye.x-target.x,zy=eye.y-target.y,zz=eye.z-target.z,l=Math.hypot(zx,zy,zz);if(l===0)zz=1,l=1;zx/=l;zy/=l;zz/=l;
  let xx=up.y*zz-up.z*zy,xy=up.z*zx-up.x*zz,xz=up.x*zy-up.y*zx;l=Math.hypot(xx,xy,xz);
  if(l===0){if(Math.abs(up.z)===1)zx+=1e-4;else zz+=1e-4;const n=Math.hypot(zx,zy,zz);zx/=n;zy/=n;zz/=n;xx=up.y*zz-up.z*zy;xy=up.z*zx-up.x*zz;xz=up.x*zy-up.y*zx;l=Math.hypot(xx,xy,xz);}
  xx/=l;xy/=l;xz/=l;const yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
  e[0]=xx;e[4]=yx;e[8]=zx;e[1]=xy;e[5]=yy;e[9]=zy;e[2]=xz;e[6]=yz;e[10]=zz;return this;}
 determinant(){const e=this.elements;const n11=e[0],n12=e[4],n13=e[8],n14=e[12],n21=e[1],n22=e[5],n23=e[9],n24=e[13],n31=e[2],n32=e[6],n33=e[10],n34=e[14],n41=e[3],n42=e[7],n43=e[11],n44=e[15];
  return n41*(+n14*n23*n32-n13*n24*n32-n14*n22*n33+n12*n24*n33+n13*n22*n34-n12*n23*n34)+n42*(+n11*n23*n34-n11*n24*n33+n14*n21*n33-n13*n21*n34+n13*n24*n31-n14*n23*n31)+n43*(+n11*n24*n32-n11*n22*n34-n14*n21*n32+n12*n21*n34+n14*n22*n31-n12*n24*n31)+n44*(-n13*n22*n31-n11*n23*n32+n11*n22*n33+n13*n21*n32-n12*n21*n33+n12*n23*n31);}
 invert(){const e=this.elements,n11=e[0],n21=e[1],n31=e[2],n41=e[3],n12=e[4],n22=e[5],n32=e[6],n42=e[7],n13=e[8],n23=e[9],n33=e[10],n43=e[11],n14=e[12],n24=e[13],n34=e[14],n44=e[15];
  const t11=n23*n34*n42-n24*n33*n42+n24*n32*n43-n22*n34*n43-n23*n32*n44+n22*n33*n44,t12=n14*n33*n42-n13*n34*n42-n14*n32*n43+n12*n34*n43+n13*n32*n44-n12*n33*n44,
   t13=n13*n24*n42-n14*n23*n42+n14*n22*n43-n12*n24*n43-n13*n22*n44+n12*n23*n44,t14=n14*n23*n32-n13*n24*n32-n14*n22*n33+n12*n24*n33+n13*n22*n34-n12*n23*n34;
  const det=n11*t11+n21*t12+n31*t13+n41*t14;if(det===0){this.elements.fill(0);return this;}const d=1/det;
  e[0]=t11*d;e[1]=(n24*n33*n41-n23*n34*n41-n24*n31*n43+n21*n34*n43+n23*n31*n44-n21*n33*n44)*d;e[2]=(n22*n34*n41-n24*n32*n41+n24*n31*n42-n21*n34*n42-n22*n31*n44+n21*n32*n44)*d;e[3]=(n23*n32*n41-n22*n33*n41-n23*n31*n42+n21*n33*n42+n22*n31*n43-n21*n32*n43)*d;
  e[4]=t12*d;e[5]=(n13*n34*n41-n14*n33*n41+n14*n31*n43-n11*n34*n43-n13*n31*n44+n11*n33*n44)*d;e[6]=(n14*n32*n41-n12*n34*n41-n14*n31*n42+n11*n34*n42+n12*n31*n44-n11*n32*n44)*d;e[7]=(n12*n33*n41-n13*n32*n41+n13*n31*n42-n11*n33*n42-n12*n31*n43+n11*n32*n43)*d;
  e[8]=t13*d;e[9]=(n14*n23*n41-n13*n24*n41-n14*n21*n43+n11*n24*n43+n13*n21*n44-n11*n23*n44)*d;e[10]=(n12*n24*n41-n14*n22*n41+n14*n21*n42-n11*n24*n42-n12*n21*n44+n11*n22*n44)*d;e[11]=(n13*n22*n41-n12*n23*n41-n13*n21*n42+n11*n23*n42+n12*n21*n43-n11*n22*n43)*d;
  e[12]=t14*d;e[13]=(n13*n24*n31-n14*n23*n31+n14*n21*n33-n11*n24*n33-n13*n21*n34+n11*n23*n34)*d;e[14]=(n14*n22*n31-n12*n24*n31-n14*n21*n32+n11*n24*n32+n12*n21*n34-n11*n22*n34)*d;e[15]=(n12*n23*n31-n13*n22*n31+n13*n21*n32-n11*n23*n32-n12*n21*n33+n11*n22*n33)*d;
  return this;}
 // OpenGL-style clip (z in [-1,1]); only used on the CPU (screen projections); the GPU engine builds its own reversed-Z matrix
 makePerspective(left,right,top,bottom,near,far){const e=this.elements,x=2*near/(right-left),y=2*near/(top-bottom),a=(right+left)/(right-left),b=(top+bottom)/(top-bottom),c=-(far+near)/(far-near),d=-2*far*near/(far-near);
  e.set([x,0,0,0,0,y,0,0,a,b,c,-1,0,0,d,0]);return this;}
 getMaxScaleOnAxis(){const e=this.elements;return Math.sqrt(Math.max(e[0]*e[0]+e[1]*e[1]+e[2]*e[2],e[4]*e[4]+e[5]*e[5]+e[6]*e[6],e[8]*e[8]+e[9]*e[9]+e[10]*e[10]));}
}
const _t16=new Float64Array(16),_zero=new Vec3(),_one=new Vec3(1,1,1);

// Colours are stored linear (what the shaders light with); CSS hex/strings are sRGB and converted on the way in.
const toLin=c=>c<.04045?c*.0773993808:Math.pow(c*.9478672986+.0521327014,2.4);
const toSRGB=c=>c<.0031308?c*12.92:1.055*Math.pow(c,.41666)-.055;
export class Color{
 constructor(v){this.r=1;this.g=1;this.b=1;if(v!==undefined)this.set(v);}
 set(v){if(v instanceof Color)return this.copy(v);if(typeof v==='number')return this.setHex(v);if(typeof v==='string'){let s=v.trim();if(s[0]==='#'){s=s.slice(1);if(s.length===3)s=s.split('').map(c=>c+c).join('');return this.setHex(parseInt(s.slice(0,6),16));}}return this;}
 setHex(h){this.r=toLin((h>>16&255)/255);this.g=toLin((h>>8&255)/255);this.b=toLin((h&255)/255);return this;}
 setRGB(r,g,b){this.r=r;this.g=g;this.b=b;return this;}   // linear
 copy(c){this.r=c.r;this.g=c.g;this.b=c.b;return this;}
 clone(){return new Color().copy(this);}
 lerp(c,t){this.r+=(c.r-this.r)*t;this.g+=(c.g-this.g)*t;this.b+=(c.b-this.b)*t;return this;}
 multiplyScalar(s){this.r*=s;this.g*=s;this.b*=s;return this;}
 getHex(){return Math.round(toSRGB(this.r)*255)<<16|Math.round(toSRGB(this.g)*255)<<8|Math.round(toSRGB(this.b)*255);}
 getStyle(){return '#'+this.getHex().toString(16).padStart(6,'0');}
}
