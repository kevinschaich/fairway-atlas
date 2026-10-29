export function insideDivot(d,x,z){const dx=x-d.x,dz=z-d.z,c=Math.cos(d.angle),s=Math.sin(d.angle);return ((dx*c+dz*s)/d.length)**2+((-dx*s+dz*c)/d.width)**2<1;}
// Query only nearby wear marks. Checking every tee on the course for every
// blade turned dense tee grass into hundreds of millions of ellipse tests.
export function makeDivotSampler(marks){
 const bins=new Map(),size=4;
 for(const d of marks){const radius=Math.max(d.length,d.width),item={...d,c:Math.cos(d.angle),s:Math.sin(d.angle)};for(let z=Math.floor((d.z-radius)/size);z<=Math.floor((d.z+radius)/size);z++)for(let x=Math.floor((d.x-radius)/size);x<=Math.floor((d.x+radius)/size);x++){const key=x+':'+z;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(item);}}
 return(x,z)=>{for(const d of bins.get(Math.floor(x/size)+':'+Math.floor(z/size))||[]){const dx=x-d.x,dz=z-d.z;if(((dx*d.c+dz*d.s)/d.length)**2+((-dx*d.s+dz*d.c)/d.width)**2<1)return true;}return false;};
}
