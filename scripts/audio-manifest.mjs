// Builds public/audio/manifest.json from the folder layout and file names (see public/audio/README.md) and refreshes the audio
// credits in CREDITS.md. Used by scripts/build.mjs and served live by scripts/dev.mjs.
import {readdir,readFile,writeFile} from 'node:fs/promises';
export const FOLDERS={ambience:['birds','meadow','tropical','desert','mountain','night','surf','gulls','distant-sea','lake'],whoosh:['whoosh'],impact:['driver','wood','hybrid','iron','wedge','putter'],land:['fairway','rough','green','sand','water','cup']};
const NAME=/^([a-z0-9-]+?)--fs(\d+)((?:-\d+)?)((?:--[^/]*)?)\.(mp3|ogg|wav|m4a)$/i;
export async function buildAudioManifest(root=new URL('../public/audio/',import.meta.url)){
 const sources=JSON.parse(await readFile(new URL('sources.json',root),'utf8'));const out={ambience:{},whoosh:{},impact:{},land:{},credits:[]},warnings=[],used=new Map();
 for(const [folder,kinds] of Object.entries(FOLDERS)){let files=[];try{files=(await readdir(new URL(folder+'/',root))).sort();}catch{continue}
  for(const f of files){if(f.startsWith('.'))continue;const m=NAME.exec(f);if(!m){warnings.push(`${folder}/${f}: name doesn't match <kind>--fs<id>[-nn][--g<gain>].mp3`);continue;}
   const kind=m[1].toLowerCase(),id=m[2],g=/--g(\d*\.?\d+)/.exec(m[4]);if(!kinds.includes(kind)){warnings.push(`${folder}/${f}: unknown kind "${kind}" (use ${kinds.join(', ')})`);continue;}
   if(!sources[id])warnings.push(`${folder}/${f}: fs${id} is missing from sources.json (no credit)`);
   (out[folder][kind]??=[]).push({file:`${folder}/${f}`,src:id,...(g?{gain:Number(g[1])}:{})});const u=used.get(id)||new Set();u.add(folder==='ambience'?kind+' ambience':folder==='whoosh'?'whoosh':folder==='impact'?kind+' impact':kind==='cup'?'ball in the cup':'ball landing on '+kind);used.set(id,u);}}
 out.whoosh=out.whoosh.whoosh||[];
 for(const [id,u] of used)if(sources[id])out.credits.push({id,...sources[id],usedFor:[...u].sort()});
 out.credits.sort((a,b)=>a.author.localeCompare(b.author,'en',{sensitivity:'base'})||a.id.localeCompare(b.id));
 await writeFile(new URL('manifest.json',root),JSON.stringify(out,null,1));
 // credits section of CREDITS.md (between the audio markers)
 const credPath=new URL('../../CREDITS.md',root);try{const md=await readFile(credPath,'utf8');const a='<!-- audio-credits:start -->',b='<!-- audio-credits:end -->';const i=md.indexOf(a),j=md.indexOf(b);
  if(i>=0&&j>i){const nc=out.credits.filter(c=>/NC/.test(c.license));const rows=['| Recording | Author | Licence | Used for |','|---|---|---|---|',...out.credits.map(c=>`| [${c.title.replace(/\|/g,'/')}](${c.url}) | ${c.author} | [${c.license}](${c.licenseUrl}) | ${c.usedFor.join(', ')} |`),'',
   nc.length?`**Non-commercial:** ${nc.map(c=>`${c.author} (fs${c.id})`).join(', ')} ${nc.length>1?'are':'is'} CC BY-NC. Move those files to \`public/audio/_unused/\` before any commercial release.`:'No non-commercial recordings in use.'];
   const next=md.slice(0,i+a.length)+'\n'+rows.join('\n')+'\n'+md.slice(j);if(next!==md)await writeFile(credPath,next);}}catch{}
 return {manifest:out,warnings};
}
if(import.meta.url===`file://${process.argv[1]}`){const {manifest,warnings}=await buildAudioManifest();for(const w of warnings)console.warn('audio:',w);
 console.log('Audio:',Object.entries(manifest).filter(([k])=>k!=='credits').map(([k,v])=>`${k} ${Array.isArray(v)?v.length:Object.values(v).reduce((s,x)=>s+x.length,0)}`).join(', '),'·',manifest.credits.length,'credited recordings');}
