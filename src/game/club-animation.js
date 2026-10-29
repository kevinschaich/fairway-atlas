// Power controls the shot, while the visible backswing reaches its full arc
// earlier. Sharing this curve with release prevents a snap when the meter stops.
// fraction = power/110: the top of the backswing is exactly 110%. Sine ease-in-out: slow takeaway, smooth set at the top.
export const BACKSWING_TOP=2.75;
export function clubBackswing(fraction,putter=false){const f=Math.min(1,Math.max(0,fraction));return (.5-.5*Math.cos(Math.PI*f))*(putter?.32:BACKSWING_TOP);}
export function clubReleaseMs(putter=false){return putter?160:190;}
export function clubSwingAt(seconds,back,releaseMs,putter=false){
 return seconds<0?-back*Math.sin(Math.min(1,-seconds/(releaseMs/1000))*Math.PI/2):(putter?.36:2.45)*Math.sin(Math.min(1,seconds/(putter?.15:.22))*Math.PI/2);
}
