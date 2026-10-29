// Dev-server API behind the Audio lab (public/audio-lab.html): list the audio files, move / rename them between kinds,
// delete (moved to audio-trash/ at the repo root, restorable) and set a file's gain. Every change rebuilds the manifest.
import {readdir,rename,mkdir,stat,readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {existsSync} from 'node:fs';import {resolve,dirname,basename,sep} from 'node:path';
import {stat as st} from 'node:fs/promises';
const man=async()=>{const u=new URL('./audio-manifest.mjs',import.meta.url);return import(u.href+'?v='+(await st(u)).mtimeMs);};
const buildAudioManifest=async()=>(await man()).buildAudioManifest();let FOLDERS;
const AUDIO=resolve('public/audio'),TRASH=resolve('audio-trash'),REVIEWED=resolve('public/audio/reviewed.json');
// "Listened" marks, keyed by file content (sha1), so they survive renames, moves, gain changes and trash/restore;
// newly downloaded sounds are simply not in the list yet.
const hashOf=async p=>createHash('sha1').update(await readFile(p)).digest('hex').slice(0,16);
async function reviewed(){try{return JSON.parse(await readFile(REVIEWED,'utf8'));}catch{return {};}}
async function mark(file,on=true){const r=await reviewed(),h=await hashOf(file);if(on)r[h]=new Date().toISOString().slice(0,10);else delete r[h];await writeFile(REVIEWED,JSON.stringify(r,null,1));}
const inside=(p,root)=>p===root||p.startsWith(root+sep);
const json=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(obj));};
async function list(dir,base,tag){const out=[];let ents=[];try{ents=await readdir(dir,{withFileTypes:true});}catch{return out;}
 for(const e of ents){if(e.name.startsWith('.'))continue;const p=resolve(dir,e.name);if(e.isDirectory())out.push(...await list(p,base,tag));else if(/\.(mp3|ogg|wav|m4a)$/i.test(e.name)){const rel=p.slice(base.length+1).split(sep).join('/');out.push({path:rel,area:tag,size:(await stat(p)).size});}}
 return out;}
const NAME=/^([a-z0-9-]+?)--fs(\d+)((?:-\d+)?)((?:--[^/]*)?)\.(mp3|ogg|wav|m4a)$/i;
function parse(rel){const [folder,...rest]=rel.split('/');const file=rest.join('/');const m=NAME.exec(file);return m?{folder,kind:m[1].toLowerCase(),src:m[2],take:m[3].slice(1),extra:m[4],ext:m[5],gain:Number(/--g(\d*\.?\d+)/.exec(m[4])?.[1]??1)}:{folder,kind:null};}
async function body(req){let s='';for await(const c of req)s+=c;return JSON.parse(s||'{}');}
async function freeName(dir,name){let n=name,i=1;while(existsSync(resolve(dir,n))){n=name.replace(/(\.[a-z0-9]+)$/i,`--dup${i++}$1`);}return n;}
export async function audioLab(req,res,url){
 // dev-only frame capture: window.__capture(name) POSTs the game canvas here; saved to .captures/<name>.png (gitignored)
 if((url.pathname==='/__capture'||url.pathname==='/__audio/capture')&&req.method==='POST'){const name=(url.searchParams.get('name')||'frame').replace(/[^\w.-]/g,'_').slice(0,80);const chunks=[];for await(const c of req)chunks.push(c);
  const dir=new URL('../.captures/',import.meta.url);await mkdir(dir,{recursive:true});await writeFile(new URL(name+'.png',dir),Buffer.concat(chunks));res.writeHead(200,{'content-type':'text/plain'});res.end('ok');return true;}
 if(!url.pathname.startsWith('/__audio/'))return false;FOLDERS=(await man()).FOLDERS;
 try{
  if(url.pathname==='/__audio/list'&&req.method==='GET'){const rv=await reviewed();const files=[];for(const f of [...await list(AUDIO,AUDIO,'live'),...await list(TRASH,TRASH,'trash')]){const h=await hashOf(resolve(f.area==='trash'?TRASH:AUDIO,f.path));files.push({...f,...parse(f.path),hash:h,reviewed:!!rv[h]});}
   const sources=JSON.parse(await readFile(resolve(AUDIO,'sources.json'),'utf8'));const {warnings}=await buildAudioManifest();json(res,200,{files,folders:FOLDERS,sources,warnings});return true;}
  if(url.pathname.startsWith('/__audio/trashfile/')&&req.method==='GET'){const f=resolve(TRASH,decodeURIComponent(url.pathname.slice('/__audio/trashfile/'.length)));if(!inside(f,TRASH))throw Error('bad path');res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'no-store'});res.end(await readFile(f));return true;}
  // ---- commentary exchanges (public/commentary/script.json)
  if(url.pathname.startsWith('/__audio/commentary')){const SP=resolve('public/commentary/script.json');const script=JSON.parse(await readFile(SP,'utf8'));const rv=await reviewed();
   const ckey=e=>'c:'+e.id+':'+createHash('sha1').update(JSON.stringify(e.lines)).digest('hex').slice(0,12);
   if(req.method==='GET'){json(res,200,{script,reviewed:Object.fromEntries([...script.exchanges,...(script.removed||[])].map(e=>[e.id,!!rv[ckey(e)]]))});return true;}
   const b=await body(req);const all=[...script.exchanges,...(script.removed||[])];const ex=all.find(e=>e.id===b.id);if(!ex)throw Error('no exchange '+b.id);
   const files=ex.lines.map((l,i)=>`${ex.id}-${i+1}-${l.who}.mp3`);const A=resolve('public/commentary/audio'),T=resolve(TRASH,'commentary');
   if(url.pathname==='/__audio/commentary-review'){if(b.reviewed===false)delete rv[ckey(ex)];else rv[ckey(ex)]=new Date().toISOString().slice(0,10);await writeFile(REVIEWED,JSON.stringify(rv,null,1));}
   else if(url.pathname==='/__audio/commentary-delete'){script.exchanges=script.exchanges.filter(e=>e!==ex);(script.removed??=[]).push(ex);await mkdir(T,{recursive:true});for(const f of files)if(existsSync(resolve(A,f)))await rename(resolve(A,f),resolve(T,f));rv[ckey(ex)]=new Date().toISOString().slice(0,10);await writeFile(REVIEWED,JSON.stringify(rv,null,1));}
   else if(url.pathname==='/__audio/commentary-restore'){script.removed=(script.removed||[]).filter(e=>e!==ex);if(!script.removed.length)delete script.removed;script.exchanges.push(ex);for(const f of files)if(existsSync(resolve(T,f)))await rename(resolve(T,f),resolve(A,f));}
   else throw Error('unknown action');
   if(url.pathname!=='/__audio/commentary-review')await writeFile(SP,JSON.stringify(script,null,1)+'\n');json(res,200,{ok:true});return true;}
  if(req.method!=='POST'){json(res,405,{error:'POST only'});return true;}
  const b=await body(req);const srcRoot=b.area==='trash'?TRASH:AUDIO;const from=resolve(srcRoot,b.path||'');
  if(!inside(from,srcRoot)||!existsSync(from))throw Error('no such file: '+b.path);
  if(url.pathname==='/__audio/review'){await mark(from,b.reviewed!==false);json(res,200,{ok:true});return true;}
  if(url.pathname==='/__audio/review-all'){for(const pth of b.paths||[]){const f=resolve(srcRoot,pth);if(inside(f,srcRoot)&&existsSync(f))await mark(f,b.reviewed!==false);}json(res,200,{ok:true});return true;}
  const p=parse(b.path);await mark(from);   // relabel / gain / delete / restore all count as having dealt with the sound
  let destRoot=AUDIO,destDir,destName;
  if(url.pathname==='/__audio/delete'){destRoot=TRASH;destDir=resolve(TRASH,dirname(b.path));destName=basename(b.path);}
  else if(url.pathname==='/__audio/restore'){destDir=resolve(AUDIO,dirname(b.path));destName=basename(b.path);}
  else if(url.pathname==='/__audio/move'){   // {path, area, folder, kind, gain?}
   if(!p.kind)throw Error('file name has no kind/source: '+b.path);const folder=b.folder==='_unused'?'_unused':b.folder;
   if(folder!=='_unused'&&!FOLDERS[folder]?.includes(b.kind))throw Error(`unknown kind ${folder}/${b.kind}`);
   const kind=folder==='_unused'?(b.kind||p.kind):b.kind;let extra=(p.extra||'').replace(/--g\d*\.?\d+/,'');const g=b.gain??p.gain;if(Math.abs(g-1)>.005)extra=`--g${(+g).toFixed(2)}`+extra;
   destDir=resolve(AUDIO,folder);destName=`${kind}--fs${p.src}${p.take?'-'+p.take:''}${extra}.${p.ext}`;}
  else{json(res,404,{error:'unknown action'});return true;}
  if(!inside(destDir,destRoot))throw Error('bad destination');await mkdir(destDir,{recursive:true});
  if(resolve(destDir,destName)!==from)destName=await freeName(destDir,destName);const to=resolve(destDir,destName);if(to!==from)await rename(from,to);
  const {warnings}=await buildAudioManifest();json(res,200,{path:to.slice(destRoot.length+1).split(sep).join('/'),area:destRoot===TRASH?'trash':'live',warnings});
 }catch(e){json(res,400,{error:e.message});}
 return true;}
