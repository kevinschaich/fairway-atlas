import {G,clamp} from './physics-math.js';
export const DEFAULT_CONDITIONS={dampness:0,stimp:10,temperature:15,humidity:50,windSpeed:3.5,windDirection:125};
export const CONDITION_LIMITS={dampness:[0,1],stimp:[5,15],temperature:[-10,45],humidity:[0,100],windSpeed:[0,40],windDirection:[0,360]};
export function conditions(input={}){const c={...DEFAULT_CONDITIONS};for(const [key,[min,max]]of Object.entries(CONDITION_LIMITS))if(Number.isFinite(input[key]))c[key]=clamp(input[key],min,max);return c;}
// Stimpmeter launch speed 1.83 m/s. Stimp describes the dry/reference green;
// wet turf adds drag. The dampness response is an adjustable generic assumption.
export const stimpDeceleration=feet=>1.83**2/(2*feet*.3048);
// bearing: dynamic penetration resistance of a soft medium (Pa). A landing ball
// digs a crater of depth d where its normal kinetic energy equals the work done
// against that pressure over the spherical-cap contact area: ½mv² = πRP·d².
// plow: velocity-squared drag (1/m) of grass blades or sand pushed ahead of a
// ball travelling through (not over) the medium. plug: crater depth / radius at
// which the ball stays embedded ("plugged", "fried egg").
// Firm turf is not given a bearing; Penner's speed-dependent restitution and
// crater-normal tilt already represent its deformation.
export const CONTACT={
 green:{e:.51,mu:.40,roll:stimpDeceleration(10),deformation:.12},
 // tee/fairway e and μ fitted with the crater tilt to Biber et al. (2023) natural-turf bounces (see ball-physics impactNormal)
 tee:{e:.43,mu:.33,roll:.75,deformation:.15,plow:.01},
 fairway:{e:.43,mu:.33,roll:.85,deformation:.15,plow:.02},
 rough:{e:.22,mu:.62,roll:2.2,deformation:.30,bearing:4.0e5,plow:.42,rest:.10},
 bunker:{e:.10,mu:.75,roll:4.5,deformation:.40,bearing:1.5e5,plow:1.3,plug:.72,rest:.28},
 sand:{e:.13,mu:.70,roll:3.8,deformation:.34,bearing:2.2e5,plow:1.0,plug:.85,rest:.22},
 bare_rock:{e:.78,mu:.32,roll:.35,deformation:0},
 path:{e:.74,mu:.38,roll:.45,deformation:0}
};
export function materialFor(surface,c=DEFAULT_CONDITIONS,normalSpeed=0){
 const m=CONTACT[surface]||CONTACT.rough,w=c.dampness??0;
 // Speed-dependent restitution represents turf/soil deformation; no extra
 // post-impact velocity multiplier. Sand packs with moisture (no standing water).
 const sand=surface==='sand'||surface==='bunker',wetRoll=sand?1-.25*w:1+.45*w;
 const turf=['green','tee','fairway','rough'].includes(surface),vn=Math.min(20,Math.max(0,normalSpeed));
 // Penner (2002), eq. 5: measured normal restitution on compliant turf.
 const restitution=turf?m.e/.51*(.510-.0375*vn+.000903*vn*vn):m.e/(1+.012*Math.max(0,normalSpeed-2));
 // Wet turf softens (lower bearing); wet sand packs (higher bearing, less plowing).
 const bearing=m.bearing?m.bearing*(sand?1+.8*w:1-.35*w):0,plow=(m.plow||0)*(sand?1-.35*w:1+.25*w);
 return {...m,bearing,plow,e:clamp(restitution*(1-.55*w),.025,.85),mu:m.mu*(1-.25*w),roll:(surface==='green'?stimpDeceleration(c.stimp??10):m.roll)*wetRoll,deformation:m.deformation*(1+.3*w),crr:(surface==='green'?stimpDeceleration(c.stimp??10):m.roll)*wetRoll/G};
}
// Wind is specified as the standard 10 m anemometer reading. Near the ground the
// atmospheric surface layer slows it: neutral log-law u(z)=u10·ln(z/z0)/ln(10/z0)
// with z0 = 3 cm (open mown grass, WMO/Davenport roughness class). A ball at
// 1 m sees ~61% of the reported wind, at 30 m ~119%.
export const WIND_REFERENCE_HEIGHT=10,WIND_ROUGHNESS=.03;
export const windProfileFactor=h=>h<=WIND_ROUGHNESS?0:Math.min(1.6,Math.log(h/WIND_ROUGHNESS)/Math.log(WIND_REFERENCE_HEIGHT/WIND_ROUGHNESS));
export function windAtHeight(wind,h){const f=windProfileFactor(h);return{x:(wind.x||0)*f,y:(wind.y||0)*f,z:(wind.z||0)*f};}
// Shot-relative wind for a target bearing aim (degrees, north = 0, clockwise).
// along > 0 helps (tailwind), cross > 0 blows toward the golfer's right.
export function windRelative(c,aim=0){const w=windVector(c),a=aim*Math.PI/180,along=w.x*Math.sin(a)-w.z*Math.cos(a),cross=w.x*Math.cos(a)+w.z*Math.sin(a);return{along,cross,angle:((c.windDirection-aim)%360+540)%360-180};}
export function windVector(c){const a=c.windDirection*Math.PI/180,s=c.windSpeed*.44704;return{x:Math.sin(a)*s,y:0,z:-Math.cos(a)*s};}
