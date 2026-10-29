// GPU/CPU memory tier. Phones and tablets share one memory pool between the page and the GPU, and iOS kills a WebKit
// tab outright (no error, the page just reloads/crashes) once it passes its per-process limit, roughly 1–2 GB depending
// on the device. The full-quality desktop engine allocates ~1.65 GB of GPU resources on a 6.5 Mpx canvas plus ~350 MB of
// JS heap, so every iPhone/iPad and most Android phones died while the course was still building.
// LOWMEM trims the fixed-size pools (grass blades, shadow map, height/mask bakes, aerial and base-map textures, tree
// impostors) and the render-resolution budget to roughly a third. It is decided once, at module load, because several
// sizes are compiled into WGSL. Override with ?lowmem=1 / ?lowmem=0.
const q=typeof location!=='undefined'?new URLSearchParams(location.search).get('lowmem'):null;
const nav=typeof navigator!=='undefined'?navigator:{};
const ua=nav.userAgent||'',touchMac=/Macintosh/.test(ua)&&(nav.maxTouchPoints||0)>1;   // iPadOS reports a desktop Mac UA
const coarse=typeof matchMedia==='function'&&matchMedia('(pointer: coarse)').matches;   // primary input is a finger (not a touch laptop)
const scr=typeof screen!=='undefined'?Math.max(screen.width||0,screen.height||0):Infinity;
// Phones and tablets up to the largest iPad Pro (13": 1032×1376 CSS px). Touch laptops keep a fine primary pointer.
export const MOBILE=(coarse||touchMac||/iPhone|iPad|iPod|Android/.test(ua)||nav.userAgentData?.mobile===true)&&scr<=1376;
const smallRam=typeof nav.deviceMemory==='number'&&nav.deviceMemory<=4;
export const LOWMEM=q==='1'||q==='true'?true:q==='0'||q==='false'?false:MOBILE||smallRam;
export const BUDGET=LOWMEM?{
 shadow:2048,heightBake:()=>2048,mask:2048,maskDetail:1024,stripes:2048,baseMap:2048,maxImage:2048,
 impostorCell:64,grass:.3,pxMax:2.2e6,pxMin:1.0e6,groundCache:120000}:{
 shadow:4096,heightBake:size=>size>2600?2048:4096,mask:4096,maskDetail:2048,stripes:null,baseMap:4096,maxImage:16384,
 impostorCell:128,grass:1,pxMax:6.5e6,pxMin:2.4e6,groundCache:400000};
