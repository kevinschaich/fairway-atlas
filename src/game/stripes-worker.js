// Off-main-thread fairway stripe / mown-edge / sand-edge field painter (see renderer.paintStripes).
self.onmessage=({data:{id,world,box,N}})=>{
  const c=new OffscreenCanvas(N,N),g=c.getContext('2d',{willReadFrequently:true}),sc=N/box.size,texel=box.size/N,R=4;
  const segs=[];for(const r of world.courseRoutes||[]){const pts=r.route||[];for(let i=1;i<pts.length;i++)segs.push([pts[i-1],pts[i]]);}
  for(const f of world.features.filter(f=>f.kind==='fairway'&&f.closed)){
   const cx=f.points.reduce((s,p)=>s+p[0],0)/f.points.length,cz=f.points.reduce((s,p)=>s+p[1],0)/f.points.length;let best=Infinity,ang=0;
   for(const [a,b] of segs){const dx=b.x-a.x,dz=b.z-a.z,l2=dx*dx+dz*dz||1,t=Math.max(0,Math.min(1,((cx-a.x)*dx+(cz-a.z)*dz)/l2)),d=Math.hypot(a.x+dx*t-cx,a.z+dz*t-cz);if(d<best){best=d;ang=Math.atan2(dz,dx);}}
   const G=Math.round(((ang%Math.PI+Math.PI)%Math.PI)/Math.PI*255);
   g.save();g.setTransform(sc,0,0,sc,-box.x*sc,-box.z*sc);g.beginPath();f.points.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();g.clip();
   g.translate(cx,cz);g.rotate(ang);const W=3.6,L=1200;for(let k=-340;k<340;k++){g.fillStyle=`rgb(${k&1?192:64},${G},0)`;g.fillRect(-L,k*W,2*L,W);}g.restore();
  }
  const data=new Uint8Array(g.getImageData(0,0,N,N).data);
  const coverage=kinds=>{g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,N,N);g.setTransform(sc,0,0,sc,-box.x*sc,-box.z*sc);g.fillStyle='#fff';for(const f of world.features.filter(f=>kinds.includes(f.kind)&&f.closed)){g.beginPath();f.points.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();for(const ring of f.innerPoints||[]){ring.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();}g.fill('evenodd');}const d=g.getImageData(0,0,N,N).data,m=new Float32Array(N*N);for(let i=0;i<m.length;i++)m[i]=d[i*4+3]/255;return m;};
  const chamfer=seed=>{const D=seed,a=1,b=Math.SQRT2;for(let y=0;y<N;y++)for(let x=0;x<N;x++){const i=y*N+x;let v=D[i];if(x>0)v=Math.min(v,D[i-1]+a);if(y>0){v=Math.min(v,D[i-N]+a);if(x>0)v=Math.min(v,D[i-N-1]+b);if(x<N-1)v=Math.min(v,D[i-N+1]+b);}D[i]=v;}for(let y=N-1;y>=0;y--)for(let x=N-1;x>=0;x--){const i=y*N+x;let v=D[i];if(x<N-1)v=Math.min(v,D[i+1]+a);if(y<N-1){v=Math.min(v,D[i+N]+a);if(x<N-1)v=Math.min(v,D[i+N+1]+b);if(x>0)v=Math.min(v,D[i+N-1]+b);}D[i]=v;}return D;};
  const sdf=(kinds,ch)=>{const m=coverage(kinds),big=1e6,out=new Float32Array(N*N),inn=new Float32Array(N*N);
   // Seeds: pixels on the edge get their fractional distance from coverage; others start far.
   for(let i=0;i<m.length;i++){const v=m[i];out[i]=v>=1?0:v>0?(.5-v+.5)*0+Math.max(0,.5-v):big;inn[i]=v<=0?0:v<1?Math.max(0,v-.5):big;if(v>=.5)out[i]=0;if(v<.5)inn[i]=0;}
   chamfer(out);chamfer(inn);
   const dist=new Float32Array(N*N);for(let i=0;i<m.length;i++){const d=(out[i]-inn[i])*texel;dist[i]=d;data[i*4+ch]=Math.round(Math.min(1,Math.max(0,d/R*.5+.5))*255);}return dist;};
  const mown=sdf(['fairway','tee','green'],2),sand=sdf(['bunker'],3);
  self.postMessage({id,N,data,mown,sand},[data.buffer,mown.buffer,sand.buffer]);
};
