// Temporal anti-aliasing with upsampling (TAAU), in the spirit of UE4/5 TemporalAA (Karis 2014, "High Quality Temporal
// Supersampling"; Jimenez 2016; Salvi 2016 variance clipping).
//  - the scene is rendered at the (dynamic) internal resolution with a Halton(2,3) sub-pixel jitter every frame
//  - this pass runs at the OUTPUT resolution: each output pixel is rebuilt from the 3x3 nearest jittered render samples
//    (Blackman-Harris-like gaussian weights on their true sub-pixel distance), which is what turns jitter into real
//    extra resolution and coverage
//  - history is reprojected from depth (closest-depth dilation over 3x3 so thin grass edges carry the right motion) and
//    fetched with a 5-tap Catmull-Rom (sharp, no progressive blur)
//  - history is clipped (not clamped) toward the current neighbourhood's YCoCg mean within mean +- gamma*sigma
//    (variance clipping), which kills ghosting from wind-blown blades and moving objects without per-object velocity
//  - everything is filtered and blended in a luma-weighted (Karis 1/(1+L)) space so single bright samples (sun glints)
//    can't dominate: this is the anti-flicker for sparkling grass
//  - blend factor: low (long accumulation, strong AA) where a render sample lands on this output pixel, higher under
//    motion and where history is rejected; 1 on reset / off-screen
export const TAA=/*wgsl*/`
struct TU{invVP:mat4x4f,prevVP:mat4x4f,p0:vec4f,p1:vec4f,p2:vec4f}   // p2: x kernel sharpness   // p0: render w,h, output w,h ; p1: jitter px (uv space) x,y, reset, gamma
@group(0) @binding(0) var cur:texture_2d<f32>;
@group(0) @binding(1) var dep:texture_depth_2d;
@group(0) @binding(2) var hist:texture_2d<f32>;
@group(0) @binding(3) var ls:sampler;
@group(0) @binding(4) var<uniform> U:TU;
struct VO{@builtin(position) pos:vec4f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:VO;o.pos=vec4f(p*2.-1.,0.,1.);return o;}
fn luma(c:vec3f)->f32{return dot(c,vec3f(.2126,.7152,.0722));}
fn tm(c:vec3f)->vec3f{return c/(1.+luma(c));}            // Karis: reversible luma-weighted compression
fn itm(c:vec3f)->vec3f{return c/max(1.-luma(c),1e-4);}
fn toY(c:vec3f)->vec3f{return vec3f(dot(c,vec3f(.25,.5,.25)),dot(c,vec3f(.5,0.,-.5)),dot(c,vec3f(-.25,.5,-.25)));}
fn fromY(y:vec3f)->vec3f{return vec3f(y.x+y.y-y.z,y.x+y.z,y.x-y.y-y.z);}
fn fin(c:vec3f)->vec3f{let b=bitcast<vec3u>(c)&vec3u(0x7f800000u);return select(c,vec3f(0.),any(b==vec3u(0x7f800000u)));}
// 5-tap Catmull-Rom (Jimenez): sharp bicubic history with only 5 bilinear fetches
fn histCR(uv:vec2f,sz:vec2f)->vec3f{let sp=uv*sz;let tc=floor(sp-.5)+.5;let f=sp-tc;
 let w0=f*(-.5+f*(1.-.5*f));let w1=1.+f*f*(-2.5+1.5*f);let w2=f*(.5+f*(2.-1.5*f));let w3=f*f*(-.5+.5*f);
 let w12=w1+w2;let t0=(tc-1.)/sz;let t3=(tc+2.)/sz;let t12=(tc+w2/w12)/sz;
 var c=textureSampleLevel(hist,ls,vec2f(t12.x,t0.y),0.).rgb*(w12.x*w0.y)+textureSampleLevel(hist,ls,vec2f(t0.x,t12.y),0.).rgb*(w0.x*w12.y)
  +textureSampleLevel(hist,ls,t12,0.).rgb*(w12.x*w12.y)+textureSampleLevel(hist,ls,vec2f(t3.x,t12.y),0.).rgb*(w3.x*w12.y)+textureSampleLevel(hist,ls,vec2f(t12.x,t3.y),0.).rgb*(w12.x*w3.y);
 let ws=w12.x*w0.y+w0.x*w12.y+w12.x*w12.y+w3.x*w12.y+w12.x*w3.y;return max(c/ws,vec3f(0.));}
// clip a colour toward the box centre (Playdead / UE style) instead of per-channel clamping: no hue shifts
fn clipBox(h:vec3f,mn:vec3f,mx:vec3f)->vec3f{let c=.5*(mx+mn);let e=.5*(mx-mn)+1e-5;let v=h-c;let u=abs(v/e);let m=max(u.x,max(u.y,u.z));return select(h,c+v/m,m>1.);}
@fragment fn fs(v:VO)->@location(0) vec4f{
 let rs=U.p0.xy;let os=U.p0.zw;let jp=U.p1.xy;
 let uvO=v.pos.xy/os;let q=uvO*rs;                        // output pixel centre in render-pixel units
 let i0=vec2i(floor(q-jp));                               // render sample i sits at i+.5+jitter
 let scale=os.x/rs.x;                                     // upsampling factor: widen the reconstruction kernel with it
 let kw=U.p2.x/max(scale*scale*.6+.4,1.);                // sharp Blackman-Harris fit (UE r.TemporalAA filter ~ this); widens only when upsampling
 var sumW=0.;var sumC=vec3f(0.);var m1=vec3f(0.);var m2=vec3f(0.);var wMax=0.;var dMax=0.;var iBest=i0;
 let rmax=vec2i(rs)-1;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let ii=clamp(i0+vec2i(x,y),vec2i(0),rmax);
  let cl=fin(textureLoad(cur,ii,0).rgb);let c=tm(cl);let d=vec2f(ii)+.5+jp-q;let w=exp(-kw*dot(d,d));
  sumW+=w;sumC+=cl*w;   /* reconstruct in LINEAR light: glints keep their energy; the luma weighting is only for clipping/blending */wMax=max(wMax,w);let yc=toY(c);m1+=yc;m2+=yc*yc;
  if(x*y==0){let z=textureLoad(dep,ii,0);if(z>dMax){dMax=z;iBest=ii;}}}}   // reversed-Z: larger = closer; '+' pattern dilation (UE) to the nearest surface
 let curC=tm(sumC/max(sumW,1e-5));
 m1/=9.;let sig=sqrt(max(m2/9.-m1*m1,vec3f(0.)));let g=U.p1.w;
 // reprojection of the closest sample (unjittered position) with the previous frame's camera
 let uvS=(vec2f(iBest)+.5)/rs;let ndc=vec4f(uvS.x*2.-1.,1.-uvS.y*2.,dMax,1.);
 let wp=U.invVP*ndc;let pc=U.prevVP*wp;                   // homogeneous: works for the sky (depth 0 = infinity) too
 let pn=pc.xy/pc.w;let uvP=vec2f(pn.x*.5+.5,.5-pn.y*.5);
 let uvC=(vec2f(iBest)+.5+jp)/rs;let vel=uvP-uvC;let uvH=uvO+vel;
 let off=any(uvH<vec2f(0.))||any(uvH>vec2f(1.))||pc.w<=0.||U.p1.z>.5;
 var h=tm(fin(histCR(uvH,os)));
 let hy=clipBox(toY(h),m1-g*sig,m1+g*sig);h=fromY(hy);
 // blend: long accumulation where a render sample hits this output pixel, faster under motion / rejection
 let velPx=length(vel*os);
 var a=mix(.12,.035,wMax);a=max(a,clamp(velPx*.012,0.,.2));
 if(off){a=1.;}
 let o=itm(mix(h,curC,a));
 return vec4f(fin(o),1.);}
`;

// Local exposure (UE5-style "local exposure", simplified): a 1/16-res map of mean log2 luminance. The post pass reads it with an
// edge-aware (bilateral) lookup and lifts regions that sit far below the frame's average exposure, so a shaded cove keeps
// its texture instead of collapsing to a black blob, while bright sky/sea are left alone.
export const LUMA=/*wgsl*/`
@group(0) @binding(0) var src:texture_2d<f32>;
@group(0) @binding(1) var ls:sampler;
struct VO{@builtin(position) pos:vec4f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:VO;o.pos=vec4f(p*2.-1.,0.,1.);return o;}
@fragment fn fs(v:VO)->@location(0) vec4f{let sd=vec2f(textureDimensions(src));let blk=16.;let o0=(floor(v.pos.xy)*blk)/sd;var s=0.;
 for(var y=0;y<4;y++){for(var x=0;x<4;x++){let uv=o0+(vec2f(f32(x),f32(y))*4.+2.)/sd;let c=textureSampleLevel(src,ls,uv,0.).rgb;s+=log2(max(dot(c,vec3f(.2126,.7152,.0722)),1e-7));}}
 return vec4f(s/16.,0.,0.,1.);}
`;
