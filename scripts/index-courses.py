"""Build a compact ODbL discovery index from an Overpass tags+center extract."""
import json,sys,pathlib
source=json.load(open(sys.argv[1]));assert not source.get('remark'),source.get('remark')
rows=[]
for e in source['elements']:
 t=e.get('tags',{});center=e.get('center') or {k:e.get(k) for k in ('lat','lon')}
 if not t.get('name') or any(center.get(k) is None for k in ('lat','lon')):continue
 rows.append({'id':e['type']+'/'+str(e['id']),'name':t['name'],'aliases':' · '.join(t[k] for k in ('name:en','alt_name','short_name','old_name','operator') if t.get(k) and t[k]!=t['name']),'location':', '.join(t[k] for k in ('addr:city','addr:state','addr:country') if t.get(k)) or f"{center['lat']:.3f}°, {center['lon']:.3f}°",'center':{k:round(center[k],6) for k in ('lat','lon')}})
rows.sort(key=lambda c:c['name'].casefold())
output={'license':'ODbL-1.0','attribution':'© OpenStreetMap contributors','source':'https://overpass-api.de/api/interpreter','date':source['osm3s']['timestamp_osm_base'],'courses':rows}
path=pathlib.Path(__file__).resolve().parents[1]/'public/data/course-index.json';path.write_text(json.dumps(output,ensure_ascii=False,separators=(',',':')))
print(len(rows),'named course boundaries;',path.stat().st_size,'bytes')
