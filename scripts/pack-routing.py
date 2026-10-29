"""Join worldwide observed hole lines to course polygons. ODbL derivative.
Requires Shapely for the offline spatial join, not for the deployed app.
Incomplete/ambiguous facilities are retained as explicit unsupported coverage.
"""
import json,sys,pathlib,collections,math
from shapely.geometry import Polygon,Point,LineString
from shapely.ops import polygonize,unary_union
from shapely.strtree import STRtree
root=pathlib.Path(__file__).resolve().parents[1]/'public/data'
x=json.load(open(sys.argv[1]));assert not x.get('remark'),x.get('remark')
facilities=[];polys=[];owners=[];holes=[]
for e in x['elements']:
 t=e.get('tags',{})
 if t.get('golf')=='hole' and len(e.get('geometry',[]))>1:holes.append(e)
 if t.get('leisure')!='golf_course' or not t.get('name'):continue
 rings=[]
 if e.get('geometry'):rings=[[ (p['lon'],p['lat']) for p in e['geometry'] ]]
 elif e.get('members'):
  lines=[LineString([(p['lon'],p['lat']) for p in m['geometry']]) for m in e['members'] if m.get('role')=='outer' and len(m.get('geometry',[]))>1]
  if lines:rings=[list(p.exterior.coords) for p in polygonize(unary_union(lines))]
 valid=[]
 for ring in rings:
  if len(ring)>3:
   poly=Polygon(ring)
   if poly.is_valid and not poly.is_empty:valid.append(poly)
 if not valid:continue
 i=len(facilities);facilities.append({'source':e,'polys':valid,'holes':[]})
 for poly in valid:polys.append(poly);owners.append(i)
tree=STRtree(polys)
for h in holes:
 pt=Point(h['geometry'][0]['lon'],h['geometry'][0]['lat']);found=set()
 for j in tree.query(pt):
  if polys[j].covers(pt):found.add(owners[j])
 for owner in found:facilities[owner]['holes'].append(h)
# Do not duplicate huge outer resort routings as if they were one numbered course.
index=json.load(open(root/'course-index.json'));lookup={c['id']:c for c in index['courses']};out=root/'routing';out.mkdir(exist_ok=True)
count=0;hole_count=0;unsupported=collections.Counter()
for f in facilities:
 e=f['source'];key=e['type']+'/'+str(e['id']);hs=f['holes'];refs=[h.get('tags',{}).get('ref') for h in hs]
 if not hs:unsupported['no_holes']+=1;continue
 if len(set(refs))!=len(refs) or any(not r or not r.isdigit() for r in refs):unsupported['ambiguous']+=1;continue
 item=lookup.get(key)
 if not item:continue
 rows=[]
 for h in hs:
  t=h['tags'];par=int(t['par']) if t.get('par') in ['3','4','5','6'] else None
  rows.append({'id':h['id'],'number':int(t['ref']),'par':par,'route':[[round(p['lon'],6),round(p['lat'],6)] for p in h['geometry']]})
 # Preserve observed boundary; a 1m simplification is for preview only and is replaced by live detail.
 boundary=[[[round(a,6),round(b,6)] for a,b in poly.simplify(.000009,preserve_topology=True).exterior.coords] for poly in f['polys']]
 course={**item,'facility':item['name'],'routing':item['name'],'boundary':boundary,'holes':sorted(rows,key=lambda h:h['number']),'features':[],'sourceId':key,'date':x['osm3s']['timestamp_osm_base'][:10],'terrain':None,'stage':'preview'}
 (out/(key.replace('/','-')+'.json')).write_text(json.dumps(course,ensure_ascii=False,separators=(',',':')))
 item['routingFile']='routing/'+key.replace('/','-')+'.json';item['holes']=len(hs);count+=1;hole_count+=len(hs)
index['routingCoverage']={'courses':count,'holes':hole_count,'excluded':dict(unsupported)}
(root/'course-index.json').write_text(json.dumps(index,ensure_ascii=False,separators=(',',':')))
print(index['routingCoverage'])
