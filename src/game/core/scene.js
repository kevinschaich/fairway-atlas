// Fairway Atlas engine core: scene database.
//  - Nodes hold position/quaternion/scale (+ synced Euler rotation). World matrices are recomputed only for nodes whose
//    local transform or parent changed since the last update; each change bumps node.worldVersion so the GPU side
//    re-uploads an instance transform only when it actually moved.
//  - Scene.collect() fills a flat, reused array of visible drawables (meshes, lines) in one pass with no allocations.
import {Vec3,Quat,Euler as EulerBase,Mat4,Color,MathUtils} from './math.js';

let _nid=0;
// Euler rotation tied to a node's quaternion: writes update the quaternion, reads re-derive lazily after quaternion changes
class NodeEuler extends EulerBase{
 constructor(q){super();this._q=q;this._stale=false;}
 _sync(){if(this._stale){this._stale=false;this.setFromQuaternion(this._q,false);}}
 get x(){this._sync();return this._x}set x(v){this._sync();this._x=v;this._push()}
 get y(){this._sync();return this._y}set y(v){this._sync();this._y=v;this._push()}
 get z(){this._sync();return this._z}set z(v){this._sync();this._z=v;this._push()}
 set(x,y,z){this._x=x;this._y=y;this._z=z;this._stale=false;this._push();return this;}
 _push(){this._q.setFromEuler(this,false);}
}
const _m=new Mat4(),_up=new Vec3(0,1,0),_v=new Vec3(),_q=new Quat();

export class Node{
 constructor(){this.id=++_nid;this.name='';this.type='Node';this.parent=null;this.children=[];this.visible=true;this.userData={};
  this.position=new Vec3();this.scale=new Vec3(1,1,1);this.quaternion=new Quat();this.rotation=new NodeEuler(this.quaternion);this.quaternion._cb=()=>{this.rotation._stale=true;};
  this.up=new Vec3(0,1,0);this.matrix=new Mat4();this.matrixWorld=new Mat4();this.worldVersion=0;this._trs=new Float64Array(10).fill(NaN);this.renderOrder=0;}
 add(...objs){for(const o of objs){if(!o||o===this)continue;if(o.parent)o.parent.remove(o);o.parent=this;this.children.push(o);o._trs[0]=NaN;}return this;}
 remove(...objs){for(const o of objs){const i=this.children.indexOf(o);if(i>=0){this.children.splice(i,1);o.parent=null;}}return this;}
 removeFromParent(){this.parent?.remove(this);return this;}
 clear(){for(const c of this.children)c.parent=null;this.children.length=0;return this;}
 traverse(fn){fn(this);for(const c of this.children.slice())c.traverse(fn);}
 traverseVisible(fn){if(!this.visible)return;fn(this);for(const c of this.children)c.traverseVisible(fn);}
 getObjectByName(n){if(this.name===n)return this;for(const c of this.children){const r=c.getObjectByName(n);if(r)return r;}return null;}
 updateMatrix(){this.matrix.compose(this.position,this.quaternion,this.scale);}
 // dirty-only world transform update of this subtree (assumes the parent's world matrix is current)
 updateMatrixWorld(force=false){this._world(this.parent?this.parent.matrixWorld:null,force);}
 _world(pw,force){const p=this.position,q=this.quaternion,s=this.scale,t=this._trs;let ch=force;
  if(t[0]!==p.x||t[1]!==p.y||t[2]!==p.z||t[3]!==q._x||t[4]!==q._y||t[5]!==q._z||t[6]!==q._w||t[7]!==s.x||t[8]!==s.y||t[9]!==s.z){
   t[0]=p.x;t[1]=p.y;t[2]=p.z;t[3]=q._x;t[4]=q._y;t[5]=q._z;t[6]=q._w;t[7]=s.x;t[8]=s.y;t[9]=s.z;this.matrix.compose(p,q,s);ch=true;}
  if(ch){if(pw)this.matrixWorld.multiplyMatrices(pw,this.matrix);else this.matrixWorld.copy(this.matrix);this.worldVersion++;this._onWorld?.();}
  const c=this.children;for(let i=0;i<c.length;i++)c[i]._world(this.matrixWorld,ch);}
 // ancestors first (for one-off queries on nodes whose parents may have moved)
 updateWorldMatrix(){const chain=[];for(let n=this;n;n=n.parent)chain.push(n);let pw=null;for(let i=chain.length-1;i>=0;i--){const n=chain[i];n._worldSelf(pw);pw=n.matrixWorld;}}
 _worldSelf(pw){this._trs[0]=NaN;   /* the next scene pass re-derives this node and its subtree */this.matrix.compose(this.position,this.quaternion,this.scale);if(pw)this.matrixWorld.multiplyMatrices(pw,this.matrix);else this.matrixWorld.copy(this.matrix);this.worldVersion++;this._onWorld?.();}
 getWorldPosition(v=new Vec3()){this.updateWorldMatrix();return v.setFromMatrixPosition(this.matrixWorld);}
 getWorldDirection(v=new Vec3()){this.updateWorldMatrix();const e=this.matrixWorld.elements;return v.set(e[8],e[9],e[10]).normalize();}
 _lookSign(){return 1;}
 lookAt(x,y,z){const target=typeof x==='object'?x:_v.set(x,y,z);const pos=new Vec3();if(this.parent){this.parent.updateWorldMatrix();pos.copy(this.position).applyMatrix4(this.parent.matrixWorld);}else pos.copy(this.position);
  if(this._lookSign()<0)_m.lookAt(pos,target,this.up);else _m.lookAt(target,pos,this.up);this.quaternion.setFromRotationMatrix(_m);
  if(this.parent){_m.makeRotationFromQuaternion(_q.setFromRotationMatrix(this.parent.matrixWorld));_q.invert();this.quaternion.premultiply(_q);}return this;}
 rotateOnAxis(axis,a){this.quaternion.multiply(_q.setFromAxisAngle(axis,a));return this;}
 rotateOnWorldAxis(axis,a){this.quaternion.premultiply(_q.setFromAxisAngle(axis,a));return this;}
 rotateX(a){return this.rotateOnAxis(_v.set(1,0,0),a);}rotateY(a){return this.rotateOnAxis(_v.set(0,1,0),a);}rotateZ(a){return this.rotateOnAxis(_v.set(0,0,1),a);}
 dispose(){}
}
export class Group extends Node{constructor(){super();this.type='Group';}}

export class Mesh extends Node{
 constructor(geometry,material){super();this.type='Mesh';this.isMesh=true;this.geometry=geometry;this.material=material;this.frustumCulled=true;this.castShadow=false;this.receiveShadow=false;}
}
export class InstancedMesh extends Mesh{
 constructor(geometry,material,count){super(geometry,material);this.isInstancedMesh=true;this.count=count;this.instanceMatrix={array:new Float32Array(count*16),itemSize:16,count,version:0,set needsUpdate(v){if(v)this.version++;}};}
 setMatrixAt(i,m){this.instanceMatrix.array.set(m.elements,i*16);this.instanceMatrix.version++;}
}
// polyline (strip) or segment list, drawn unlit in material.color / opacity
export class Line extends Node{constructor(geometry,material){super();this.type='Line';this.isLine=true;this.geometry=geometry;this.material=material;}}
export class LineSegments extends Line{constructor(g,m){super(g,m);this.isLineSegments=true;}}

export class Scene extends Node{
 constructor(){super();this.type='Scene';this.fog={density:0};this._draw=[];}
 // world transforms (dirty only) + flat list of visible drawables; the returned array is reused every call
 collect(skip){this._world(null,false);const out=this._draw;out.length=0;const walk=(n,fx)=>{if(!n.visible||skip?.has(n))return;fx=n.userData.effect||fx;n._fx=fx;
   if((n.isMesh||n.isLine)&&n.material&&n.material.visible!==false&&n.geometry?.attributes.position)out.push(n);const c=n.children;for(let i=0;i<c.length;i++)walk(c[i],fx);};
  walk(this,'');return out;}
}

export class Camera extends Node{
 constructor(fov=50,aspect=1,near=.1,far=2000){super();this.type='Camera';this.isCamera=true;this.fov=fov;this.aspect=aspect;this.near=near;this.far=far;this.zoom=1;this.view=null;
  this.projectionMatrix=new Mat4();this.matrixWorldInverse=new Mat4();this._onWorld=()=>this.matrixWorldInverse.copy(this.matrixWorld).invert();this.updateProjectionMatrix();}
 _lookSign(){return -1;}
 getWorldDirection(v=new Vec3()){this.updateWorldMatrix();const e=this.matrixWorld.elements;return v.set(-e[8],-e[9],-e[10]).normalize();}
 setViewOffset(fullWidth,fullHeight,offsetX,offsetY,width,height){this.view={fullWidth,fullHeight,offsetX,offsetY,width,height};this.updateProjectionMatrix();}
 clearViewOffset(){this.view=null;this.updateProjectionMatrix();}
 // NDC shift of the view window (the GPU engine adds it to its own reversed-Z projection)
 viewShift(){const v=this.view;return v?[2*v.offsetX/v.fullWidth,-2*v.offsetY/v.fullHeight]:[0,0];}
 updateProjectionMatrix(){let top=this.near*Math.tan(MathUtils.degToRad(.5*this.fov))/this.zoom,height=2*top,width=this.aspect*height,left=-.5*width;const v=this.view;
  if(v){left+=v.offsetX*width/v.fullWidth;top-=v.offsetY*height/v.fullHeight;width*=v.width/v.fullWidth;height*=v.height/v.fullHeight;}
  this.projectionMatrix.makePerspective(left,left+width,top,top-height,this.near,this.far);}
}

let _mid=0;
export class Texture{
 constructor(image=null,{colorSpace='srgb'}={}){this.id=++_mid;this.image=image;this.colorSpace=colorSpace;this.version=1;this.anisotropy=8;}
 set needsUpdate(v){if(v)this.version++;}
 dispose(){this.onDispose?.();}
}
// kind: 'lit' (default, lit by the engine), 'unlit' (overlays), 'ground' (the terrain surface), 'tracer'
export class Material{
 constructor(o={}){this.id=++_mid;this.kind='lit';this.color=new Color('#ffffff');this.emissive=new Color(0);this.emissiveIntensity=1;this.opacity=1;this.transparent=false;this.map=null;this.alphaTest=0;
  this.vertexColors=false;this.roughness=1;this.metalness=0;this.side='front';this.visible=true;this.depthTest=true;this.depthWrite=true;this.userData={};this.uniforms=null;this.version=0;
  for(const [k,v] of Object.entries(o)){if((k==='color'||k==='emissive')&&!(v instanceof Color))this[k].set(v);else this[k]=v;}}
 set needsUpdate(v){if(v)this.version++;}
 clone(){const m=new Material();Object.assign(m,this,{id:m.id,color:this.color.clone(),emissive:this.emissive.clone(),userData:{...this.userData}});return m;}
 dispose(){}
}
