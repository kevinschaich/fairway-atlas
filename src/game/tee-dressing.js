// Tee-box meshes: glossy sphere tee markers and the divots between them (data: tee-divots.js).
// Divots are ground-hugging decals with torn, alpha-tested edges and bowl-shaped normals, so the sun-facing wall of a
// scrape lights up and the far wall falls into shade as the sun moves. Three kinds: open (bare soil, torn root mat at the
// rim), sand (filled with sand/seed mix, slightly crowned) and healed (patchy regrowth). One draw call for all divots.
import {Group,Mesh,Material,Texture,Geometry,f32,sphereGeometry} from './core/index.js';
import {visibleGroundHeight,CUTS} from './ground-contact.js';
import {TEE_COLORS} from './tee-sets.js';
export const MARKER_R=.06;   // 12 cm glossy ball marker
const MEAN=[92,80,58],CELL=256,COLS=4,ROWS=3,KIND_ROW={open:0,sand:1,healed:2};
function hash(x,y){const s=Math.sin(x*127.1+y*311.7)*43758.5453;return s-Math.floor(s);}
function vnoise(x,y){const i=Math.floor(x),j=Math.floor(y),u=x-i,v=y-j,a=hash(i,j),b=hash(i+1,j),c=hash(i,j+1),d=hash(i+1,j+1),su=u*u*(3-2*u),sv=v*v*(3-2*v);return a+(b-a)*su+(c-a)*sv+(a-b-c+d)*su*sv;}
const fbm=(x,y)=>vnoise(x,y)*.5+vnoise(x*2.1,y*2.1)*.3+vnoise(x*4.3,y*4.3)*.2;
function atlas(){const c=document.createElement('canvas');c.width=CELL*COLS;c.height=CELL*ROWS;const g=c.getContext('2d'),img=g.createImageData(c.width,c.height),D=img.data;
 const col={open:[[46,35,24],[70,54,36],[96,86,58]],sand:[[120,108,80],[142,130,98],[58,80,38]],healed:[[70,80,40],[60,48,32],[92,98,52]]};
 for(const [kind,row] of Object.entries(KIND_ROW))for(let vi=0;vi<COLS;vi++){const [c0,c1,c2]=col[kind],sd=vi*17.3+row*5.1;
  for(let y=0;y<CELL;y++)for(let x=0;x<CELL;x++){const u=(x+.5)/CELL*2-1,v=(y+.5)/CELL*2-1;   // u along the scrape (-1 back, +1 front), v across
   const ang=Math.atan2(v,u),rag=.66+.22*fbm(Math.cos(ang)*3+sd,Math.sin(ang)*3+sd)+.14*vnoise(ang*11+sd,sd)+.1*vnoise(ang*26+sd,sd*1.3)+.07*vnoise(ang*57+sd,sd*1.7)-(u>.3?.1*(u-.3):0);   // ragged torn edge, tapered toe
   const r=Math.hypot(u,v*1.02)/rag;const k=((y+row*CELL)*c.width+x+vi*CELL)*4;
   if(r>=1){D[k+3]=0;continue;}
   const n=fbm(x*.09+sd,y*.09),grain=vnoise(x*.6+sd,y*.6),rim=Math.max(0,Math.min(1,(r-.78)/.2));let p;
   if(kind==='open'){p=c0.map((a,i)=>a+(c1[i]-a)*(n*.7+grain*.3));p=p.map((a,i)=>a+(c2[i]-a)*rim*(.5+.5*grain));   // soil, torn thatch at the rim
    if(vnoise(x*.35+sd,y*.35)>.82&&r<.8)p=p.map(a=>a*.7);}   // clods
   else if(kind==='sand'){p=c1.map((a,i)=>a+(c0[i]-a)*n*.6);if(hash(x+sd,y)>.93)p=c2.slice();if(hash(x,y+sd)>.985)p=[110,118,64];p=p.map((a,i)=>a+([92,78,52][i]-a)*rim*.7);}
   else{const gr=fbm(x*.05+sd,y*.05+3)>.5;p=(gr?c0:c1).map((a,i)=>a+(c2[i]-a)*grain*.4);p=p.map((a,i)=>a+(c1[i]-a)*rim*.3);}
   p=p.map((a,i)=>MEAN[i]+(a-MEAN[i])*.4);   // 60% less colour variation, across kinds and within each scrape
   D[k]=p[0];D[k+1]=p[1];D[k+2]=p[2];D[k+3]=255;}}
 g.putImageData(img,0,0);return c;}
function markerMesh(color){const m=new Mesh(sphereGeometry(MARKER_R,48,24),new Material({color,roughness:.28,clearcoat:1}));m.castShadow=true;return m;}

let ATLAS=null;const atlasTex=()=>ATLAS??=new Texture(atlas());
const divotMaterial=()=>new Material({map:atlasTex(),alphaTest:.5,roughness:.95,special:'divot'});
// Ground-hugging decal geometry for a set of divots. origin: subtracted from positions (a single divot's own mesh).
function divotGeometry(divots,H,origin={x:0,y:0,z:0}){
 const lift=.002,P=[],N=[],U=[],I=[],NU=8,NV=6;
 for(const d of divots){const c=Math.cos(d.angle),s=Math.sin(d.angle),row=KIND_ROW.open,cell=d.variant??0,depth=d.depth,a=d.length,b=d.width,base=P.length/3;
  for(let j=0;j<=NV;j++)for(let i=0;i<=NU;i++){const u=i/NU*2-1,v=j/NV*2-1,lu=u*a,lv=v*b,x=d.x+lu*c-lv*s,z=d.z+lu*s+lv*c;
   // virtual bowl z(u,v) = -depth*(1-(u/a)^2-(v/b)^2): the scrape is dug below the turf; its normal comes from the bowl's slope
   const q=Math.max(0,1-u*u-v*v),dzdu=q>0?2*depth*lu/(a*a):0,dzdv=q>0?2*depth*lv/(b*b):0,nx=-(dzdu*c-dzdv*s),nz=-(dzdu*s+dzdv*c),l=Math.hypot(nx,1,nz);
   P.push(x-origin.x,H(x,z)+lift-origin.y,z-origin.z);N.push(nx/l,1/l,nz/l);U.push((cell+(u*.5+.5))/COLS,(row+(v*.5+.5))/ROWS);}
  for(let j=0;j<NV;j++)for(let i=0;i<NU;i++){const k=base+j*(NU+1)+i;I.push(k,k+NU+1,k+1,k+1,k+NU+1,k+NU+2);}}
 const geo=new Geometry();geo.setAttribute('position',f32(P,3));geo.setAttribute('normal',f32(N,3));geo.setAttribute('uv',f32(U,2));geo.setIndex(I);return geo;}
// A fresh divot at impact: pivots at its back edge (the ball) and grows toward the target as the club passes through.
export function createSwingDivot(terrainGeometry,x,z,angle,seed=Math.random()){
 const H=(px,pz)=>visibleGroundHeight(terrainGeometry,px,pz),d={x:0,z:0,angle:0,length:.06+seed*.035,width:.024+seed*.01,depth:.018+seed*.012,variant:Math.floor(seed*4)%4};
 // built along +x from the back edge; heights sampled in world space along the real heading
 const c=Math.cos(angle),s=Math.sin(angle),y0=H(x,z),Hl=(lx,lz)=>H(x+lx*c-lz*s,z+lx*s+lz*c)-y0;d.x=d.length;
 const geo=divotGeometry([d],Hl);const m=new Mesh(geo,divotMaterial());m.position.set(x,y0,z);m.rotation.y=-angle;m.scale.x=.001;m.userData.divot={...d,born:null};return m;}
export function createTeeDressing(divots,terrainGeometry,world,{markerColor='#1d4fc4'}={}){
 const g=new Group(),H=(x,z)=>visibleGroundHeight(terrainGeometry,x,z);
 for(const mk of divots.markers||[])if(mk.color)for(const p of [mk.left,mk.right]){const m=markerMesh(TEE_COLORS[mk.color]);m.position.set(p.x,H(p.x,p.z)+MARKER_R*.78,p.z);g.add(m);}   // pressed ~1 cm into the turf
 if(!divots.length||typeof document==='undefined')return g;
 const mesh=new Mesh(divotGeometry(divots,H),divotMaterial());g.add(mesh);
 return g;}
