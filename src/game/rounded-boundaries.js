// Bounded corner rounding in metres. Source coordinates remain on each feature.
export function roundedBoundary(points,radius=1){
 const ring=points.slice();if(ring.length>2&&ring[0][0]===ring.at(-1)[0]&&ring[0][1]===ring.at(-1)[1])ring.pop();if(ring.length<3)return points;
 const out=[];for(let i=0;i<ring.length;i++){const a=ring[(i+ring.length-1)%ring.length],b=ring[i],c=ring[(i+1)%ring.length],ab=Math.hypot(a[0]-b[0],a[1]-b[1]),bc=Math.hypot(c[0]-b[0],c[1]-b[1]),r=Math.min(radius,ab*.24,bc*.24);if(r<.01){out.push(b);continue;}const p=[b[0]+(a[0]-b[0])*r/ab,b[1]+(a[1]-b[1])*r/ab],q=[b[0]+(c[0]-b[0])*r/bc,b[1]+(c[1]-b[1])*r/bc],steps=Math.max(3,Math.ceil(r/.22));for(let j=0;j<=steps;j++){const t=j/steps,u=1-t;out.push([u*u*p[0]+2*u*t*b[0]+t*t*q[0],u*u*p[1]+2*u*t*b[1]+t*t*q[1]]);}}
 out.push(out[0]);return out;
}
export const ROUNDING={fairway:1.8,green:1.1,tee:.55,bunker:1.1,sand:1.1,rough:1.4,water:1.2};
