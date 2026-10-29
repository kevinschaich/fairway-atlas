// Painted foliage atlas: 4x4 tiles of 512 px, each a twig sprig with alpha. Leaves are painted in near-neutral grey (the
// species' vertex tint colours them in the shader); blossoms are painted in true colour and survive the tint.
// Tile map (index = row*4+col):
//  0,1 broadleaf (oak-ish, lobed)   2,3 round (birch / sea grape)   4,5 pine needles   6,7 cypress/juniper scale fronds
//  8 azalea blossom   9 ceanothus (blue panicles)   10 gorse (yellow pea flowers)   11 white blossom
//  12,13 sage (narrow silver)   14,15 palmate (maple)
export const ATLAS_N=4,ATLAS_PX=2048;
export function bakeFoliageAtlas(){
 const S=512,cv=document.createElement('canvas');cv.width=cv.height=ATLAS_PX;const c=cv.getContext('2d');
 let seed=17;const r=()=>{seed=(seed*16807)%2147483647;return seed/2147483647};
 const grey=(l,t=0)=>{const v=Math.round(255*Math.min(1,Math.max(0,l)));const w=Math.round(v*(1+t)),b=Math.round(v*(1-t));return `rgb(${Math.min(255,w)},${v},${Math.max(0,b)})`};
 const tiles=[];
 const stem=(pts,w,l=.28)=>{c.strokeStyle=grey(l,.08);c.lineCap='round';for(let i=1;i<pts.length;i++){c.lineWidth=w*(1-i/pts.length*.6);c.beginPath();c.moveTo(...pts[i-1]);c.lineTo(...pts[i]);c.stroke();}};
 // a gently curved main stem with side twigs; returns attachment points [x,y,angle]
 const twig=(n,len,spread,w)=>{len*=.82;const pts=[];let x=S/2+(r()-.5)*40,y=S*.93,a=-Math.PI/2+(r()-.5)*.3;const main=[[x,y]];const att=[];
  for(let i=0;i<14;i++){a+=(r()-.5)*.18;x+=Math.cos(a)*len/14;y+=Math.sin(a)*len/14;main.push([x,y]);if(i>2)att.push([x,y,a]);}stem(main,w);
  const out=[];for(let k=0;k<n;k++){const [bx,by,ba]=att[Math.floor(r()*att.length)];const side=k%2?1:-1;let aa=ba+side*(.5+r()*spread);const sl=len*(.28+r()*.3);let px=bx,py=by;const sp=[[px,py]];
   for(let j=0;j<6;j++){aa+=(r()-.5)*.25-side*.05;px+=Math.cos(aa)*sl/6;py+=Math.sin(aa)*sl/6;px=Math.min(S*.9,Math.max(S*.1,px));py=Math.max(S*.1,py);sp.push([px,py]);if(j>0)out.push([px,py,aa]);}stem(sp,w*.5);}
  for(let j=5;j<main.length;j++)out.push([main[j][0],main[j][1],a]);return out;};
 const leafPath=(shape,L,W)=>{c.beginPath();
  if(shape==='oak'){c.moveTo(0,0);const lobes=4;for(let i=0;i<=lobes*2;i++){const t=i/(lobes*2);const ww=W*Math.sin(Math.PI*Math.min(1,t*1.05))*(i%2?1:.62);c.lineTo(L*t,-ww);}for(let i=lobes*2;i>=0;i--){const t=i/(lobes*2);const ww=W*Math.sin(Math.PI*Math.min(1,t*1.05))*(i%2?1:.62);c.lineTo(L*t,ww);}}
  else if(shape==='round'){c.moveTo(0,0);c.bezierCurveTo(L*.15,-W*1.2,L*1.05,-W*1.1,L,0);c.bezierCurveTo(L*1.05,W*1.1,L*.15,W*1.2,0,0);}
  else if(shape==='narrow'){c.moveTo(0,0);c.quadraticCurveTo(L*.45,-W,L,0);c.quadraticCurveTo(L*.45,W,0,0);}
  else if(shape==='palm'){const k=5;for(let i=0;i<=k*4;i++){const a=-Math.PI*.85+i/(k*4)*Math.PI*1.7;const rr=L*(.55+.45*Math.pow(Math.abs(Math.cos(i/(4)*Math.PI)),3));const x=Math.cos(a)*rr*.5+L*.5,y=Math.sin(a)*rr*.5;i?c.lineTo(x,y):c.moveTo(x,y);}}
  else{c.moveTo(0,0);c.bezierCurveTo(L*.3,-W,L*.8,-W*.8,L,0);c.bezierCurveTo(L*.8,W*.8,L*.3,W,0,0);}c.closePath();};
 const leaf=(x,y,a,shape,L,W,lum,tint)=>{if(shape==='palm'){for(let k=-2;k<=2;k++)leaf(x,y,a+k*.5,'narrow',L*(1-Math.abs(k)*.18),L*.22,lum,tint);return;}c.save();c.translate(x,y);c.rotate(a);const l=lum*(.8+r()*.35);
  const g=c.createLinearGradient(0,-W,L*.3,W);g.addColorStop(0,grey(l*1.12,tint));g.addColorStop(.55,grey(l,tint));g.addColorStop(1,grey(l*.72,tint));c.fillStyle=g;leafPath(shape,L,W);c.fill();
  c.strokeStyle=grey(l*1.3,tint*.5);c.lineWidth=Math.max(1,W*.08);c.beginPath();c.moveTo(0,0);c.lineTo(L*.92,0);c.stroke();   // midrib
  if(shape!=='narrow'){c.lineWidth=Math.max(.6,W*.04);c.strokeStyle=grey(l*1.15,tint*.5);for(let v=1;v<5;v++){const t=v/5;c.beginPath();c.moveTo(L*t,0);c.lineTo(L*(t+.12),-W*.55);c.moveTo(L*t,0);c.lineTo(L*(t+.12),W*.55);c.stroke();}}
  c.restore();};
 const paint=(i,fn)=>{c.save();const x=(i%4)*S,y=Math.floor(i/4)*S;c.beginPath();c.rect(x+S*.04,y+S*.04,S*.92,S*.92);c.clip();c.translate(x,y);fn();c.restore();};
 const leafy=(shape,count,Lr,Wr,lum,tint,n=9)=>{count=Math.round(count*1.9);const att=twig(n+3,S*.8,.7,7);for(let k=0;k<count;k++){const [x,y,a]=att[Math.floor(r()*att.length)];const aa=a+(r()<.5?1:-1)*(.35+r()*.9);const L=S*(Lr[0]+r()*(Lr[1]-Lr[0]));leaf(x,y,aa,shape,L,L*Wr,lum,tint);}return att;};
 const needles=(lum)=>{let pts=[];const att=twig(9,S*.75,.6,6);for(const [x,y,a] of att){const n=9+Math.floor(r()*7);for(let k=0;k<n;k++){const aa=a+(r()<.5?1:-1)*(.4+r()*.7);const L=S*(.07+r()*.07);const l=lum*(.75+r()*.45);
   pts.push([x+Math.cos(aa)*L,y+Math.sin(aa)*L]);c.strokeStyle=grey(l,-.02);c.lineWidth=2.2+r()*1.2;c.lineCap='round';c.beginPath();c.moveTo(x,y);c.quadraticCurveTo(x+Math.cos(aa)*L*.5+(r()-.5)*6,y+Math.sin(aa)*L*.5+(r()-.5)*6,x+Math.cos(aa)*L,y+Math.sin(aa)*L);c.stroke();}}return pts;};
 const scales=(lum,depth=3)=>{// flattened plume sprays (cypress / juniper / arborvitae): an axis with dense alternate branchlets of overlapping scales
  const cord=(x,y,a,len,w)=>{const steps=Math.max(3,Math.floor(len/(w*.55)));let px=x,py=y;for(let i=0;i<steps;i++){a+=(r()-.5)*.1;px+=Math.cos(a)*len/steps;py+=Math.sin(a)*len/steps;const ww=w*(1-i/steps*.5);const l=lum*(.82+r()*.3);
    c.fillStyle=grey(l,.03);c.beginPath();c.ellipse(px,py,ww*.8,ww*.55,a,0,6.283);c.fill();c.fillStyle=grey(l*1.22,.02);c.beginPath();c.ellipse(px-Math.cos(a)*ww*.25,py-Math.sin(a)*ww*.25,ww*.4,ww*.25,a,0,6.283);c.fill();}return [px,py];};
  const plume=(x,y,a,len,w,d)=>{const n=Math.floor(len/(w*1.1));let px=x,py=y;for(let i=0;i<n;i++){const t=i/n;px+=Math.cos(a)*len/n;py+=Math.sin(a)*len/n;a+=(r()-.5)*.06;
    const bl=len*.3*Math.sin(Math.PI*Math.min(1,t*1.15+.08))*(.75+r()*.35);const side=i%2?1:-1;const ba=a+side*(.85+r()*.2);
    if(d>0&&bl>w*4)plume(px,py,ba,bl,w*.8,d-1);else cord(px,py,ba,bl,w*.8);}
   cord(x,y,a,len,w);};
  for(let k=0;k<3;k++)plume(S*(.32+k*.18+(r()-.5)*.06),S*.94,-Math.PI/2+(k-1)*.42+(r()-.5)*.12,S*.62,7,depth>2?1:0);};
 const blossoms=(cols,n,rad,petals=5,att=null)=>{for(let k=0;k<n;k++){const q=att?att[Math.floor(r()*att.length)]:null;const x=q?q[0]:S*(.15+r()*.7),y=q?q[1]:S*(.1+r()*.65);const col=cols[Math.floor(r()*cols.length)];const R=rad*(.7+r()*.5);const a0=r()*6.28;
  for(let p=0;p<petals;p++){const a=a0+p/petals*6.283;c.fillStyle=col;c.beginPath();c.ellipse(x+Math.cos(a)*R*.55,y+Math.sin(a)*R*.55,R*.55,R*.33,a,0,6.283);c.fill();}
  c.fillStyle='rgba(255,240,180,0.95)';c.beginPath();c.arc(x,y,R*.18,0,6.283);c.fill();}};
 const panicles=(col,n)=>{for(let k=0;k<n;k++){const x=S*(.15+r()*.7),y=S*(.1+r()*.6);for(let d=0;d<40;d++){const a=r()*6.28,rr=r()*S*.07;c.fillStyle=col[Math.floor(r()*col.length)];c.beginPath();c.arc(x+Math.cos(a)*rr,y+Math.sin(a)*rr*1.5,3+r()*3,0,6.283);c.fill();}}};
 paint(0,()=>leafy('oak',26,[.11,.16],.34,.46,.03));
 paint(1,()=>leafy('oak',30,[.09,.14],.36,.42,.02));
 paint(2,()=>leafy('round',34,[.07,.1],.5,.5,.04,11));
 paint(3,()=>leafy('round',18,[.12,.17],.55,.44,.03,7));
 paint(4,()=>needles(.44));
 paint(5,()=>needles(.38));
 paint(6,()=>scales(.42,3));
 paint(7,()=>scales(.38,2));
 paint(8,()=>{const at=leafy('narrow',22,[.08,.12],.3,.4,.03);blossoms(['#e2789b','#d65f86','#f0a0bb'],12,S*.05,5,at);});
 paint(9,()=>{scales(.36,2);panicles(['#6b76d8','#5260c4','#8a94e6'],7);});
 paint(10,()=>{const tp=needles(.34);for(let k=0;k<55;k++){const q=tp[Math.floor(r()*tp.length)];const x=q[0],y=q[1];c.fillStyle=['#f2c21a','#e8b012','#f7d33c'][k%3];c.beginPath();c.ellipse(x,y,8+r()*4,6+r()*3,r()*3,0,6.283);c.fill();}});
 paint(11,()=>{const at=leafy('round',20,[.07,.1],.5,.44,.03);blossoms(['#f4f1ea','#ece6dc'],16,S*.035,5,at);});
 paint(12,()=>leafy('narrow',44,[.08,.13],.22,.5,-.02,12));
 paint(13,()=>leafy('narrow',36,[.1,.15],.2,.46,-.01,10));
 paint(14,()=>leafy('palm',22,[.13,.18],.9,.45,.03,8));
 paint(15,()=>leafy('palm',18,[.15,.2],.9,.42,.04,7));
 return cv;}
