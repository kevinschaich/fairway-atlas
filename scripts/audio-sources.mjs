// Add Freesound recordings to public/audio/sources.json (credits): node scripts/audio-sources.mjs <freesound url> [...]
import {readFile,writeFile} from 'node:fs/promises';
const path=new URL('../public/audio/sources.json',import.meta.url),db=JSON.parse(await readFile(path,'utf8'));
const LN={'publicdomain/zero/1.0':'CC0 1.0','licenses/by/3.0':'CC BY 3.0','licenses/by/4.0':'CC BY 4.0','licenses/by-nc/3.0':'CC BY-NC 3.0','licenses/by-nc/4.0':'CC BY-NC 4.0','licenses/sampling+/1.0':'Sampling+ 1.0'};
for(const url of process.argv.slice(2)){const m=/freesound\.org\/people\/([^/]+)\/sounds\/(\d+)/.exec(url);if(!m){console.warn('not a Freesound sound URL:',url);continue;}
 const html=await (await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}})).text();const title=(/og:title" content="([^"]*)"/.exec(html)?.[1]||'').replace(/ by [^ ]+$/,'').replace(/&amp;/g,'&').replace(/&#x27;|&#39;/g,"'").replace(/&quot;/g,'"');
 const lic=/href="(https?:\/\/creativecommons\.org\/([^"]+?)\/?)"/.exec(html);db[m[2]]={title,author:decodeURIComponent(m[1]),url:`https://freesound.org/people/${m[1]}/sounds/${m[2]}/`,license:lic?(LN[lic[2]]||lic[2]):'unknown',licenseUrl:lic?lic[1].replace('http://','https://'):''};
 console.log('fs'+m[2],db[m[2]].author,'·',db[m[2]].title,'·',db[m[2]].license);}
await writeFile(path,JSON.stringify(db,null,1));
