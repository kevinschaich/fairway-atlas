// Colour grade: one unified set of parameters, keyframed over the time of day and interpolated smoothly between keys.
// There is no automatic exposure: brightness is the keyframed EV. Edited live from Visual debug > Grade.
// backend.js calls gradeAt(dayPos(hour)) every frame and packs the result into the post-pass uniforms (PU[5..11]).

// [key, label, min, max, step, hint]
export const GRADE_PARAMS=[
 ['Exposure',[
  ['ev','Exposure (EV)',-4,4,.05,'fixed exposure; there is no auto metering'],
 ]],
 ['Tone curve',[
  ['contrast','Contrast',.7,2,.01,'log-space, pivot at mid-grey'],
  ['shoulderKnee','Highlight shoulder knee',.3,1,.01,'where highlights start rolling off'],
  ['blackPoint','Black point',0,.05,.0005,'higher = deeper blacks'],
  ['whitePoint','White point',.5,1.5,.01,'lower = brighter highlights'],
  ['gamma','Gamma',.5,1.6,.01,'<1 lifts shadows, >1 deepens them'],
  ['hueBlend','Hue preservation',0,1,.01,'0 = per-channel ACES (brights bleach to white), 1 = luminance only'],
  ['hdrHeadroom','HDR headroom (× SDR white)',1,16,.5,'HDR output only'],
 ]],
 ['Colour',[
  ['temperature','Temperature (K)',2500,15000,50,'white balance: higher = warmer, 6500 = neutral'],
  ['tint','Tint',-100,100,1,'− green · + magenta'],
  ['saturation','Saturation',0,2,.01,''],
  ['warmHighlights','Warm highlights',0,1.5,.01,'split-tone: amber in the brights'],
  ['coolShadows','Cool shadows',0,1,.01,'split-tone: blue in the darks'],
 ]],
 ['Local exposure & effects',[
  ['liftMax','Shadow lift max (EV)',0,4,.05,'local exposure for deep shade'],
  ['liftStrength','Shadow lift strength',0,1,.01,''],
  ['bloom','Bloom',0,4,.05,''],
  ['vignette','Vignette',0,1.5,.01,''],
 ]],
];
export const PARAM_KEYS=GRADE_PARAMS.flatMap(([,items])=>items.map(i=>i[0]));

// Keyframes sit at a position u along the playable day (0 = sunrise+20 min, 1 = sunset-20 min, renderer.sunWindow), so
// they follow the sun on any date or course. Defaults: golden hour at both ends, the midday grade at solar noon (u = .5).
const EDGE={ev:.3,contrast:1.23,shoulderKnee:.7,blackPoint:.018,whitePoint:.99,gamma:1.03,hueBlend:1,hdrHeadroom:3,
 temperature:9800,tint:13,saturation:1.13,warmHighlights:.85,coolShadows:.18,liftMax:3,liftStrength:.5,bloom:1,vignette:.34};
const NOON={ev:-.45,contrast:.97,shoulderKnee:.3,blackPoint:0,whitePoint:.5,gamma:1.45,hueBlend:.76,hdrHeadroom:3,
 temperature:7200,tint:7,saturation:1.12,warmHighlights:0,coolShadows:0,liftMax:3.35,liftStrength:.85,bloom:.9,vignette:.62};
export const DEFAULT_KEYS=[{u:0,g:{...EDGE}},{u:.5,g:{...NOON}},{u:1,g:{...EDGE}}];
// hour <-> day position for a sun window {start,end}
export const dayPos=(hour,W)=>W?(hour-W.start)/Math.max(W.end-W.start,1e-3):(hour-6)/12;
export const posHour=(u,W)=>W?W.start+u*(W.end-W.start):6+u*12;

const ss=t=>t*t*(3-2*t);
// Grade at day position u: hold the first/last key outside their range, smoothstep between neighbours. Temperature blends
// in mireds (1e6/K), which is how a white-balance change is perceived.
export function gradeAt(u,keys=DEFAULT_KEYS){const K=[...keys].sort((a,b)=>a.u-b.u);if(!K.length)return {...NOON};
 if(u<=K[0].u)return {...K[0].g};if(u>=K[K.length-1].u)return {...K[K.length-1].g};
 let i=0;while(i<K.length-2&&u>K[i+1].u)i++;const a=K[i],b=K[i+1];const t=ss(Math.min(1,Math.max(0,(u-a.u)/Math.max(b.u-a.u,1e-6))));
 const o={};for(const k of PARAM_KEYS){const x=a.g[k]??NOON[k],y=b.g[k]??NOON[k];o[k]=k==='temperature'?1e6/((1e6/x)*(1-t)+(1e6/y)*t):x+(y-x)*t;}return o;}

// White balance gains from a colour temperature + tint (Lightroom semantics: the slider names the light being corrected
// for, so a higher value warms the image). Planckian locus (Kim et al. cubic fit) -> XYZ -> linear sRGB; gains
// normalised to unit luminance so white balance never changes brightness.
function planckRGB(T){T=Math.min(25000,Math.max(1667,T));
 const x=T<4000?-0.2661239e9/T**3-0.2343589e6/T**2+0.8776956e3/T+0.179910:-3.0258469e9/T**3+2.1070379e6/T**2+0.2226347e3/T+0.240390;
 const y=T<2222?-1.1063814*x**3-1.34811020*x**2+2.18555832*x-0.20219683:T<4000?-0.9549476*x**3-1.37418593*x**2+2.09137015*x-0.16748867:3.0817580*x**3-5.87338670*x**2+3.75112997*x-0.37001483;
 const X=x/y,Z=(1-x-y)/y;return [3.2406*X-1.5372-.4986*Z,-.9689*X+1.8758+.0415*Z,.0557*X-.2040+1.0570*Z];}
const REF=planckRGB(6500);
export function wbGains(T,tint){const p=planckRGB(T);const t=(tint||0)/100*.25;const g=[REF[0]/p[0]*(1+.5*t),REF[1]/p[1]*(1-t),REF[2]/p[2]*(1+.5*t)];
 const l=.2126*g[0]+.7152*g[1]+.0722*g[2];return g.map(v=>v/l);}

// Accept pasted settings in any shape: a full keyframe set, one grade, or the previous panel's day/golden keys.
export function normaliseGrade(o){if(!o||typeof o!=='object')return null;const g={};
 const map={manualEV:'ev',contrastDay:'contrast',whiteMin:'whitePoint',gammaDay:'gamma',acesBlend:'hueBlend',localLiftMax:'liftMax',localLiftSlope:'liftStrength',warmKey:'warmHighlights'};
 for(const [k,v] of Object.entries(o)){const kk=map[k]||k;if(PARAM_KEYS.includes(kk)&&typeof v==='number'&&isFinite(v))g[kk]=v;}return Object.keys(g).length?g:null;}
