// Fairway Atlas engine core: geometry containers, procedural builders and polygon triangulation (earcut).
import {Vec3,Mat4} from './math.js';

let _gid=0;
export class Attr{
 constructor(array,itemSize){this.array=array;this.itemSize=itemSize;this.count=array.length/itemSize;this.version=0;}
 set needsUpdate(v){if(v)this.version++;}
 getX(i){return this.array[i*this.itemSize]}getY(i){return this.array[i*this.itemSize+1]}getZ(i){return this.array[i*this.itemSize+2]}getW(i){return this.array[i*this.itemSize+3]}
 setX(i,v){this.array[i*this.itemSize]=v;return this}setY(i,v){this.array[i*this.itemSize+1]=v;return this}setZ(i,v){this.array[i*this.itemSize+2]=v;return this}
 setXYZ(i,x,y,z){const o=i*this.itemSize,a=this.array;a[o]=x;a[o+1]=y;a[o+2]=z;return this}
 clone(){return new Attr(this.array.slice(),this.itemSize);}
}
export const f32=(a,n)=>new Attr(a instanceof Float32Array?a:new Float32Array(a),n);

export class Geometry{
 constructor(){this.id=++_gid;this.attributes={};this.index=null;this.groups=[];this.userData={};this.boundingSphere=null;this.boundingBox=null;this.drawRange={start:0,count:Infinity};this._disposers=[];}
 setAttribute(name,a){this.attributes[name]=a;return this;}
 getAttribute(name){return this.attributes[name];}
 deleteAttribute(name){delete this.attributes[name];return this;}
 setIndex(idx){if(idx==null){this.index=null;return this;}if(idx instanceof Attr){this.index=idx;return this;}
  let max=0;for(let i=0;i<idx.length;i++)if(idx[i]>max)max=idx[i];this.index=new Attr(max>65535?Uint32Array.from(idx):Uint16Array.from(idx),1);return this;}
 addGroup(start,count,materialIndex=0){this.groups.push({start,count,materialIndex});}
 setFromPoints(pts){const a=new Float32Array(pts.length*3);pts.forEach((p,i)=>{a[i*3]=p.x;a[i*3+1]=p.y;a[i*3+2]=p.z??0;});return this.setAttribute('position',new Attr(a,3));}
 computeVertexNormals(){const pos=this.attributes.position;if(!pos)return this;const p=pos.array,n=new Float32Array(p.length);
  const face=(a,b,c)=>{const ax=p[a*3],ay=p[a*3+1],az=p[a*3+2],e1x=p[b*3]-ax,e1y=p[b*3+1]-ay,e1z=p[b*3+2]-az,e2x=p[c*3]-ax,e2y=p[c*3+1]-ay,e2z=p[c*3+2]-az;
   const nx=e1y*e2z-e1z*e2y,ny=e1z*e2x-e1x*e2z,nz=e1x*e2y-e1y*e2x;for(const v of [a,b,c]){n[v*3]+=nx;n[v*3+1]+=ny;n[v*3+2]+=nz;}};
  if(this.index){const I=this.index.array;for(let i=0;i+2<I.length;i+=3)face(I[i],I[i+1],I[i+2]);}else for(let i=0;i+2<pos.count;i+=3)face(i,i+1,i+2);
  for(let i=0;i<n.length;i+=3){const l=Math.hypot(n[i],n[i+1],n[i+2])||1;n[i]/=l;n[i+1]/=l;n[i+2]/=l;}
  return this.setAttribute('normal',new Attr(n,3));}
 computeBoundingBox(){const p=this.attributes.position?.array||[];const mn=new Vec3(Infinity,Infinity,Infinity),mx=new Vec3(-Infinity,-Infinity,-Infinity);
  for(let i=0;i<p.length;i+=3){if(p[i]<mn.x)mn.x=p[i];if(p[i]>mx.x)mx.x=p[i];if(p[i+1]<mn.y)mn.y=p[i+1];if(p[i+1]>mx.y)mx.y=p[i+1];if(p[i+2]<mn.z)mn.z=p[i+2];if(p[i+2]>mx.z)mx.z=p[i+2];}
  return this.boundingBox={min:mn,max:mx};}
 computeBoundingSphere(){const b=this.computeBoundingBox(),c=new Vec3().addVectors(b.min,b.max).multiplyScalar(.5),p=this.attributes.position?.array||[];let r2=0;
  for(let i=0;i<p.length;i+=3){const dx=p[i]-c.x,dy=p[i+1]-c.y,dz=p[i+2]-c.z,d=dx*dx+dy*dy+dz*dz;if(d>r2)r2=d;}
  return this.boundingSphere={center:c,radius:p.length?Math.sqrt(r2):0};}
 applyMatrix4(m){const e=m.elements,pos=this.attributes.position;
  if(pos){const a=pos.array;for(let i=0;i<a.length;i+=3){const x=a[i],y=a[i+1],z=a[i+2];a[i]=e[0]*x+e[4]*y+e[8]*z+e[12];a[i+1]=e[1]*x+e[5]*y+e[9]*z+e[13];a[i+2]=e[2]*x+e[6]*y+e[10]*z+e[14];}pos.needsUpdate=true;}
  const nrm=this.attributes.normal;if(nrm){const inv=new Mat4().copy(m).invert().elements,a=nrm.array;   // normal matrix = inverse transpose
   for(let i=0;i<a.length;i+=3){const x=a[i],y=a[i+1],z=a[i+2];let nx=inv[0]*x+inv[1]*y+inv[2]*z,ny=inv[4]*x+inv[5]*y+inv[6]*z,nz=inv[8]*x+inv[9]*y+inv[10]*z;const l=Math.hypot(nx,ny,nz)||1;a[i]=nx/l;a[i+1]=ny/l;a[i+2]=nz/l;}nrm.needsUpdate=true;}
  if(this.boundingSphere)this.computeBoundingSphere();return this;}
 translate(x,y,z){return this.applyMatrix4(new Mat4().makeTranslation(x,y,z));}
 rotateX(a){return this.applyMatrix4(new Mat4().makeRotationX(a));}
 rotateY(a){return this.applyMatrix4(new Mat4().makeRotationY(a));}
 rotateZ(a){return this.applyMatrix4(new Mat4().makeRotationZ(a));}
 scale(x,y,z){return this.applyMatrix4(new Mat4().makeScale(x,y,z));}
 toNonIndexed(){if(!this.index)return this;const I=this.index.array,g=new Geometry();
  for(const [name,a] of Object.entries(this.attributes)){const s=a.itemSize,out=new a.array.constructor(I.length*s);for(let i=0;i<I.length;i++)for(let k=0;k<s;k++)out[i*s+k]=a.array[I[i]*s+k];g.setAttribute(name,new Attr(out,s));}
  g.groups=this.groups.map(x=>({...x}));return g;}
 clone(){const g=new Geometry();for(const [n,a] of Object.entries(this.attributes))g.setAttribute(n,a.clone());if(this.index)g.index=this.index.clone();g.groups=this.groups.map(x=>({...x}));g.userData={...this.userData};return g;}
 onDispose(f){this._disposers.push(f);}
 dispose(){for(const f of this._disposers.splice(0))f();}
}

const build=(pos,nrm,uv,idx)=>{const g=new Geometry();g.setAttribute('position',f32(pos,3));if(nrm)g.setAttribute('normal',f32(nrm,3));if(uv)g.setAttribute('uv',f32(uv,2));if(idx)g.setIndex(idx);return g;};

// XY plane facing +Z (rotateX(-PI/2) to lay it on the ground)
export function planeGeometry(w=1,h=1,ws=1,hs=1){const P=[],N=[],U=[],I=[],gx=ws+1;
 for(let iy=0;iy<=hs;iy++){const y=iy*h/hs-h/2;for(let ix=0;ix<=ws;ix++){P.push(ix*w/ws-w/2,-y,0);N.push(0,0,1);U.push(ix/ws,1-iy/hs);}}
 for(let iy=0;iy<hs;iy++)for(let ix=0;ix<ws;ix++){const a=ix+gx*iy,b=ix+gx*(iy+1),c=ix+1+gx*(iy+1),d=ix+1+gx*iy;I.push(a,b,d,b,c,d);}
 return build(P,N,U,I);}
export function sphereGeometry(r=1,ws=32,hs=16){const P=[],N=[],U=[],I=[],grid=[];let k=0;
 for(let iy=0;iy<=hs;iy++){const v=iy/hs,row=[],uo=iy===0?.5/ws:iy===hs?-.5/ws:0;
  for(let ix=0;ix<=ws;ix++){const u=ix/ws,x=-Math.cos(u*2*Math.PI)*Math.sin(v*Math.PI),y=Math.cos(v*Math.PI),z=Math.sin(u*2*Math.PI)*Math.sin(v*Math.PI);P.push(x*r,y*r,z*r);N.push(x,y,z);U.push(u+uo,1-v);row.push(k++);}grid.push(row);}
 for(let iy=0;iy<hs;iy++)for(let ix=0;ix<ws;ix++){const a=grid[iy][ix+1],b=grid[iy][ix],c=grid[iy+1][ix],d=grid[iy+1][ix+1];if(iy!==0)I.push(a,b,d);if(iy!==hs-1)I.push(b,c,d);}
 return build(P,N,U,I);}
export function boxGeometry(w=1,h=1,d=1){const P=[],N=[],U=[],I=[];
 const face=(o,uA,vA,n)=>{const b=P.length/3;for(const [s,t] of [[-1,-1],[1,-1],[1,1],[-1,1]]){P.push(o[0]+uA[0]*s+vA[0]*t,o[1]+uA[1]*s+vA[1]*t,o[2]+uA[2]*s+vA[2]*t);N.push(...n);U.push((s+1)/2,(t+1)/2);}I.push(b,b+1,b+2,b,b+2,b+3);};
 const x=w/2,y=h/2,z=d/2;
 face([x,0,0],[0,0,-z],[0,y,0],[1,0,0]);face([-x,0,0],[0,0,z],[0,y,0],[-1,0,0]);
 face([0,y,0],[x,0,0],[0,0,-z],[0,1,0]);face([0,-y,0],[x,0,0],[0,0,z],[0,-1,0]);
 face([0,0,z],[x,0,0],[0,y,0],[0,0,1]);face([0,0,-z],[-x,0,0],[0,y,0],[0,0,-1]);
 return build(P,N,U,I);}
export function cylinderGeometry(rt=1,rb=1,h=1,rs=32,hs=1,open=false){const P=[],N=[],U=[],I=[],grid=[],slope=(rb-rt)/h;
 for(let y=0;y<=hs;y++){const v=y/hs,r=v*(rb-rt)+rt,row=[];for(let x=0;x<=rs;x++){const t=x/rs*2*Math.PI,s=Math.sin(t),c=Math.cos(t);row.push(P.length/3);P.push(r*s,-v*h+h/2,r*c);const l=Math.hypot(s,slope,c);N.push(s/l,slope/l,c/l);U.push(x/rs,1-v);}grid.push(row);}
 for(let x=0;x<rs;x++)for(let y=0;y<hs;y++){const a=grid[y][x],b=grid[y+1][x],c=grid[y+1][x+1],d=grid[y][x+1];I.push(a,b,d,b,c,d);}
 if(!open)for(const top of [true,false]){const r=top?rt:rb;if(r<=0)continue;const sy=top?1:-1,c0=P.length/3;P.push(0,h/2*sy,0);N.push(0,sy,0);U.push(.5,.5);const b0=P.length/3;
  for(let x=0;x<=rs;x++){const t=x/rs*2*Math.PI;P.push(r*Math.sin(t),h/2*sy,r*Math.cos(t));N.push(0,sy,0);U.push(.5+Math.sin(t)/2,.5+Math.cos(t)/2);}
  for(let x=0;x<rs;x++)top?I.push(c0,b0+x,b0+x+1):I.push(c0,b0+x+1,b0+x);}
 return build(P,N,U,I);}
export function circleGeometry(r=1,seg=32){const P=[0,0,0],N=[0,0,1],U=[.5,.5],I=[];
 for(let s=0;s<=seg;s++){const t=s/seg*2*Math.PI;P.push(r*Math.cos(t),r*Math.sin(t),0);N.push(0,0,1);U.push((Math.cos(t)+1)/2,(Math.sin(t)+1)/2);}
 for(let i=1;i<=seg;i++)I.push(i,i+1,0);return build(P,N,U,I);}
export function ringGeometry(ri=.5,ro=1,seg=32){const P=[],N=[],U=[],I=[];
 for(const r of [ri,ro])for(let i=0;i<=seg;i++){const t=i/seg*2*Math.PI;P.push(r*Math.cos(t),r*Math.sin(t),0);N.push(0,0,1);U.push((r*Math.cos(t)/ro+1)/2,(r*Math.sin(t)/ro+1)/2);}
 for(let i=0;i<seg;i++){const a=i,b=i+seg+1,c=i+seg+2,d=i+1;I.push(a,b,d,b,c,d);}return build(P,N,U,I);}
export function tubeGeometry(curve,tub=64,radius=1,rad=8,closed=false){const fr=curve.computeFrenetFrames(tub,closed),P=[],N=[],U=[],I=[];
 for(let i=0;i<=tub;i++){const p=curve.getPointAt(i/tub),n=fr.normals[i],b=fr.binormals[i];
  for(let j=0;j<=rad;j++){const v=j/rad*2*Math.PI,s=Math.sin(v),c=-Math.cos(v),nx=c*n.x+s*b.x,ny=c*n.y+s*b.y,nz=c*n.z+s*b.z;N.push(nx,ny,nz);P.push(p.x+radius*nx,p.y+radius*ny,p.z+radius*nz);U.push(i/tub,j/rad);}}
 for(let j=1;j<=tub;j++)for(let i=1;i<=rad;i++){const a=(rad+1)*(j-1)+(i-1),b=(rad+1)*j+(i-1),c=(rad+1)*j+i,d=(rad+1)*(j-1)+i;I.push(a,b,d,b,c,d);}
 return build(P,N,U,I);}

// ---- polygon triangulation --------------------------------------------------------------------
export const polygonArea=pts=>{let a=0;for(let p=pts.length-1,q=0;q<pts.length;p=q++)a+=X(pts[p])*Y(pts[q])-X(pts[q])*Y(pts[p]);return a*.5;};
const X=p=>p.x??p[0],Y=p=>p.y??p[1];
export const isClockWise=pts=>polygonArea(pts)<0;
const dropDupEnd=pts=>{const l=pts.length;if(l>2&&X(pts[l-1])===X(pts[0])&&Y(pts[l-1])===Y(pts[0]))pts.pop();};
// contour + holes (arrays of {x,y} or [x,y]) -> [[a,b,c],...] indexing contour followed by the holes
export function triangulateShape(contour,holes=[]){dropDupEnd(contour);holes.forEach(dropDupEnd);const v=[],hi=[];for(const p of contour)v.push(X(p),Y(p));let k=contour.length;
 for(const h of holes){hi.push(k);k+=h.length;for(const p of h)v.push(X(p),Y(p));}const t=earcut(v,hi),out=[];for(let i=0;i<t.length;i+=3)out.push([t[i],t[i+1],t[i+2]]);return out;}

// earcut (ear clipping with hole bridging; after Mapbox's earcut, ISC)
export function earcut(data,holeIndices,dim=2){const hasHoles=holeIndices&&holeIndices.length,outerLen=hasHoles?holeIndices[0]*dim:data.length;
 let outer=linked(data,0,outerLen,dim,true);const tri=[];if(!outer||outer.next===outer.prev)return tri;
 if(hasHoles)outer=eliminateHoles(data,holeIndices,outer,dim);earLinked(outer,tri,dim,0);return tri;}
function EN(i,x,y){this.i=i;this.x=x;this.y=y;this.prev=null;this.next=null;this.steiner=false;}
function insertNode(i,x,y,last){const p=new EN(i,x,y);if(!last){p.prev=p;p.next=p;}else{p.next=last.next;p.prev=last;last.next.prev=p;last.next=p;}return p;}
function removeNode(p){p.next.prev=p.prev;p.prev.next=p.next;}
function signedArea(d,s,e,dim){let sum=0;for(let i=s,j=e-dim;i<e;i+=dim){sum+=(d[j]-d[i])*(d[i+1]+d[j+1]);j=i;}return sum;}
function linked(d,s,e,dim,cw){let last;if(cw===(signedArea(d,s,e,dim)>0)){for(let i=s;i<e;i+=dim)last=insertNode(i,d[i],d[i+1],last);}else for(let i=e-dim;i>=s;i-=dim)last=insertNode(i,d[i],d[i+1],last);
 if(last&&eq(last,last.next)){removeNode(last);last=last.next;}return last;}
const eq=(a,b)=>a.x===b.x&&a.y===b.y;
const area=(p,q,r)=>(q.y-p.y)*(r.x-q.x)-(q.x-p.x)*(r.y-q.y);
function filterPoints(start,end){if(!start)return start;if(!end)end=start;let p=start,again;
 do{again=false;if(!p.steiner&&(eq(p,p.next)||area(p.prev,p,p.next)===0)){removeNode(p);p=end=p.prev;if(p===p.next)break;again=true;}else p=p.next;}while(again||p!==end);return end;}
function earLinked(ear,tri,dim,pass){if(!ear)return;let stop=ear;
 while(ear.prev!==ear.next){const prev=ear.prev,next=ear.next;
  if(isEar(ear)){tri.push(prev.i/dim|0,ear.i/dim|0,next.i/dim|0);removeNode(ear);ear=next.next;stop=next.next;continue;}
  ear=next;if(ear===stop){if(!pass)earLinked(filterPoints(ear),tri,dim,1);else if(pass===1){ear=cureLocal(filterPoints(ear),tri,dim);earLinked(ear,tri,dim,2);}else if(pass===2)splitEar(ear,tri,dim);break;}}}
function isEar(ear){const a=ear.prev,b=ear,c=ear.next;if(area(a,b,c)>=0)return false;const x0=Math.min(a.x,b.x,c.x),y0=Math.min(a.y,b.y,c.y),x1=Math.max(a.x,b.x,c.x),y1=Math.max(a.y,b.y,c.y);
 let p=c.next;while(p!==a){if(p.x>=x0&&p.x<=x1&&p.y>=y0&&p.y<=y1&&inTri(a.x,a.y,b.x,b.y,c.x,c.y,p.x,p.y)&&area(p.prev,p,p.next)>=0)return false;p=p.next;}return true;}
function cureLocal(start,tri,dim){let p=start;do{const a=p.prev,b=p.next.next;if(!eq(a,b)&&intersects(a,p,p.next,b)&&locIn(a,b)&&locIn(b,a)){tri.push(a.i/dim|0,p.i/dim|0,b.i/dim|0);removeNode(p);removeNode(p.next);p=start=b;}p=p.next;}while(p!==start);return filterPoints(p);}
function splitEar(start,tri,dim){let a=start;do{let b=a.next.next;while(b!==a.prev){if(a.i!==b.i&&validDiag(a,b)){let c=splitPoly(a,b);a=filterPoints(a,a.next);c=filterPoints(c,c.next);earLinked(a,tri,dim,0);earLinked(c,tri,dim,0);return;}b=b.next;}a=a.next;}while(a!==start);}
function eliminateHoles(d,holes,outer,dim){const q=[];for(let i=0;i<holes.length;i++){const s=holes[i]*dim,e=i<holes.length-1?holes[i+1]*dim:d.length,l=linked(d,s,e,dim,false);if(!l)continue;if(l===l.next)l.steiner=true;q.push(leftmost(l));}
 q.sort((a,b)=>a.x-b.x);for(const h of q)outer=eliminateHole(h,outer);return outer;}
function eliminateHole(hole,outer){const bridge=holeBridge(hole,outer);if(!bridge)return outer;const br=splitPoly(bridge,hole);filterPoints(br,br.next);return filterPoints(bridge,bridge.next);}
function holeBridge(hole,outer){let p=outer,qx=-Infinity,m;const hx=hole.x,hy=hole.y;
 do{if(hy<=p.y&&hy>=p.next.y&&p.next.y!==p.y){const x=p.x+(hy-p.y)*(p.next.x-p.x)/(p.next.y-p.y);if(x<=hx&&x>qx){qx=x;m=p.x<p.next.x?p:p.next;if(x===hx)return m;}}p=p.next;}while(p!==outer);
 if(!m)return null;const stop=m,mx=m.x,my=m.y;let tanMin=Infinity;p=m;
 do{if(hx>=p.x&&p.x>=mx&&hx!==p.x&&inTri(hy<my?hx:qx,hy,mx,my,hy<my?qx:hx,hy,p.x,p.y)){const tan=Math.abs(hy-p.y)/(hx-p.x);
   if(locIn(p,hole)&&(tan<tanMin||(tan===tanMin&&(p.x>m.x||(p.x===m.x&&area(m.prev,m,p.prev)<0&&area(p.next,m,m.next)<0))))){m=p;tanMin=tan;}}p=p.next;}while(p!==stop);return m;}
function leftmost(s){let p=s,l=s;do{if(p.x<l.x||(p.x===l.x&&p.y<l.y))l=p;p=p.next;}while(p!==s);return l;}
const inTri=(ax,ay,bx,by,cx,cy,px,py)=>(cx-px)*(ay-py)>=(ax-px)*(cy-py)&&(ax-px)*(by-py)>=(bx-px)*(ay-py)&&(bx-px)*(cy-py)>=(cx-px)*(by-py);
function validDiag(a,b){return a.next.i!==b.i&&a.prev.i!==b.i&&!intersectsPoly(a,b)&&(locIn(a,b)&&locIn(b,a)&&midIn(a,b)&&(area(a.prev,a,b.prev)||area(a,b.prev,b))||eq(a,b)&&area(a.prev,a,a.next)>0&&area(b.prev,b,b.next)>0);}
const sgn=n=>n>0?1:n<0?-1:0;
const onSeg=(p,q,r)=>q.x<=Math.max(p.x,r.x)&&q.x>=Math.min(p.x,r.x)&&q.y<=Math.max(p.y,r.y)&&q.y>=Math.min(p.y,r.y);
function intersects(p1,q1,p2,q2){const o1=sgn(area(p1,q1,p2)),o2=sgn(area(p1,q1,q2)),o3=sgn(area(p2,q2,p1)),o4=sgn(area(p2,q2,q1));
 return (o1!==o2&&o3!==o4)||(o1===0&&onSeg(p1,p2,q1))||(o2===0&&onSeg(p1,q2,q1))||(o3===0&&onSeg(p2,p1,q2))||(o4===0&&onSeg(p2,q1,q2));}
function intersectsPoly(a,b){let p=a;do{if(p.i!==a.i&&p.next.i!==a.i&&p.i!==b.i&&p.next.i!==b.i&&intersects(p,p.next,a,b))return true;p=p.next;}while(p!==a);return false;}
const locIn=(a,b)=>area(a.prev,a,a.next)<0?area(a,b,a.next)>=0&&area(a,a.prev,b)>=0:area(a,b,a.prev)<0||area(a,a.next,b)<0;
function midIn(a,b){let p=a,inside=false;const px=(a.x+b.x)/2,py=(a.y+b.y)/2;do{if(((p.y>py)!==(p.next.y>py))&&p.next.y!==p.y&&(px<(p.next.x-p.x)*(py-p.y)/(p.next.y-p.y)+p.x))inside=!inside;p=p.next;}while(p!==a);return inside;}
function splitPoly(a,b){const a2=new EN(a.i,a.x,a.y),b2=new EN(b.i,b.x,b.y),an=a.next,bp=b.prev;a.next=b;b.prev=a;a2.next=an;an.prev=a2;b2.next=a2;a2.prev=b2;bp.next=b2;b2.prev=bp;return b2;}

// Flat (non-indexed) polygon in the XY plane, facing +Z
export function shapeGeometry(shape,div=12){const {shape:c,holes}=shape.extractPoints(div);let outer=c.slice(),hs=holes.map(h=>h.slice());
 if(!isClockWise(outer))outer.reverse();hs=hs.map(h=>isClockWise(h)?h.reverse():h);   // outer clockwise, holes counter-clockwise: triangles then face +Z
 const faces=triangulateShape(outer,hs),all=[...outer,...hs.flat()],P=[];for(const p of all)P.push(p.x,p.y,0);const g=build(P,all.map(()=>[0,0,1]).flat(),null,faces.flat());return g;}

// Extrusion of a 2D shape along +Z with an optional rounded bevel (flat-shaded, non-indexed)
export function extrudeGeometry(shape,{depth=1,steps=1,bevelEnabled=true,bevelThickness=.2,bevelSize=bevelThickness-.1,bevelOffset=0,bevelSegments=3,curveSegments=12}={}){
 const ex=shape.extractPoints(curveSegments);let contour=ex.shape.slice(),holes=ex.holes.map(h=>h.slice());dropDupEnd(contour);holes.forEach(dropDupEnd);
 if(!isClockWise(contour)){contour.reverse();holes=holes.map(h=>isClockWise(h)?h.reverse():h);}
 if(!bevelEnabled){bevelSegments=0;bevelThickness=0;bevelSize=0;bevelOffset=0;}
 const faces=triangulateShape(contour,holes),verts=[...contour,...holes.flat()],vlen=verts.length,flen=faces.length,layers=[];
 const bevelVec=(pt,prev,next)=>{const vx=pt.x-prev.x,vy=pt.y-prev.y,nx=next.x-pt.x,ny=next.y-pt.y,v2=vx*vx+vy*vy,cross=vx*ny-vy*nx;let tx,ty,sh;
  if(Math.abs(cross)>Number.EPSILON){const lv=Math.sqrt(v2),ln=Math.sqrt(nx*nx+ny*ny),px=prev.x-vy/lv,py=prev.y+vx/lv,qx=next.x-ny/ln,qy=next.y+nx/ln,s=((qx-px)*ny-(qy-py)*nx)/(vx*ny-vy*nx);
   tx=px+vx*s-pt.x;ty=py+vy*s-pt.y;const l2=tx*tx+ty*ty;if(l2<=2)return {x:tx,y:ty};sh=Math.sqrt(l2/2);}
  else{let dir=false;if(vx>Number.EPSILON){if(nx>Number.EPSILON)dir=true;}else if(vx<-Number.EPSILON){if(nx<-Number.EPSILON)dir=true;}else if(Math.sign(vy)===Math.sign(ny))dir=true;
   if(dir){tx=-vy;ty=vx;sh=Math.sqrt(v2);}else{tx=vx;ty=vy;sh=Math.sqrt(v2/2);}}
  return {x:tx/sh,y:ty/sh};};
 const moves=pts=>pts.map((p,i)=>bevelVec(p,pts[(i-1+pts.length)%pts.length],pts[(i+1)%pts.length]));
 const cm=moves(contour),hm=holes.map(moves);
 const layer=(bs,z)=>{const L=[];contour.forEach((p,i)=>L.push(p.x+cm[i].x*bs,p.y+cm[i].y*bs,z));holes.forEach((h,k)=>h.forEach((p,i)=>L.push(p.x+hm[k][i].x*bs,p.y+hm[k][i].y*bs,z)));layers.push(L);};
 for(let b=0;b<bevelSegments;b++){const t=b/bevelSegments;layer(bevelSize*Math.sin(t*Math.PI/2)+bevelOffset,-bevelThickness*Math.cos(t*Math.PI/2));}
 const bs=bevelSize+bevelOffset;for(let s=0;s<=steps;s++)layer(bs,depth/steps*s);
 for(let b=bevelSegments-1;b>=0;b--){const t=b/bevelSegments;layer(bevelSize*Math.sin(t*Math.PI/2)+bevelOffset,depth+bevelThickness*Math.cos(t*Math.PI/2));}
 const P=[],v=(L,i)=>P.push(L[i*3],L[i*3+1],L[i*3+2]);const first=layers[0],last=layers[layers.length-1];
 for(let f=0;f<flen;f++){const [a,b,c]=faces[f];v(first,c);v(first,b);v(first,a);}   // bottom cap (faces -Z)
 for(let f=0;f<flen;f++){const [a,b,c]=faces[f];v(last,a);v(last,b);v(last,c);}
 const side=(start,len)=>{for(let j=0;j<len;j++){let k=j-1;if(k<0)k=len-1;for(let s=0;s<layers.length-1;s++){const A=layers[s],B=layers[s+1],a=start+j,b=start+k;v(A,a);v(A,b);v(B,a);v(A,b);v(B,b);v(B,a);}}};
 side(0,contour.length);let o=contour.length;for(const h of holes){side(o,h.length);o+=h.length;}
 const g=build(P,null,null,null);g.computeVertexNormals();return g;}
