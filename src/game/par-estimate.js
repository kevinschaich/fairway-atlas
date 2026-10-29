// Temporary playing estimate, not a course rating. Measure the full mapped
// routing (including doglegs); a future scorecard provider can replace this.
export function withEstimatedPar(hole){
 if(Number.isFinite(hole.par)&&hole.par>=3&&hole.par<=6)return hole;
 const route=hole.route||[],rad=Math.PI/180;let metres=0;
 for(let i=1;i<route.length;i++){const a=route[i-1],b=route[i],dy=(b[1]-a[1])*rad,dx=(b[0]-a[0])*rad,q=Math.sin(dy/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dx/2)**2;metres+=6371008.8*2*Math.atan2(Math.sqrt(q),Math.sqrt(Math.max(0,1-q)));}
 const yards=metres/.9144;return {...hole,par:yards<=250?3:yards<=470?4:yards<=690?5:6,parEstimated:true,parSource:'Estimated from mapped yardage',estimatedYardage:Math.round(yards)};
}
