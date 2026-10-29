import {R,M,I,dot,cross,length,scale,add,sub,unit,clamp,zero} from './physics-math.js';
export const MPH=.44704,RPM=Math.PI/30,DEG=Math.PI/180;
// Generic clubhead properties, not whole-club mass. MOI is kg m²; depth is m.
export const HEADS={
 driver:{mass:.200,moi:.00045,depth:.035,cor:.83,loft:15,attack:3,mu:.30},
 wood:{mass:.215,moi:.00030,depth:.025,cor:.81,loft:19,attack:0,mu:.32},
 hybrid:{mass:.235,moi:.00025,depth:.020,cor:.80,loft:24,attack:-2,mu:.34},
 iron:{mass:.270,moi:.00023,depth:.012,cor:.83,et:.22,loft:30,attack:-4,mu:.38},
 wedge:{mass:.300,moi:.00020,depth:.009,cor:.83,et:.25,loft:45,attack:-5,mu:.42},
 putter:{mass:.350,moi:.00045,depth:.018,cor:.78,loft:2,attack:1,mu:.30}
};
const ranges={ballSpeed:[0,250],ballDirection:[-90,90],ballElevation:[-30,90],backspin:[-20000,20000],sideSpin:[-20000,20000],pathAngle:[-90,90],attackAngle:[-60,60],faceAngle:[-90,90],dynamicLoft:[-15,90],clubSpeed:[0,180]};
// Explicit application contract, NOT a claim about Square's wire protocol.
// mph, degrees, RPM, mm. Horizontal + = right of target; backspin + = lift;
// sidespin + = right-curving. Impact x + = target-right, y + = high on face.
export function normalizeLaunchData(data){
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Shot data must be an object.');
 if(data.units&&data.units!=='mph-deg-rpm-mm')throw Error('Expected mph-deg-rpm-mm units. Convert the device packet first.');
 const out={units:'mph-deg-rpm-mm'};
 for(const [key,[min,max]]of Object.entries(ranges))if(data[key]!=null){if(typeof data[key]!=='number'||!Number.isFinite(data[key])||data[key]<min||data[key]>max)throw Error(`${key} must be ${min} to ${max}.`);out[key]=data[key];}
 if(data.impactPoint!=null){const p=data.impactPoint;if(typeof p!=='object'||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>60||Math.abs(p.y)>60)throw Error('Impact point requires x and y in mm, each within ±60.');out.impactPoint={x:p.x,y:p.y};}
 const measured=['ballSpeed','ballDirection','ballElevation','backspin','sideSpin'].every(k=>out[k]!=null);
 const club=['clubSpeed','pathAngle','attackAngle','faceAngle','dynamicLoft','impactPoint'].every(k=>out[k]!=null);
 if(!measured&&!club)throw Error('Provide all five ball measurements, or all six club-delivery measurements.');
 return out;
}
const direction=(az,el)=>({x:Math.sin(az)*Math.cos(el),y:Math.sin(el),z:-Math.cos(az)*Math.cos(el)});
export function measuredVectors(d,aim=0){
 const a=(aim+d.ballDirection)*DEG,back=d.backspin*RPM,side=d.sideSpin*RPM;
 return{v:scale(direction(a,d.ballElevation*DEG),d.ballSpeed*MPH),omega:{x:Math.cos(a)*back,y:-side,z:Math.sin(a)*back}};
}
export function clubImpact(data,club,aim=0,lieFactor=1,dampness=0){
 const h=HEADS[club.type],a=(aim+data.faceAngle)*DEG,l=data.dynamicLoft*DEG,n=direction(a,l),right={x:Math.cos(a),y:0,z:Math.sin(a)},up=unit(cross(right,n));
 const armBall=scale(n,-R),point=data.impactPoint||{x:0,y:0},armClub=add(scale(n,h.depth),add(scale(right,point.x/1000),scale(up,point.y/1000)));
 const incoming=scale(direction((aim+data.pathAngle)*DEG,data.attackAngle*DEG),data.clubSpeed*MPH*lieFactor);
 // Contact inverse-mass matrix includes both bodies' rotational inertia.
 const K=j=>sub(sub(scale(j,1/M+1/h.mass),scale(cross(armBall,cross(armBall,j)),1/I)),scale(cross(armClub,cross(armClub,j)),1/h.moi));
 const closing=Math.max(0,dot(incoming,n)),jn=(1+h.cor)*closing/dot(n,K(n));
 let impulse=scale(n,jn),residual=sub(incoming,K(impulse));
 const k11=dot(right,K(right)),k22=dot(up,K(up)),k12=dot(right,K(up)),det=k11*k22-k12*k12,b1=dot(residual,right),b2=dot(residual,up);
 // Tangential restitution approximates elastic cover shear recovery. The old
 // rigid no-slip impulse (et=0) systematically underpredicted iron/wedge spin.
 // Applied to the contact impulse, not as an independent RPM multiplier.
 const recovery=1+(h.et||0)*(1-.5*dampness);
 let jt=scale(add(scale(right,(b1*k22-b2*k12)/det),scale(up,(b2*k11-b1*k12)/det)),recovery);
 const limit=h.mu*(1-.35*dampness)*jn;if(length(jt)>limit)jt=scale(jt,limit/length(jt));
 impulse=add(impulse,jt);
 return{v:scale(impulse,1/M),omega:scale(cross(armBall,impulse),1/I),clubAfter:sub(incoming,scale(impulse,1/h.mass)),headSpin:scale(cross(armClub,scale(impulse,-1)),1/h.moi),impulse,headMass:h.mass};
}
export function launchState(input,club,lieFactor=1,wetness=0){
 const h=HEADS[club.type],power=clamp(input.power/100,.01,1.1);
 const fallback={clubSpeed:(club.stockClubSpeed??club.speed/(club.type==='putter'?1.56:club.smash)/MPH)*power,pathAngle:0,attackAngle:h.attack,faceAngle:0,dynamicLoft:club.loft+(club.type==='driver'?4.5:club.type==='wood'?4:club.type==='hybrid'?3:club.type==='wedge'?-8:club.type==='putter'?-1:-6.5),impactPoint:{x:0,y:0}};
 const supplied=input.launchData?normalizeLaunchData(input.launchData):null,d={...fallback,...supplied};
 const prediction=clubImpact(d,club,input.aim,lieFactor,wetness),predSpeed=length(prediction.v),predAz=Math.atan2(prediction.v.x,-prediction.v.z),predBack=dot(prediction.omega,{x:Math.cos(predAz),y:0,z:Math.sin(predAz)})/RPM;
 const predicted={ballSpeed:predSpeed/MPH,ballDirection:((predAz/DEG-input.aim+540)%360)-180,ballElevation:Math.atan2(prediction.v.y,Math.hypot(prediction.v.x,prediction.v.z))/DEG,backspin:predBack,sideSpin:-prediction.omega.y/RPM};
 const used={...predicted,...supplied},state=measuredVectors(used,input.aim);
 // Legacy practice spin-axis control uses the same complete spin vector.
 if(!supplied&&Number.isFinite(input.spinAxis)){const total=Math.hypot(used.backspin,used.sideSpin);used.backspin=total*Math.cos(input.spinAxis*DEG);used.sideSpin=total*Math.sin(input.spinAxis*DEG);Object.assign(state,measuredVectors(used,input.aim));}
 const measured=!!supplied&&['ballSpeed','ballDirection','ballElevation','backspin','sideSpin'].every(k=>supplied[k]!=null);
 return{...state,stats:{clubSpeed:supplied?.clubSpeed??d.clubSpeed,ballSpeed:used.ballSpeed,launch:used.ballElevation,attack:d.attackAngle,spin:used.backspin,sideSpin:used.sideSpin,axis:!supplied&&Number.isFinite(input.spinAxis)?input.spinAxis:Math.atan2(used.sideSpin,used.backspin)/DEG,totalSpin:Math.hypot(used.backspin,used.sideSpin),direction:used.ballDirection,pathAngle:d.pathAngle,faceAngle:d.faceAngle,dynamicLoft:d.dynamicLoft,impactPoint:d.impactPoint,headMass:h.mass,source:measured?'measured ball':'club impact',measuredFields:supplied?Object.keys(supplied):[],prediction:predicted},measured};
}
