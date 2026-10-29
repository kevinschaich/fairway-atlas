// Golf ball: ~332 spherical-cap dimples laid out on a Fibonacci sphere, baked once at load into an octahedral map of the
// ball's own directions (r = surface height, g = printed ink, b = ink colour: 0 navy, 1 red). The game name is projected onto
// that map at runtime, so the ink sits on the dimpled surface and shares its normals. The mesh is displaced by the same
// height field, so the silhouette is dimpled too. MESH shader: ballSurf() (special 'ball').
import {Mesh,Material,Texture,sphereGeometry} from './core/index.js';
import {BALL_RADIUS as R} from './ball-physics.js';
import {GAME_NAME} from './brand.js';

export const DIMPLES=332,DIMPLE_DEPTH=.00025;   // m (a typical dimple is ~0.25 mm deep, 3.5-4 mm across)
const TEX=1024;
export function dimpleCentres(n=DIMPLES){const out=[],ga=Math.PI*(3-Math.sqrt(5));
 for(let i=0;i<n;i++){const y=1-2*(i+.5)/n,r=Math.sqrt(1-y*y),a=i*ga;out.push([Math.cos(a)*r,y,Math.sin(a)*r]);}return out;}
export const octEncode=(x,y,z)=>{const s=Math.abs(x)+Math.abs(y)+Math.abs(z);let u=x/s,v=y/s;if(z/s<0){const a=u,b=v;u=(1-Math.abs(b))*(a>=0?1:-1);v=(1-Math.abs(a))*(b>=0?1:-1);}return [u*.5+.5,v*.5+.5];};
export const octDecode=(u,v)=>{let x=u*2-1,y=v*2-1;const z=1-Math.abs(x)-Math.abs(y);if(z<0){const a=x,b=y;x=(1-Math.abs(b))*(a>=0?1:-1);y=(1-Math.abs(a))*(b>=0?1:-1);}const l=Math.hypot(x,y,z);return [x/l,y/l,z/l];};

// Height (1 = land between dimples, 0 = deepest point) for every texel, plus the dimple radius table.
export function bakeHeights(size=TEX){
 const C=dimpleCentres(),n=C.length;
 // each dimple's radius: 48% of the angle to its nearest neighbour (so neighbours nearly touch, as on a real cover)
 const rad=C.map((c,i)=>{let best=9;for(let j=0;j<n;j++)if(j!==i){const a=Math.acos(Math.min(1,c[0]*C[j][0]+c[1]*C[j][1]+c[2]*C[j][2]));if(a<best)best=a;}return best*.48;});
 const CS=128,coarse=new Int16Array(CS*CS);
 for(let j=0;j<CS;j++)for(let i=0;i<CS;i++){const d=octDecode((i+.5)/CS,(j+.5)/CS);let bi=0,bd=-2;for(let k=0;k<n;k++){const c=C[k],dt=d[0]*c[0]+d[1]*c[1]+d[2]*c[2];if(dt>bd){bd=dt;bi=k;}}coarse[j*CS+i]=bi;}
 const h=new Float32Array(size*size),f=size/CS,cand=new Int16Array(9);
 for(let j=0;j<size;j++){const cj=Math.min(CS-1,Math.floor(j/f));for(let i=0;i<size;i++){const ci=Math.min(CS-1,Math.floor(i/f));let m=0;
  for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++){const x=ci+di,y=cj+dj;if(x<0||y<0||x>=CS||y>=CS)continue;const k=coarse[y*CS+x];let dup=false;for(let q=0;q<m;q++)if(cand[q]===k){dup=true;break}if(!dup)cand[m++]=k;}
  const d=octDecode((i+.5)/size,(j+.5)/size);let v=1;
  for(let q=0;q<m;q++){const k=cand[q],c=C[k],a=Math.acos(Math.min(1,d[0]*c[0]+d[1]*c[1]+d[2]*c[2])),x=a/rad[k];
   if(x<1){const dep=(1-x*x)*Math.min(1,(1-x)*7);v=Math.min(v,1-dep);}}   // spherical cap with a softly rounded lip
  h[j*size+i]=v;}}
 return {h,size,centres:C,radius:rad};}

// Ink: the name (and a red play number on the far side) drawn on a canvas and projected orthographically onto the ball.
function inkCanvas(text,w=1400,hgt=300){const c=document.createElement('canvas');c.width=w;c.height=hgt;const g=c.getContext('2d');g.fillStyle='#fff';g.textAlign='center';g.textBaseline='middle';
 let px=hgt*.62;g.font=`italic 800 ${px}px "Inter","Helvetica Neue",Arial,sans-serif`;const tw=g.measureText(text).width;if(tw>w*.96){px*=w*.96/tw;g.font=`italic 800 ${px}px "Inter","Helvetica Neue",Arial,sans-serif`;}
 g.fillText(text,w/2,hgt/2);return g.getImageData(0,0,w,hgt);}
export function bakeBallTexture(name=GAME_NAME,size=TEX){
 const {h}=bakeHeights(size);const img=new ImageData(size,size),D=img.data;
 const logo=typeof document!=='undefined'?inkCanvas(name):null,num=typeof document!=='undefined'?inkCanvas('1',300,300):null;
 const LW=1.18,LH=LW*300/1400;   // logo width across the ball (in radii); a real side stamp spans about half the diameter
 for(let j=0;j<size;j++)for(let i=0;i<size;i++){const k=j*size+i,d=octDecode((i+.5)/size,(j+.5)/size);let ink=0,red=0;
  if(logo&&d[2]>.2){const u=(d[0]/LW+.5)*logo.width,v=(-d[1]/LH+.5)*logo.height;if(u>=0&&v>=0&&u<logo.width&&v<logo.height)ink=logo.data[(Math.floor(v)*logo.width+Math.floor(u))*4+3]/255;}
  if(num&&d[2]<-.3){const s=.36,u=(-d[0]/s+.5)*num.width,v=(-d[1]/s+.5)*num.height;if(u>=0&&v>=0&&u<num.width&&v<num.height){const a=num.data[(Math.floor(v)*num.width+Math.floor(u))*4+3]/255;if(a>ink){ink=a;red=1;}}}
  D[k*4]=Math.round(h[k]*255);D[k*4+1]=Math.round(ink*255);D[k*4+2]=red*255;D[k*4+3]=255;}
 const c=document.createElement('canvas');c.width=c.height=size;c.getContext('2d').putImageData(img,0,0);return {canvas:c,heights:h,size};}

export function createGolfBall(){
 const {canvas,heights,size}=bakeBallTexture();
 const geo=sphereGeometry(R,192,96),pos=geo.attributes.position,a=pos.array;
 for(let i=0;i<pos.count;i++){const x=a[i*3]/R,y=a[i*3+1]/R,z=a[i*3+2]/R,[u,v]=octEncode(x,y,z),hh=heights[Math.min(size-1,Math.floor(v*size))*size+Math.min(size-1,Math.floor(u*size))],r=R-DIMPLE_DEPTH*(1-hh);
  a[i*3]=x*r;a[i*3+1]=y*r;a[i*3+2]=z*r;}
 pos.version=(pos.version||0)+1;
 const tex=new Texture(canvas,{colorSpace:'linear'});
 // ionomer/urethane cover: bright white, satin under a clear coat
 const mat=new Material({color:'#e4e4de',roughness:.5,clearcoat:.8,special:'ball',map:tex});
 mat.ext=new Float32Array(16);mat.ext[4]=1;   // [arc, axis xyz, dimple strength, centre xyz, radius, quat xyzw]
 const m=new Mesh(geo,mat);m.castShadow=true;return m;}

// Per frame: the ball's centre and world->object rotation, and the spin arc swept during the exposure (motion blur).
export function updateBallMaterial(ball,spinAxisWorld=null,arc=0){const e=ball.material.ext;if(!e)return;const p=ball.position,q=ball.quaternion;
 e[5]=p.x;e[6]=p.y;e[7]=p.z;e[8]=R;e[9]=-q.x;e[10]=-q.y;e[11]=-q.z;e[12]=q.w;   // inverse rotation (the ball is never parented under a rotated node)
 e[0]=arc;if(spinAxisWorld&&arc>0){const x=spinAxisWorld.x,y=spinAxisWorld.y,z=spinAxisWorld.z,qx=-q.x,qy=-q.y,qz=-q.z,qw=q.w;
  const tx=2*(qy*z-qz*y),ty=2*(qz*x-qx*z),tz=2*(qx*y-qy*x);e[1]=x+qw*tx+(qy*tz-qz*ty);e[2]=y+qw*ty+(qz*tx-qx*tz);e[3]=z+qw*tz+(qx*ty-qy*tx);}}
