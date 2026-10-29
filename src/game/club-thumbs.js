import {Vec3,Group,Camera,MathUtils} from './core/index.js';
import {createClub} from './club-models.js';
// Small still renders of the real 3D club models, flipped upside down and cropped to the head, for use as HUD glyphs.
// Drawn by a tiny software rasterizer (z-buffer, per-pixel normals, hemisphere + key + rim light, ACES), 2x supersampled;
// no GPU context is created for them. Results cached as data URLs.
const cache=new Map();const W=224,H=144,SS=2;
const lin=h=>{const c=parseInt(h.slice(1),16),f=v=>{v/=255;return v<.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)};return [f(c>>16&255),f(c>>8&255),f(c&255)];};
const SKY=lin('#f4f7ea').map(v=>v*1.6),GND=lin('#223027').map(v=>v*1.6),KEY=[2.6,2.6,2.6],RIM=lin('#dbeab4').map(v=>v*1.8);
const KD=new Vec3(-.6,1,-1.2).normalize(),RD=new Vec3(1,.3,1).normalize();
const aces=x=>{x*=1.15*.6;return Math.min(1,Math.max(0,(x*(2.51*x+.03))/(x*(2.43*x+.59)+.14)));};
const srgb=v=>v<.0031308?v*12.92:1.055*Math.pow(v,1/2.4)-.055;
export function clubThumb(index){
 if(cache.has(index))return cache.get(index);
 try{
  const club=createClub(index),holder=new Group();holder.add(club);holder.rotation.z=Math.PI;holder.updateMatrixWorld(true);
  const head=club.children[0]||club,mn=new Vec3(Infinity,Infinity,Infinity),mx=new Vec3(-Infinity,-Infinity,-Infinity),v=new Vec3();
  head.traverse(o=>{if(!o.isMesh)return;const p=o.geometry.attributes.position;for(let i=0;i<p.count;i++){v.set(p.getX(i),p.getY(i),p.getZ(i)).applyMatrix4(o.matrixWorld);mn.min(v);mx.max(v);}});
  const c=new Vec3().addVectors(mn,mx).multiplyScalar(.5),size=new Vec3().subVectors(mx,mn);
  const cam=new Camera(22,W/H,.01,10),span=Math.max(size.x,size.y*1.4,size.z)*1.25,dist=span/(2*Math.tan(MathUtils.degToRad(cam.fov/2)));
  cam.position.copy(c).add(new Vec3(.45,.22,-1).normalize().multiplyScalar(dist));cam.lookAt(c);cam.updateMatrixWorld();
  const w=W*SS,h=H*SS,zb=new Float32Array(w*h).fill(Infinity),col=new Float32Array(w*h*3),cov=new Uint8Array(w*h);
  const V=cam.matrixWorldInverse.elements,P=cam.projectionMatrix.elements,eye=cam.position;
  holder.traverse(o=>{if(!o.isMesh)return;const g=o.geometry,m=o.material,pos=g.attributes.position,nrm=g.attributes.normal,vc=m.vertexColors?g.attributes.color:null,e=o.matrixWorld.elements,n=pos.count;
   const sx=new Float32Array(n),sy=new Float32Array(n),sz=new Float32Array(n),wp=new Float32Array(n*3),wn=new Float32Array(n*3);
   for(let i=0;i<n;i++){const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i),X=e[0]*x+e[4]*y+e[8]*z+e[12],Y=e[1]*x+e[5]*y+e[9]*z+e[13],Z=e[2]*x+e[6]*y+e[10]*z+e[14];wp[i*3]=X;wp[i*3+1]=Y;wp[i*3+2]=Z;
    const vx=V[0]*X+V[4]*Y+V[8]*Z+V[12],vy=V[1]*X+V[5]*Y+V[9]*Z+V[13],vz=V[2]*X+V[6]*Y+V[10]*Z+V[14],cx=P[0]*vx+P[8]*vz,cy=P[5]*vy+P[9]*vz,cw=-vz;
    sx[i]=(cx/cw*.5+.5)*w;sy[i]=(1-(cy/cw*.5+.5))*h;sz[i]=-vz;
    if(nrm){const a=nrm.getX(i),b=nrm.getY(i),cc=nrm.getZ(i);let nx=e[0]*a+e[4]*b+e[8]*cc,ny=e[1]*a+e[5]*b+e[9]*cc,nz=e[2]*a+e[6]*b+e[10]*cc;const l=Math.hypot(nx,ny,nz)||1;wn[i*3]=nx/l;wn[i*3+1]=ny/l;wn[i*3+2]=nz/l;}}
   const base=[m.color.r,m.color.g,m.color.b],em=[m.emissive.r*m.emissiveIntensity,m.emissive.g*m.emissiveIntensity,m.emissive.b*m.emissiveIntensity],metal=m.metalness||0,rough=m.roughness??1,shin=2/Math.max(.02,rough*rough)-2;
   const I=g.index?g.index.array:null,tc=I?I.length/3:n/3;
   for(let t=0;t<tc;t++){const a=I?I[t*3]:t*3,b=I?I[t*3+1]:t*3+1,d=I?I[t*3+2]:t*3+2;
    const x0=sx[a],y0=sy[a],x1=sx[b],y1=sy[b],x2=sx[d],y2=sy[d],ar=(x1-x0)*(y2-y0)-(x2-x0)*(y1-y0);if(!ar||sz[a]<=0||sz[b]<=0||sz[d]<=0)continue;
    const minX=Math.max(0,Math.floor(Math.min(x0,x1,x2))),maxX=Math.min(w-1,Math.ceil(Math.max(x0,x1,x2))),minY=Math.max(0,Math.floor(Math.min(y0,y1,y2))),maxY=Math.min(h-1,Math.ceil(Math.max(y0,y1,y2)));
    for(let py=minY;py<=maxY;py++)for(let px=minX;px<=maxX;px++){const qx=px+.5,qy=py+.5,w0=((x1-qx)*(y2-qy)-(x2-qx)*(y1-qy))/ar,w1=((x2-qx)*(y0-qy)-(x0-qx)*(y2-qy))/ar,w2=1-w0-w1;
     if(w0<0||w1<0||w2<0)continue;const z=w0*sz[a]+w1*sz[b]+w2*sz[d],k=py*w+px;if(z>=zb[k])continue;zb[k]=z;cov[k]=1;
     let nx=w0*wn[a*3]+w1*wn[b*3]+w2*wn[d*3],ny=w0*wn[a*3+1]+w1*wn[b*3+1]+w2*wn[d*3+1],nz=w0*wn[a*3+2]+w1*wn[b*3+2]+w2*wn[d*3+2];const nl=Math.hypot(nx,ny,nz)||1;nx/=nl;ny/=nl;nz/=nl;
     const X=w0*wp[a*3]+w1*wp[b*3]+w2*wp[d*3],Y=w0*wp[a*3+1]+w1*wp[b*3+1]+w2*wp[d*3+1],Z=w0*wp[a*3+2]+w1*wp[b*3+2]+w2*wp[d*3+2];
     let ex=eye.x-X,ey=eye.y-Y,ez=eye.z-Z;const el=Math.hypot(ex,ey,ez)||1;ex/=el;ey/=el;ez/=el;if(nx*ex+ny*ey+nz*ez<0){nx=-nx;ny=-ny;nz=-nz;}
     const alb=vc?[base[0]*vc.getX(a)*w0+base[0]*vc.getX(b)*w1+base[0]*vc.getX(d)*w2,base[1]*vc.getY(a)*w0+base[1]*vc.getY(b)*w1+base[1]*vc.getY(d)*w2,base[2]*vc.getZ(a)*w0+base[2]*vc.getZ(b)*w1+base[2]*vc.getZ(d)*w2]:base;
     const hk=.5+.5*ny,dk=Math.max(0,nx*KD.x+ny*KD.y+nz*KD.z),dr=Math.max(0,nx*RD.x+ny*RD.y+nz*RD.z);
     const spec=(L,D)=>{const hx=L.x+ex,hy=L.y+ey,hz=L.z+ez,hl=Math.hypot(hx,hy,hz)||1;return Math.pow(Math.max(0,(nx*hx+ny*hy+nz*hz)/hl),shin)*(shin+8)/25*D;};
     const sk=spec(KD,dk),sr=spec(RD,dr),env=metal*(.35+.65*Math.max(0,ny));
     for(let ch=0;ch<3;ch++){const f0=.04*(1-metal)+alb[ch]*metal,amb=GND[ch]+(SKY[ch]-GND[ch])*hk,diff=alb[ch]*(1-metal)*(amb*.35+KEY[ch]*dk+RIM[ch]*dr);
      col[k*3+ch]=diff+f0*(KEY[ch]*sk+RIM[ch]*sr+SKY[ch]*env)+em[ch];}}}});
  // 2x2 box downsample, tonemap, alpha from coverage; then crop to the drawn pixels
  const cv=document.createElement('canvas');cv.width=W;cv.height=H;const x=cv.getContext('2d'),img=x.createImageData(W,H),o=img.data;let bx0=W,by0=H,bx1=0,by1=0;
  for(let y=0;y<H;y++)for(let i=0;i<W;i++){let r=0,gg=0,b=0,cn=0;for(let j=0;j<SS;j++)for(let k2=0;k2<SS;k2++){const k=(y*SS+j)*w+i*SS+k2;if(!cov[k])continue;cn++;r+=aces(col[k*3]);gg+=aces(col[k*3+1]);b+=aces(col[k*3+2]);}
   const q=(y*W+i)*4;if(cn){o[q]=Math.round(srgb(r/cn)*255);o[q+1]=Math.round(srgb(gg/cn)*255);o[q+2]=Math.round(srgb(b/cn)*255);o[q+3]=Math.round(cn/(SS*SS)*255);if(i<bx0)bx0=i;if(i>bx1)bx1=i;if(y<by0)by0=y;if(y>by1)by1=y;}}
  x.putImageData(img,0,0);let url=cv.toDataURL('image/png');
  if(bx1>bx0){const out=document.createElement('canvas');out.width=bx1-bx0+1;out.height=by1-by0+1;out.getContext('2d').drawImage(cv,bx0,by0,out.width,out.height,0,0,out.width,out.height);url=out.toDataURL('image/png');}
  cache.set(index,url);return url;
 }catch(e){console.warn('club thumbnail',e);cache.set(index,'');return''}
}
