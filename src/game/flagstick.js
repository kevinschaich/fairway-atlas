// Flagstick and flag. The stick is polished stainless (the hero-object shader reflects sky above, turf below) with a
// black ferrule where it enters the cup and a domed top cap. The flag is a cloth sheet animated every frame:
// travelling waves run from the pole to the fly end, growing toward the free edge, faster and tighter as the wind rises;
// in a light breeze it hangs and sways. Normals are rebuilt from the moving sheet, so folds catch and lose the light.
import {Group,Mesh,Material,planeGeometry,cylinderGeometry,sphereGeometry} from './core/index.js';
export const STICK_H=2.3,FLAG_W=.5,FLAG_H=.35;
export function createFlagstick(color='#e9ac58'){
 const g=new Group();
 const steel=new Material({color:'#dfe3e6',metalness:1,roughness:.07});
 const pole=new Group(),rod=new Mesh(cylinderGeometry(.0085,.0095,STICK_H,32),steel);rod.position.y=STICK_H/2;
 const cap=new Mesh(sphereGeometry(.0125,24,12),steel);cap.position.y=STICK_H+.004;
 const ferrule=new Mesh(cylinderGeometry(.0105,.0105,.07,24),new Material({color:'#0c0d0e',metalness:.3,roughness:.35,clearcoat:.6}));ferrule.position.y=.035;
 const band=new Mesh(cylinderGeometry(.0097,.0097,.012,24),new Material({color:'#0c0d0e',roughness:.4,clearcoat:.5}));band.position.y=STICK_H-.03;   // grommet ring the flag's top tie sits against
 for(const m of [rod,cap,ferrule,band])m.castShadow=true;pole.add(rod,cap,ferrule,band);
 const WS=32,HS=12,geo=planeGeometry(FLAG_W,FLAG_H,WS,HS);geo.translate(FLAG_W/2+.011,0,0);
 const rest=geo.attributes.position.array.slice();
 const cloth=new Material({color,roughness:.8,special:'cloth'});
 const flag=new Mesh(geo,cloth);flag.castShadow=true;
 const sleeve=new Mesh(cylinderGeometry(.013,.013,FLAG_H+.01,20),new Material({color:'#f2f0ea',roughness:.7,special:'cloth'}));sleeve.castShadow=true;   // stitched hem around the stick
 const pivot=new Group();pivot.position.y=STICK_H-FLAG_H/2-.04;pivot.add(flag,sleeve);
 g.add(pole,pivot);
 let phase=Math.random()*10;
 // t: seconds; wind: m/s. Local frame: +x from the pole to the fly end (the pivot already points it downwind).
 function animate(t,wind,dt){const w=Math.max(0,wind),lift=Math.min(1,w/7);   // 7 m/s ~ 15 mph: the flag flies straight out
  phase+=dt*(2.2+w*1.35);const k=(5.5+w*.6)/FLAG_W,p=geo.attributes.position.array;
  for(let i=0;i<p.length;i+=3){const x=rest[i]-.011,y=rest[i+1],u=x/FLAG_W,v=y/FLAG_H+.5;
   const amp=(.012+.05*lift)*u*(.55+.45*u);
   const wave=Math.sin(k*x-phase*1.0+v*.9)*amp+Math.sin(k*1.9*x-phase*1.7+v*2.3+1.3)*amp*.35;
   // hang: the free edge drops and swings in toward the pole when the wind is light
   const droop=(1-lift)*(1-lift),ang=droop*1.22;const sx=x*Math.cos(ang),sy=-x*Math.sin(ang);
   const sway=Math.sin(phase*.4+u)*.03*u*(1-lift);
   p[i]=.011+sx*(1-.04*Math.abs(wave)/Math.max(amp,1e-4)*lift);p[i+1]=y*(1-.08*droop*u)+sy;p[i+2]=wave+sway;}
  geo.computeVertexNormals();geo.attributes.position.version++;}
 animate(0,3,0);
 return {group:g,pole,pivot,flag,animate};}
