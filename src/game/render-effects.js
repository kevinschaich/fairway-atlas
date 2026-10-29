// Optional rendering systems of the WebGPU engine (Performance & effects panel, opened from the fps card). Core terrain, ball and game rules stay on.
// [key, label, what it costs, parent]
export const EFFECTS=[
 ['grass','Grass blades','Compute-scattered 3D blades and turf shells (largest cost)'],
 ['surfaceDetail','Ground detail','Turf leaves, sand grain, rough canopy and micro-relief shading'],
 ['ao','Ambient occlusion','Ground occlusion map and near-field contact occlusion'],
 ['shadows','Sun shadows','Object shadow cascades and contact shadows'],['terrainShadows','Terrain shadows','Height-field sun visibility'],
 ['clouds','Clouds','Ray-marched cloud deck and cloud shadows'],['atmosphere','Sky detail','Shadowed sun shafts through the near air'],['bloom','Bloom','Glow around bright highlights'],
 ['water','Water','Sea waves, surf, foam and reflections'],['trees','Trees & foliage','Trees and distant impostors'],['buildings','Buildings','Walls and roofs'],['tracer','Ball trail','Luminous shot ribbon']
];
export const DEFAULT_EFFECTS=Object.fromEntries(EFFECTS.map(([key])=>[key,true]));
export function cleanEffects(value={}){return Object.fromEntries(EFFECTS.filter(([key])=>typeof value?.[key]==='boolean').map(([key])=>[key,value[key]]));}
