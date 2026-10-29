import {Vec3,Group,Mesh,Material,circleGeometry} from './core/index.js';
import {CUP_RADIUS,CUP_DEPTH,BALL_RADIUS,groundNormal} from './ball-physics.js';
// The cup. The green is not cut, so the hole is drawn as a disc on the surface whose shader looks *into* a virtual cylinder
// (interior mapping, MESH special 'cup'): white plastic liner at the top, soil wall and floor below, sunlight entering only
// where the opening lets it in, sky light fading with depth, and the flagstick and a holed ball traced inside it.
export function cupMesh(world){const g=new Group();
 const geo=circleGeometry(CUP_RADIUS*1.004,64);
 const mat=new Material({color:'#ffffff',roughness:.9,special:'cup'});mat.ext=new Float32Array(16);
 const disc=new Mesh(geo,mat);disc.rotation.x=-Math.PI/2;disc.position.y=.0015;disc.castShadow=false;g.add(disc);
 const n=groundNormal(world,world.pin.x,world.pin.z);g.quaternion.setFromUnitVectors(new Vec3(0,1,0),new Vec3(n.x,n.y,n.z));
 g.userData.update=(ball,poleIn)=>{const e=mat.ext,p=g.parent?g.parent.position:{x:world.pin.x,y:0,z:world.pin.z};
  e[5]=p.x;e[6]=p.y;e[7]=p.z;e[8]=CUP_RADIUS;e[9]=CUP_DEPTH;e[10]=poleIn?.0095:0;
  const inside=ball&&ball.visible!==false&&Math.hypot(ball.position.x-p.x,ball.position.z-p.z)<CUP_RADIUS+BALL_RADIUS&&ball.position.y<p.y+BALL_RADIUS;
  e[1]=ball?.position.x??0;e[2]=ball?.position.y??0;e[3]=ball?.position.z??0;e[4]=inside?BALL_RADIUS:0;};
 return g;}
