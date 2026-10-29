// NOAA solar declination equations: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
// Clock is local mean solar time at the course (longitude/15 UTC offset), not
// the player's computer timezone or a guessed civil timezone/DST rule.
export const DEFAULT_LIGHTING={hour:15.5,date:new Date().toISOString().slice(0,10),clouds:.35,fill:.26,haze:.45,exposure:-.15};
export function daylight(settings,location={lat:36.568,lon:-121.95}){
 const hour=Math.max(0,Math.min(24,settings.hour)),date=new Date((settings.date||DEFAULT_LIGHTING.date)+'T12:00:00Z'),year=date.getUTCFullYear(),day=(date-Date.UTC(year,0,1))/86400000+.5,days=(Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/86400000,g=2*Math.PI/days*(day-1+(hour-12)/24),rad=Math.PI/180;
 const eq=229.18*(.000075+.001868*Math.cos(g)-.032077*Math.sin(g)-.014615*Math.cos(2*g)-.040849*Math.sin(2*g)),decl=.006918-.399912*Math.cos(g)+.070257*Math.sin(g)-.006758*Math.cos(2*g)+.000907*Math.sin(2*g)-.002697*Math.cos(3*g)+.00148*Math.sin(3*g);
 const lat=Math.max(-89.99,Math.min(89.99,location.lat))*rad,longitude=location.lon,utcHour=hour-longitude/15,solarMinutes=utcHour*60+eq+4*longitude,ha=(solarMinutes/4-180)*rad;
 const up=Math.sin(lat)*Math.sin(decl)+Math.cos(lat)*Math.cos(decl)*Math.cos(ha),east=-Math.cos(decl)*Math.sin(ha),north=Math.cos(lat)*Math.sin(decl)-Math.sin(lat)*Math.cos(decl)*Math.cos(ha),altitude=Math.asin(Math.max(-1,Math.min(1,up)))/rad,azimuth=(Math.atan2(east,north)/rad+360)%360,warm=Math.max(0,Math.min(1,(35-altitude)/33)),daylight=Math.max(0,Math.min(1,(altitude+1)/4));
 return{altitude,azimuth,direction:[east,up,-north],color:[1,1-.24*warm,1-.49*warm],intensity:(6.5-.9*warm)*daylight*daylight*(3-2*daylight)};
}

// The playable day: the time-of-day slider runs from 20 min after sunrise to 20 min before sunset for the course's date and
// location (same clock as daylight(): local mean solar time), so both ends are always golden hour. Sunrise/sunset = the
// sun's centre crossing the horizon, found by bisection on daylight().
export function sunWindow(settings,location){const alt=h=>daylight({...settings,hour:h},location).altitude;
 const cross=(a,b)=>{let fa=alt(a);if(Math.sign(fa)===Math.sign(alt(b)))return null;for(let i=0;i<40;i++){const m=(a+b)/2,fm=alt(m);if(Math.sign(fm)===Math.sign(fa)){a=m;fa=fm}else b=m}return (a+b)/2};
 const rise=cross(0,12),set=cross(12,24);if(rise==null||set==null||set-rise<1)return {rise:6,set:18,start:6,end:18,noon:12,polar:true};
 return {rise,set,start:rise+1/3,end:set-1/3,noon:(rise+set)/2};}
