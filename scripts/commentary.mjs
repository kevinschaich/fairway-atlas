// Generates the commentary voice lines with ElevenLabs from public/commentary/script.json.
//   npm run commentary            generate new / changed lines only (tracked by a hash of voice + model + settings + text)
//   npm run commentary -- --force regenerate everything
//   npm run commentary -- <id>..  regenerate just these exchanges
// Needs ELEVENLABS_API_KEY in the environment or in .env at the repo root. Audio: public/commentary/audio/<id>-<n>-<who>.mp3
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';import {existsSync,readdirSync} from 'node:fs';import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url),dir=new URL('public/commentary/',root),audio=new URL('audio/',dir);
const env=Object.fromEntries((existsSync(new URL('.env',root))?await readFile(new URL('.env',root),'utf8'):'').split('\n').map(l=>l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map(m=>[m[1],m[2].replace(/^['"]|['"]$/g,'')]));
const KEY=process.env.ELEVENLABS_API_KEY||env.ELEVENLABS_API_KEY;
export const lineFile=(id,i,who)=>`audio/${id}-${i+1}-${who}.mp3`;
export const speakText=(voice,text)=>voice.model==='eleven_v3'?text:text.replace(/\[[^\]]*\]\s*/g,'').trim();   // v2 voices would read the tags aloud
export async function generate({force=false,only=[]}={}){
 if(!KEY)throw Error('Set ELEVENLABS_API_KEY (environment or .env at the repo root)');
 const script=JSON.parse(await readFile(new URL('script.json',dir),'utf8'));await mkdir(audio,{recursive:true});
 const ledgerPath=new URL('generated.json',dir);const ledger=existsSync(ledgerPath)?JSON.parse(await readFile(ledgerPath,'utf8')):{};
 const jobs=[];for(const ex of script.exchanges)ex.lines.forEach((l,i)=>{const v=script.voices[l.who];if(!v)throw Error(`${ex.id}: unknown voice "${l.who}"`);
  const text=speakText(v,l.text),file=lineFile(ex.id,i,l.who),hash=createHash('sha1').update(JSON.stringify([v.voiceId,v.model,v.settings,text])).digest('hex').slice(0,16);
  if(force||(only.length&&only.includes(ex.id))||ledger[file]!==hash||!existsSync(new URL(file,dir)))if(!only.length||only.includes(ex.id))jobs.push({file,hash,text,v});});
 let done=0,failed=0;const run=async j=>{for(let attempt=0;attempt<3;attempt++){try{
   const r=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${j.v.voiceId}?output_format=mp3_44100_128`,{method:'POST',headers:{'xi-api-key':KEY,'Content-Type':'application/json'},body:JSON.stringify({text:j.text,model_id:j.v.model,voice_settings:j.v.settings})});
   if(!r.ok)throw Error(r.status+' '+(await r.text()).slice(0,200));const tmp=new URL(j.file+'.part',dir);await writeFile(tmp,Buffer.from(await r.arrayBuffer()));await rename(tmp,new URL(j.file,dir));
   ledger[j.file]=j.hash;done++;await writeFile(ledgerPath,JSON.stringify(ledger,null,1));console.log('✓',j.file);return;}catch(e){if(attempt===2){failed++;console.warn('✗',j.file,e.message);}else await new Promise(r=>setTimeout(r,1500*(attempt+1)));}}};
 const q=[...jobs];await Promise.all(Array.from({length:3},async()=>{while(q.length)await run(q.shift());}));
 await writeFile(ledgerPath,JSON.stringify(ledger,null,1));
 const wanted=new Set(script.exchanges.flatMap(ex=>ex.lines.map((l,i)=>lineFile(ex.id,i,l.who).slice(6))));const orphans=readdirSync(audio).filter(f=>f.endsWith('.mp3')&&!wanted.has(f));
 console.log(`Commentary: ${done} generated, ${failed} failed, ${script.exchanges.length} exchanges.`+(orphans.length?` ${orphans.length} audio files no longer in the script: ${orphans.join(', ')}`:''));
 return {done,failed,orphans};}
if(import.meta.url===`file://${process.argv[1]}`){const a=process.argv.slice(2);await generate({force:a.includes('--force'),only:a.filter(x=>!x.startsWith('--'))}).catch(e=>{console.error(e.message);process.exit(1);});}
