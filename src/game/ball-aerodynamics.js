import {R,M,G,cross,length,scale,add,unit,clamp} from './physics-math.js';
const AREA=Math.PI*R*R;
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)};
export const airDensityAt=height=>1.225*Math.pow(1-.0065*clamp(height,-500,11000)/288.15,4.25588);
export function atmosphere(height,temperature=15,humidity=50){
 const kelvin=temperature+273.15,pressure=101325*Math.pow(1-.0065*clamp(height,-500,11000)/288.15,5.25588);
 const vapor=clamp(humidity,0,100)/100*610.94*Math.exp(17.625*temperature/(temperature+243.04));
 return{density:(pressure-vapor)/(287.058*kelvin)+vapor/(461.495*kelvin),viscosity:1.716e-5*(kelvin/273.15)**1.5*(273.15+110.4)/(kelvin+110.4)};
}
// Drag polynomial and saturating high-Re lift adapted from OpenFairway (MIT).
// Continuous low-Re/zero-spin limits; no launch-angle/carry exception tables.
// Lift and drag vs spin parameter S = Rω/|u| (u = air-relative velocity), after Bearman & Harvey's wind-tunnel
// fits as quoted by Penner (2003): CL = 1.99S − 3.25S² (peaking at .305, S ≈ .31, then held), CD = .171 + .62S. The
// drag slope is softened above S = .15 (+.20 per unit S), where the spinning-ball tunnel data flatten and the linear
// fit over-drags high-spin irons; with that change the model matches TrackMan tour averages for driver → PW within a
// few yards of carry and a few degrees of landing angle.
// Lift that keeps growing with S (rather than saturating early) matters in wind: a tailwind lowers |u| and so raises
// S, so the Magnus force falls roughly ∝ |u| instead of ∝ |u|². The earlier early-saturating curve made the ball drop
// under its own arc in a strong tailwind.
// Below the drag crisis (Re < ~5e4) a NON-spinning dimpled ball has CD ≈ .46, but spin trips asymmetric separation
// and a spinning ball keeps the supercritical values (Aoki et al. 2010), so the subcritical rise fades out with S.
// Lift fades only at very low Re (< 1.5e4, ~5 m/s) where no measurements exist.
export function coefficients(re,spinRatio){
 const s=clamp(spinRatio,0,2);
 const cdSuper=.171+.62*Math.min(s,.15)+.20*clamp(s-.15,0,.85),rise=(1-smooth(30000,50000,re))*Math.max(0,1-s/.25);
 const cd=cdSuper+(.46-cdSuper)*rise,cl=(s<.306?1.99*s-3.25*s*s:.3046)*smooth(5000,15000,re);
 return{cd,cl};
}
export function acceleration(v,omega,wind={},rho=1.225,viscosity=1.81e-5){
 const u={x:v.x-(wind.x||0),y:v.y-(wind.y||0),z:v.z-(wind.z||0)},speed=length(u);
 if(speed<1e-8)return{x:0,y:-G,z:0};
 const liftAxis=cross(omega,u),s=R*length(liftAxis)/(speed*speed),{cd,cl}=coefficients(rho*speed*2*R/viscosity,s),q=.5*rho*AREA*speed*speed/M;
 const drag=scale(u,-q*cd/speed),lift=scale(unit(liftAxis),q*cl);
 return{x:drag.x+lift.x,y:drag.y+lift.y-G,z:drag.z+lift.z};
}
export function integrateFlight(p,v,omega,wind,rho,dt,viscosity=1.81e-5){
 const decay=rho===0?0:1/24,w2=scale(omega,Math.exp(-dt*decay/2)),w4=scale(omega,Math.exp(-dt*decay));
 const a1=acceleration(v,omega,wind,rho,viscosity),v2=add(v,scale(a1,dt/2)),a2=acceleration(v2,w2,wind,rho,viscosity),v3=add(v,scale(a2,dt/2)),a3=acceleration(v3,w2,wind,rho,viscosity),v4=add(v,scale(a3,dt)),a4=acceleration(v4,w4,wind,rho,viscosity);
 const sum=(a,b,c,d)=>scale(add(add(a,scale(b,2)),add(scale(c,2),d)),dt/6);
 return{p:add(p,sum(v,v2,v3,v4)),v:add(v,sum(a1,a2,a3,a4)),omega:w4};
}
