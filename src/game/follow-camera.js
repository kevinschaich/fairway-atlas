// Pure path/camera math shared by playback and regression checks.
export function sampleShot(path,time){
 let lo=0,hi=path.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(path[mid].t<time)lo=mid+1;else hi=mid;}
 const b=path[lo],a=path[Math.max(0,lo-1)],span=b.t-a.t,f=Math.max(0,Math.min(1,(time-a.t)/(span||1)));
 return{x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,z:a.z+(b.z-a.z)*f,vx:span?(b.x-a.x)/span:0,vy:span?(b.y-a.y)/span:0,vz:span?(b.z-a.z)/span:0,wx:a.wx??0,wy:a.wy??0,wz:a.wz??0,phase:b.phase,index:lo,depth:(b.depth||0)*f};
}
export function followPose(ball,aim,elevation,putting=false){
 const speed=Math.hypot(ball.vx,ball.vz),dx=Math.sin(aim),dz=-Math.cos(aim),height=Math.max(0,ball.y-elevation(ball.x,ball.z));
 const distance=putting?3.3:Math.min(25,7+speed*.25),side=putting?1.3:Math.min(7,2+height*.12),lift=putting?1.8:Math.min(10,3+height*.14);
 const x=ball.x-dx*distance-dz*side,z=ball.z-dz*distance+dx*side;
 let y=Math.max(ball.y+lift,elevation(x,z)+2.4);
 // Lift the chase rig over the ground along its line of sight, including cliffs.
 for(let i=1;i<=8;i++){const f=i/9,h=elevation(x+(ball.x-x)*f,z+(ball.z-z)*f)+.65*(1-f);y=Math.max(y,(h-ball.y*f)/(1-f));}
 return{position:{x,y,z},target:{x:ball.x,y:ball.y+Math.min(.7,height*.015),z:ball.z},fov:putting?55:60};
}
export const smoothFactor=(dt,response=5)=>1-Math.exp(-Math.max(0,dt)*response);
