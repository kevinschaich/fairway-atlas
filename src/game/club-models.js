import {Vec3,Mat4,Color,Shape,Path,CatmullRom3,Geometry,f32,Group,Mesh,LineSegments,Material,extrudeGeometry,sphereGeometry,boxGeometry,cylinderGeometry,tubeGeometry} from './core/index.js';
import {clubs} from './engine.js';
import {BALL_RADIUS as R} from './ball-physics.js';
// Address coordinates: ball center (0,R,0), target -Z. Every face is tangent
// to the same ball with 4 mm of address clearance. Dimensions are metres.
// Styled after a modern blacked-out bag: flat-top carbon-crown woods with a gunmetal face
// band and orange sight line, black PVD irons with long curved hosels, satin-faced wedges,
// a half-moon mallet putter, graphite/steel shafts and black wrap grips. No logos.
const M={
 chrome:()=>new Material({color:'#d9dde0',metalness:1,roughness:.1}),
 satin:()=>new Material({color:'#c6cbce',metalness:1,roughness:.3,special:'brushed'}),
 milled:()=>new Material({color:'#c3c8cc',metalness:1,roughness:.42,special:'milled'}),
 gunFace:()=>new Material({color:'#4a4f53',metalness:1,roughness:.34,special:'milled'}),
 gun:()=>new Material({color:'#6c7176',metalness:1,roughness:.3,special:'brushed'}),
 pvd:()=>new Material({color:'#141618',metalness:.85,roughness:.28}),
 pvdGloss:()=>new Material({color:'#0d0f10',metalness:.2,roughness:.3,clearcoat:.9}),
 carbon:()=>new Material({color:'#23262a',roughness:.42,clearcoat:1,special:'carbon'}),
 silver:()=>new Material({color:'#b8bdc0',metalness:1,roughness:.24,special:'brushed'}),
 matte:()=>new Material({color:'#141617',metalness:.1,roughness:.55,clearcoat:.25}),
 red:()=>new Material({color:'#c42a1c',roughness:.4,clearcoat:.6}),
 white:()=>new Material({color:'#e8eaea',roughness:.45,clearcoat:.5}),
};
function ironOutline(W,b,t,wedge){
 const s=new Shape(),h=t-b,hl=b+h*(wedge?.66:.6);
 s.moveTo(-W/2+.008,b);
 s.bezierCurveTo(-W/2*.2,b-.0008,W/2*.45,b-.0008,W/2-(wedge?.024:.02),b+.001);   // soft cambered leading edge
 s.bezierCurveTo(W/2+.005,b+h*.06,W/2+.006,t-h*(wedge?.12:.06),W/2-(wedge?.02:.018),t); // round toe
 s.bezierCurveTo(W/2-.03,t-.0015,-W/2+.035,hl+h*.035,-W/2+.012,hl);                          // gently crowned top line
 s.bezierCurveTo(-W/2+.002,hl-h*.05,-W/2-.001,b+h*.22,-W/2+.001,b+.008);                  // heel
 s.quadraticCurveTo(-W/2+.002,b,-W/2+.008,b);
 return s;
}
function muscleOutline(W,b,t,wedge){
 const s=new Shape(),h=t-b;
 const i=.0055;s.moveTo(-W/2+.01+i,b+i);s.lineTo(W/2-.02-i,b+i);
 s.quadraticCurveTo(W/2-.006-i,b+h*.14,W/2-.012-i,b+h*(wedge?.3:.38)-i);
 s.lineTo(-W/2+.012+i,b+h*(wedge?.22:.26)-i);s.closePath();return s;
}
function extrude(shape,depth,bevel,from=0,seg=4){
 const g=extrudeGeometry(shape,{depth,bevelEnabled:true,bevelSize:bevel,bevelThickness:bevel,bevelSegments:seg,curveSegments:48,steps:1});g.computeVertexNormals();
 g.translate(0,0,from+bevel);return g;
}
// Hollow wood: a sphere pushed into a flat-topped pear with a flat lofted face; vertex colours carry the carbon crown,
// gunmetal band, face and sole.
function woodBody(W,D,H,loft,contact,hybrid){
 const geo=sphereGeometry(1,192,112),pos=geo.attributes.position,col=[],carbon=[],uvw=[],tl=Math.tan(loft);
 const face=new Color('#62676b'),band=new Color('#44494c'),crown=new Color('#0c0e0f'),sole=new Color('#55595c'),c=new Color();
 for(let i=0;i<pos.count;i++){const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
  const tx=(x+1)/2,flat=z< -.22,zf=Math.max(z,-.22),back=(zf+.22)/1.22;
  const widen=hybrid?(.78+.3*Math.sin(back*Math.PI*.85)):(.86+.2*Math.sin(back*Math.PI*.8));
  const px=x*W/2*widen+W*(hybrid?.06:.04)*back*back+W*.05*(1-tx)*(1-back);
  const toe=.62+.38*Math.pow(tx,.7),up=y>0,py=up?Math.pow(y,flat?.3:.5)*H*toe*(1-.55*Math.pow(back,1.9))*(flat?.96:1):-Math.pow(Math.min(1,-y*1.6),1.4)*H*.14*(.6+.4*tx);
  const yy=H*.16+py;
  pos.setXYZ(i,px,yy,contact.z+(yy-contact.y)*tl+back*D);
  let k=0;if(flat)c.copy(face);else if(up&&y>.08){c.copy(crown);k=1}else c.copy(sole);
  // weave weight (colour alpha): the crown's front band and its edges fade to plain gloss black, so zone edges never show the mesh
  const wv=k?Math.min(1,Math.max(0,(back-.12)/.1))*Math.min(1,Math.max(0,(y-.08)/.25)):0;
  col.push(c.r,c.g,c.b,wv);carbon.push(k);uvw.push(px,contact.z+(yy-contact.y)*tl+back*D);}   // uv: top-down plan position (m), so the weave doesn't pinch at the sphere's poles
 geo.computeVertexNormals();geo.setAttribute('color',f32(col,4));geo.setAttribute('uv',f32(uvw,2));
 // one mesh per finish, sharing the vertex buffers: carbon crown (clear-coated weave), gloss band, milled face, satin sole
 const zone=new Uint8Array(pos.count);for(let i=0;i<pos.count;i++){zone[i]=carbon[i]?0:Math.abs(col[i*4]-face.r)<1e-6&&Math.abs(col[i*4+1]-face.g)<1e-6?2:3;}
 const idx=geo.index.array,parts=[[],[],[],[]];for(let t=0;t<idx.length;t+=3){const a=idx[t],b=idx[t+1],cc=idx[t+2];const z=zone[a]===2||zone[b]===2||zone[cc]===2?(zone[a]===2&&zone[b]===2&&zone[cc]===2?2:(zone[a]!==2?zone[a]:zone[b]!==2?zone[b]:zone[cc])):zone[a]===zone[b]?zone[a]:zone[cc];parts[z].push(a,b,cc);}
 const mats=[M.carbon(),M.pvdGloss(),M.gunFace(),hybrid?M.silver():M.gun()],g=new Group();
 parts.forEach((ix,k)=>{if(!ix.length)return;const sub=new Geometry();for(const [n,a] of Object.entries(geo.attributes))sub.setAttribute(n,a);sub.setIndex(ix);const m=new Mesh(sub,mats[k]);m.castShadow=true;g.add(m);});
 return g;
}
export function createClub(index){
 const spec=clubs[index],g=new Group(),head=new Group();g.add(head);
 const loft=spec.loft*Math.PI/180,n=new Vec3(0,Math.sin(loft),-Math.cos(loft)),up=new Vec3(0,Math.cos(loft),Math.sin(loft));
 const contact=new Vec3(0,R,0).addScaledVector(n,-R-.004),type=spec.type;
 const wood=type==='driver'||type==='wood'||type==='hybrid',putter=type==='putter',wedge=type==='wedge',hybrid=type==='hybrid';
 const width=type==='driver'?.116:type==='wood'?.098:hybrid?.088:putter?.106:wedge?.084:.08;
 const bottom=-Math.min(.012,(contact.y-.002)/Math.cos(loft)),top=type==='driver'?.036:type==='wood'?.022:hybrid?.02:putter?.012:wedge?.044:.036;
 const frame=new Mat4().makeBasis(new Vec3(1,0,0),up,n.clone().negate()).setPosition(contact);
 const frameBack=new Mat4().makeBasis(new Vec3(1,0,0),up,new Vec3(0,-Math.sin(loft)*.25,1).normalize()).setPosition(contact);
 const toWorld=(x,y,z)=>new Vec3(x,y,z).applyMatrix4(frame);
 const add=(geo,mat)=>{const m=new Mesh(geo,mat);m.castShadow=true;head.add(m);return m};
 let hosel,neckStart=null,neckR0=null;
 if(wood){
  const D=type==='driver'?.112:type==='wood'?.086:.07,H=type==='driver'?.054:type==='wood'?.032:.031;
  head.add(woodBody(width,D,H,loft,contact,hybrid));
  const sight=add(boxGeometry(hybrid?.006:.012,.0012,.0022),M.red());const sy=H*.16+H*.93;sight.position.set(0,sy,contact.z+(sy-contact.y)*Math.tan(loft)+.013);
  hosel=new Vec3(-width*.44,H*.72,contact.z+.016);neckStart=new Vec3(-width*.26,H*.34,contact.z+.03);neckR0=[.019,.014];
 }else if(putter){
  // Fang mallet (Ai-Dual Seven style): face bar with a milled insert, two prongs running back with white sight lines,
  // single-bend neck.
  const W=width,Hh=.022,P=.03,L=.088;
  const s=new Shape();s.moveTo(-W/2,0);s.lineTo(W/2,0);s.lineTo(W/2,L-.014);s.quadraticCurveTo(W/2,L,W/2-.014,L);s.lineTo(W/2-P,L);s.lineTo(W/2-P-.004,.024);
  s.lineTo(-W/2+P+.004,.024);s.lineTo(-W/2+P,L);s.lineTo(-W/2+.014,L);s.quadraticCurveTo(-W/2,L,-W/2,L-.014);s.lineTo(-W/2,0);
  const body=extrude(s,Hh-.004,.002,0,4);body.rotateX(Math.PI/2);body.translate(0,.002+Hh,contact.z+.001);add(body,M.pvdGloss());
  const plate=new Shape();const y0=.004-contact.y,y1=Hh-contact.y;plate.moveTo(-W/2+.006,y0);plate.lineTo(W/2-.006,y0);plate.lineTo(W/2-.006,y1);plate.lineTo(-W/2+.006,y1);plate.closePath();
  add(extrude(plate,.0015,.0006).applyMatrix4(frame),M.gunFace());
  const top=.002+Hh+.0004;
  for(const x of [-W/2+P/2,W/2-P/2]){const l=add(boxGeometry(.0022,.0006,L-.03),M.white());l.position.set(x,top,contact.z+.001+(L+.02)/2);}
  const c=add(boxGeometry(.0018,.0006,.012),M.white());c.position.set(0,top,contact.z+.012);
  const base=new Vec3(-W*.1,.002+Hh,contact.z+.012),bend=base.clone().add(new Vec3(-.006,.03,0));
  const neck=tubeGeometry(new CatmullRom3([base,base.clone().add(new Vec3(0,.014,0)),bend]),20,.0048,20);add(neck,M.pvdGloss());
  hosel=bend.clone();
 }else{
  const W=width,b=bottom,t=top,faceMat=M.milled();
  add(extrude(ironOutline(W,b,t,wedge),.0012,.0006).applyMatrix4(frame),faceMat);// milled face plate
  add(extrude(ironOutline(W,b,t,wedge),wedge?.0052:.0042,.0026,.0012,8).applyMatrix4(frame),wedge?M.satin():M.chrome());   // Quantum-style polished chrome; Opus-style satin wedges
  add(extrude(muscleOutline(W,b,t,wedge),wedge?.007:.009,.0045,.005,8).applyMatrix4(frameBack),wedge?M.satin():M.pvdGloss());   // irons: black cavity badge
  hosel=toWorld(-W/2-.001,b+(t-b)*.62,.005);neckStart=toWorld(-W/2+.014,b+(t-b)*.22,.006);neckR0=[.0095,.0075];
 }
 // Score lines; the leading-edge line is painted red on irons and wedges.
 if(!putter){const grooves=[],gw=wood?width*.24:width*.34,top2=wood?Math.min(top,type==='driver'?.026:.014):bottom+(top-bottom)*(wedge?.66:.6),step=wood?.0045:.0034;let first=null;
  for(let y=bottom+(wood?.01:.005);y<top2;y+=step){const a=contact.clone().addScaledVector(up,y).addScaledVector(n,.0004),c=a.clone(),f=(y-bottom)/(top-bottom);a.x=wood?-gw:-width/2+.012+f*.004;c.x=wood?gw:Math.min(width/2-.014,width/2-.014-(f-.35)*width*.55);if(c.x<a.x+.01)continue;if(!first&&!wood){first=[a,c];continue}grooves.push(a,c)}
  if(first)grooves.unshift(...first);
  head.add(new LineSegments(new Geometry().setFromPoints(grooves),new Material({kind:'unlit',color:wedge?'#2a2e30':wood?'#3b4043':'#050607'})));}
 const handle=hosel.clone().add(new Vec3(-spec.length*.38,spec.length*.925,.025)),dir=handle.clone().sub(hosel).normalize();
 function tube(a,b,r1,r2,mat){const mesh=new Mesh(cylinderGeometry(r2,r1,a.distanceTo(b),24),mat);mesh.position.copy(a).add(b).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(new Vec3(0,1,0),b.clone().sub(a).normalize());mesh.castShadow=true;g.add(mesh);return mesh;}
 const shaftMat=wood?new Material({color:'#16181b',roughness:.3,clearcoat:.9}):new Material({color:'#dfe2e4',metalness:1,roughness:.09});   // graphite in the woods, chrome steel in the irons
 let hTop=hosel;
 if(!putter){
  // Swept neck: a spline that starts buried in the heel and leaves tangent to the shaft line.
  // Its elliptical section eases from the head's thickness down to exactly the shaft radius,
  // so body, hosel and shaft read as one continuous piece of metal.
  const L=wood?.05:.07,rEnd=wood?.0072:.0062,end=hosel.clone().addScaledVector(dir,L);
  const curve=new CatmullRom3([neckStart,neckStart.clone().lerp(hosel,.6),hosel,hosel.clone().addScaledVector(dir,L*.5),end],false,'centripetal');
  const SEG=64,RAD=36,fr=curve.computeFrenetFrames(SEG,false),pos=[],idx=[];
  for(let i=0;i<=SEG;i++){const u=i/SEG,p=curve.getPointAt(u),e=u<1?1-Math.pow(1-Math.min(1,u*1.35),3):1,rx=neckR0[0]+(rEnd-neckR0[0])*e,ry=neckR0[1]+(rEnd-neckR0[1])*e,N=fr.normals[i],B=fr.binormals[i];
   for(let j=0;j<=RAD;j++){const a=j/RAD*Math.PI*2;pos.push(p.x+N.x*Math.cos(a)*rx+B.x*Math.sin(a)*ry,p.y+N.y*Math.cos(a)*rx+B.y*Math.sin(a)*ry,p.z+N.z*Math.cos(a)*rx+B.z*Math.sin(a)*ry)}}
  for(let i=0;i<SEG;i++)for(let j=0;j<RAD;j++){const a=i*(RAD+1)+j,b=a+RAD+1;idx.push(a,b,a+1,a+1,b,b+1)}
  const ng=new Geometry();ng.setAttribute('position',f32(pos,3));ng.setIndex(idx);ng.computeVertexNormals();
  const neck=new Mesh(ng,wood?M.pvdGloss():wedge?M.satin():M.chrome());neck.castShadow=true;head.add(neck);
  hTop=end;
 }
 if(wood){// adapter sleeve with red/white index marks, then graphite
  const sleeveEnd=hTop.clone().addScaledVector(dir,.03);tube(hTop,sleeveEnd,.0072,.0066,M.matte());
  for(const [k,mat] of [[.3,M.red()],[.6,M.white()]]){const a=hTop.clone().lerp(sleeveEnd,k);tube(a,a.clone().addScaledVector(dir,.0022),.0073,.0073,mat)}
  tube(sleeveEnd,handle,.0048,.0064,shaftMat);tube(sleeveEnd,sleeveEnd.clone().addScaledVector(dir,.012),.0066,.0048,M.matte());
 }else if(!putter){tube(hTop,hTop.clone().addScaledVector(dir,.014),.0062,.0047,M.matte());tube(hTop,handle,.0047,.0066,shaftMat);}
 else tube(hTop,handle,.0045,.0048,shaftMat);
 // Wrap grip: black, dimpled bands, white rings under the cap and at the grip's lower end.
 const gripStart=handle.clone().lerp(hosel,.26),rubber=new Material({color:'#101213',roughness:.7});
 tube(gripStart,handle,.0108,.0142,rubber);
 for(let j=0;j<16;j++){const a=gripStart.clone().lerp(handle,j/16),c=gripStart.clone().lerp(handle,(j+.12)/16);tube(a,c,.0112+j*.0002,.0112+j*.0002,new Material({color:'#060707',roughness:.5}))}
 for(const k of [.035,.05]){const a=handle.clone().lerp(gripStart,k);tube(a,a.clone().addScaledVector(dir,-.0015),.0144,.0144,M.white())}
 {const a=gripStart.clone().lerp(handle,.03);tube(a,a.clone().addScaledVector(dir,.0015),.0112,.0112,M.white())}
 g.userData={type:spec.type,contact:contact.toArray(),normal:n.toArray(),hand:handle.toArray(),ballCenter:[0,R,0],clearance:.004,length:spec.length};
 return g;
}
