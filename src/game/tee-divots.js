// Tee-box dressing data: the two tee markers and the wear marks (divots) players leave between them.
// Markers stand at the sides of the box, on the line across the aim through the teeing position, 2 ft in from the edge.
// Divots come from iron tee shots: concentrated between the markers (most near the middle), in a band from just ahead of
// the marker line back ~2 club lengths, each scrape pointing along the aim. Deterministic per tee id.
import {pointIn} from './engine.js';
export {insideDivot,makeDivotSampler} from './divot-sampler.js';
export const MARKER_INSET=.61;   // 2 ft
const rngFor=id=>{let seed=2166136261;for(const c of String(id))seed=Math.imul(seed^c.charCodeAt(0),16777619);return()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);};
function teeAim(f,routes,cx,cz){let aim=null,best=160;for(const r of routes||[]){const pts=r.route||r;if(!pts?.[1])continue;const d=Math.hypot(pts[0].x-cx,pts[0].z-cz);if(d<best){best=d;aim=Math.atan2(pts[1].z-pts[0].z,pts[1].x-pts[0].x);}}return aim;}
// distance from (x,z) along (dx,dz) to the tee outline
function reach(f,x,z,dx,dz,max=40){let t=0;while(t<max&&pointIn([x+dx*(t+.05),z+dz*(t+.05)],f.points))t+=.05;return t;}
export function teeMarkers(f,anchor,aim){const ax=Math.cos(aim),az=Math.sin(aim),sx=-az,sz=ax;
 const L=reach(f,anchor.x,anchor.z,-sx,-sz),R=reach(f,anchor.x,anchor.z,sx,sz);
 const inset=d=>d>MARKER_INSET*2.2?d-MARKER_INSET:d*.55;
 const l=inset(L),r=inset(R);
 return {tee:f.id,aim,anchor:{x:anchor.x,z:anchor.z},left:{x:anchor.x-sx*l,z:anchor.z-sz*l},right:{x:anchor.x+sx*r,z:anchor.z+sz*r},span:[-l,r]};}
// options.tee: the teeing position on the current hole (markers line up with it); other tees use their centroid
export function createTeeDivots(features,routes=[],options={}){
 const marks=[],markers=[];for(const f of features.filter(f=>f.kind==='tee'&&f.closed)){
  const rng=rngFor(f.id);
  const cx=f.points.reduce((s,p)=>s+p[0],0)/f.points.length,cz=f.points.reduce((s,p)=>s+p[1],0)/f.points.length;
  const set=options.sets?.get(f.id),here=options.tee&&pointIn([options.tee.x,options.tee.z],f.points);let aim=here&&options.axis!=null?options.axis:set?.axis??teeAim(f,routes,cx,cz);if(aim===null)aim=rng()*Math.PI;   // current tee: the ball-to-first-aim-point axis; other tees: their hole's opening leg
  const anchor=here?options.tee:set?.point??{x:cx,z:cz};
  const mk=teeMarkers(f,anchor,aim);mk.color=set?.color??null;markers.push(mk);
  const ax=Math.cos(aim),az=Math.sin(aim),[s0,s1]=mk.span;
  const b=f.bounds,area=(b.maxX-b.minX)*(b.maxZ-b.minZ),count=Math.min(34,Math.max(8,Math.round(area/6)));
  const gauss=()=>(rng()+rng()+rng()-1.5)/1.5;
  for(let tries=0,made=0;tries<900&&made<count;tries++){
   // across: between the markers, favouring the middle (players tee up near the centre); along: a tight band on the marker line
   const mid=(s0+s1)/2,half=(s1-s0)/2,side=mid+half*(rng()<.65?gauss()*.55:rng()*2-1)*.46;
   const along=Math.max(-.3,Math.min(.3,gauss()*.175));   // on the marker line, between the markers
   const x=anchor.x+ax*along-az*side,z=anchor.z+az*along+ax*side,angle=aim+gauss()*.035;   // long side parallel to the axis
   const kind='open';rng();   // every scrape is dug out: bare soil below the turf
   const d={x,z,angle,length:.055+rng()*.05,width:.022+rng()*.014,depth:.014+rng()*.018,tee:f.id,kind,variant:Math.floor(rng()*4)};
   if(!Array.from({length:12},(_,i)=>{const a=i*Math.PI/6,u=Math.cos(a)*d.length*.7,v=Math.sin(a)*d.width*.7;return pointIn([d.x+u*Math.cos(d.angle)-v*Math.sin(d.angle),d.z+u*Math.sin(d.angle)+v*Math.cos(d.angle)],f.points)}).every(Boolean))continue;
   if(marks.some(m=>Math.hypot(m.x-d.x,m.z-d.z)<.11))continue;
   if(Math.hypot(d.x-anchor.x,d.z-anchor.z)<.12)continue;   // leave the teeing spot itself clean
   marks.push(d);made++;
  }
 }
 marks.markers=markers;return marks;
}
