// Minimal column-major 4x4 math for the GPU backend (no dependencies).
export const mul=(a,b,o=new Float32Array(16))=>{for(let c=0;c<4;c++)for(let r=0;r<4;r++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;}return o;};
export function invert(m,o=new Float32Array(16)){const a=m,b00=a[0]*a[5]-a[1]*a[4],b01=a[0]*a[6]-a[2]*a[4],b02=a[0]*a[7]-a[3]*a[4],b03=a[1]*a[6]-a[2]*a[5],b04=a[1]*a[7]-a[3]*a[5],b05=a[2]*a[7]-a[3]*a[6],b06=a[8]*a[13]-a[9]*a[12],b07=a[8]*a[14]-a[10]*a[12],b08=a[8]*a[15]-a[11]*a[12],b09=a[9]*a[14]-a[10]*a[13],b10=a[9]*a[15]-a[11]*a[13],b11=a[10]*a[15]-a[11]*a[14];let d=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;if(!d)return o.fill(0);d=1/d;
 o[0]=(a[5]*b11-a[6]*b10+a[7]*b09)*d;o[1]=(a[2]*b10-a[1]*b11-a[3]*b09)*d;o[2]=(a[13]*b05-a[14]*b04+a[15]*b03)*d;o[3]=(a[10]*b04-a[9]*b05-a[11]*b03)*d;o[4]=(a[6]*b08-a[4]*b11-a[7]*b07)*d;o[5]=(a[0]*b11-a[2]*b08+a[3]*b07)*d;o[6]=(a[14]*b02-a[12]*b05-a[15]*b01)*d;o[7]=(a[8]*b05-a[10]*b02+a[11]*b01)*d;o[8]=(a[4]*b10-a[5]*b08+a[7]*b06)*d;o[9]=(a[1]*b08-a[0]*b10-a[3]*b06)*d;o[10]=(a[12]*b04-a[13]*b02+a[15]*b00)*d;o[11]=(a[9]*b02-a[8]*b04-a[11]*b00)*d;o[12]=(a[5]*b07-a[4]*b09-a[6]*b06)*d;o[13]=(a[0]*b09-a[1]*b07+a[2]*b06)*d;o[14]=(a[13]*b01-a[12]*b03-a[14]*b00)*d;o[15]=(a[8]*b03-a[9]*b01+a[10]*b00)*d;return o;}
// Reversed-Z infinite perspective (depth 1 at near, 0 at infinity) for WebGPU clip space.
export function perspectiveRZ(fovDeg,aspect,near,o=new Float32Array(16)){const f=1/Math.tan(fovDeg*Math.PI/360);o.fill(0);o[0]=f/aspect;o[5]=f;o[11]=-1;o[14]=near;return o;}
// Frustum planes (world space, inward normals) from a view-projection matrix; reversed-Z far plane omitted.
export function frustum(m,out=new Float32Array(24)){const r=(i)=>[m[i],m[4+i],m[8+i],m[12+i]];const r0=r(0),r1=r(1),r2=r(2),r3=r(3);
 const planes=[r3.map((v,i)=>v+r0[i]),r3.map((v,i)=>v-r0[i]),r3.map((v,i)=>v+r1[i]),r3.map((v,i)=>v-r1[i]),r3.map((v,i)=>v-r2[i]),r2.slice()];
 planes[5]=[0,0,0,1e9];planes.forEach((p,k)=>{const l=Math.hypot(p[0],p[1],p[2])||1;for(let i=0;i<4;i++)out[k*4+i]=p[i]/l;});return out;}
export function lookAt(e,t,u,o=new Float32Array(16)){let zx=e[0]-t[0],zy=e[1]-t[1],zz=e[2]-t[2];let l=Math.hypot(zx,zy,zz);zx/=l;zy/=l;zz/=l;
 let xx=u[1]*zz-u[2]*zy,xy=u[2]*zx-u[0]*zz,xz=u[0]*zy-u[1]*zx;l=Math.hypot(xx,xy,xz);xx/=l;xy/=l;xz/=l;const yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
 o.set([xx,yx,zx,0,xy,yy,zy,0,xz,yz,zz,0,-(xx*e[0]+xy*e[1]+xz*e[2]),-(yx*e[0]+yy*e[1]+yz*e[2]),-(zx*e[0]+zy*e[1]+zz*e[2]),1]);return o;}
// Orthographic with WebGPU depth range [0,1].
export function ortho(l,r,b,t,n,f,o=new Float32Array(16)){o.fill(0);o[0]=2/(r-l);o[5]=2/(t-b);o[10]=-1/(f-n);o[12]=-(r+l)/(r-l);o[13]=-(t+b)/(t-b);o[14]=-n/(f-n);o[15]=1;return o;}
