// Visual debug > Grade: one unified grade, keyframed over the time of day (gpu/grade.js). Pick a keyframe, edit its
// sliders; the renderer blends smoothly between keyframes as the time-of-day slider moves. Keyframes persist in
// localStorage ('fa-grade-keys'). Double-click a label to reset that value on the selected keyframe.
import {GRADE_PARAMS,PARAM_KEYS,DEFAULT_KEYS,gradeAt,normaliseGrade,dayPos,posHour} from './gpu/grade.js';
const R=()=>window.__r;
const KEY='fa-grade-keys-v4';   // v3: keyframes live at day positions u (0 = sunrise+20 min, 1 = sunset-20 min); older saved sets are ignored
const clone=o=>JSON.parse(JSON.stringify(o));
export function loadKeys(){try{const k=JSON.parse(localStorage.getItem(KEY)||'null');if(Array.isArray(k)&&k.length&&k.every(x=>typeof x.u==='number'&&x.g))return k.map(x=>({u:x.u,g:{...gradeAt(x.u,DEFAULT_KEYS),...x.g}}))}catch{}return clone(DEFAULT_KEYS)}
function saveKeys(k){try{localStorage.setItem(KEY,JSON.stringify(k))}catch{}}
export function applyGrade(){const g=R()?.gpu;if(g)g.gradeKeys=loadKeys();}
const hourNow=()=>R()?.lighting?.hour??12;const W=()=>R()?.sunWindow;const uNow=()=>dayPos(hourNow(),W());const kClock=k=>clock(posHour(k.u,W()));
const clock=h=>{const m=Math.round(h*60)%1440;const H=Math.floor(m/60),M=m%60;return `${(H+11)%12+1}:${String(M).padStart(2,'0')} ${H<12?'AM':'PM'}`};
const fmt=(v,st)=>st>=1?String(Math.round(v)):(+v).toFixed(st<.001?4:st<.01?3:2);
const stepOf=k=>{for(const [,it] of GRADE_PARAMS)for(const i of it)if(i[0]===k)return i[4];return .01};

export function installGradePanel(host){
 if(host.querySelector('#vdGrade'))return;
 let keys=loadKeys(),sel=0;
 const box=document.createElement('details');box.id='vdGrade';box.className='vd-perf vd-grade';
 box.innerHTML=`<summary><b>Grade</b></summary><div class="vd-grade-body">
  <output id="vgInfo" class="vd-out"></output>
  <label>Keyframe <span class="vg-ctl"><select id="vgKey"></select><button id="vgGo" title="Set the time of day to this keyframe">Go to</button></span></label>
  <div class="vd-row"><button id="vgAdd" title="New keyframe at the current time of day, starting from the blended grade">+ Key at current time</button><button id="vgMove" title="Move the selected keyframe to the current time of day">Move key here</button><button id="vgDel">Delete key</button></div>
  ${GRADE_PARAMS.map(([name,items])=>`<details class="vd-grp" open><summary>${name}</summary>${items.map(([k,l,a,b,st,h])=>`<label title="${h}"><span data-k="${k}">${l}</span><span class="vg-ctl"><input type="range" data-key="${k}" min="${a}" max="${b}" step="${st}"><output data-o="${k}"></output></span></label>`).join('')}</details>`).join('')}
  <div class="vd-row"><button id="vgCopy">Copy all</button><button id="vgPaste">Paste…</button><button id="vgReset">Reset to defaults</button></div>
  <div id="vgPasteBox" hidden><textarea id="vgPasteTxt" rows="4" placeholder="Paste copied settings: all keyframes, or one grade (applies to the selected keyframe)" style="width:100%;font:11px ui-monospace,monospace"></textarea>
   <div class="vd-row"><button id="vgPasteApply">Apply</button><button id="vgPasteCancel">Cancel</button></div></div></div>`;
 host.append(box);
 const $=q=>box.querySelector(q),keySel=$('#vgKey'),info=$('#vgInfo');let hold=0;const msg=t=>{info.textContent=t;hold=performance.now()+4000};
 const commit=()=>{keys.sort((a,b)=>a.u-b.u);saveKeys(keys);const gp=R()?.gpu;if(gp)gp.gradeKeys=clone(keys)};
 const renderKeys=()=>{keySel.innerHTML=keys.map((k,i)=>`<option value="${i}">${kClock(k)}${k.u<=0?' (sunrise+20m)':k.u>=1?' (sunset−20m)':''}</option>`).join('');keySel.value=sel;$('#vgDel').disabled=keys.length<2};
 const renderVals=()=>{const g=keys[sel].g;for(const k of PARAM_KEYS){const el=$(`[data-key="${k}"]`);el.value=g[k];$(`[data-o="${k}"]`).textContent=fmt(g[k],stepOf(k))}};
 const renderAll=()=>{renderKeys();renderVals()};
 const setTime=h=>{window.__dbg?.setTime?.(h)};
 keySel.onchange=()=>{sel=+keySel.value;renderVals();setTime(posHour(keys[sel].u,W()))};
 $('#vgGo').onclick=()=>setTime(posHour(keys[sel].u,W()));
 $('#vgAdd').onclick=()=>{const u=Math.min(1,Math.max(0,uNow()));const i=keys.findIndex(k=>Math.abs(k.u-u)<.002);if(i>=0){sel=i}else{const nk={u,g:gradeAt(u,keys)};keys.push(nk);commit();sel=keys.indexOf(nk)}renderAll()};
 $('#vgMove').onclick=()=>{const u=Math.min(1,Math.max(0,uNow()));if(keys.some((k,i)=>i!==sel&&Math.abs(k.u-u)<.002))return;const cur=keys[sel];cur.u=u;commit();sel=keys.indexOf(cur);renderAll()};
 $('#vgDel').onclick=()=>{if(keys.length<2)return;keys.splice(sel,1);sel=Math.min(sel,keys.length-1);commit();renderAll()};
 box.addEventListener('input',e=>{const k=e.target.dataset?.key;if(!k)return;keys[sel].g[k]=+e.target.value;$(`[data-o="${k}"]`).textContent=fmt(e.target.value,stepOf(k));commit()});
 box.addEventListener('dblclick',e=>{const k=e.target.dataset?.k;if(!k)return;keys[sel].g[k]=gradeAt(keys[sel].u,DEFAULT_KEYS)[k];commit();renderVals()});
 $('#vgReset').onclick=()=>{keys=clone(DEFAULT_KEYS);sel=0;commit();renderAll()};
 $('#vgCopy').onclick=async()=>{const txt=JSON.stringify({keys:keys.map(k=>({u:+k.u.toFixed(4),time:kClock(k),g:Object.fromEntries(PARAM_KEYS.map(p=>[p,+(+k.g[p]).toFixed(4)]))}))});
  try{await navigator.clipboard.writeText(txt);msg(`Copied all ${keys.length} keyframes (every value)`)}catch{$('#vgPasteBox').hidden=false;const ta=$('#vgPasteTxt');ta.value=txt;ta.select();msg('Clipboard blocked: the settings are selected below, press Cmd+C')}};
 $('#vgPaste').onclick=()=>{$('#vgPasteBox').hidden=false;$('#vgPasteTxt').focus()};
 $('#vgPasteCancel').onclick=()=>{$('#vgPasteBox').hidden=true;$('#vgPasteTxt').value=''};
 $('#vgPasteApply').onclick=()=>{let o;try{o=JSON.parse($('#vgPasteTxt').value)}catch{msg('Paste: not valid JSON');return}
  const list=Array.isArray(o)?o:Array.isArray(o?.keys)?o.keys:null;
  if(list){const nk=list.map(k=>{const u=typeof k.u==='number'?k.u:dayPos(+k.hour,W());return {u,g:{...gradeAt(u,DEFAULT_KEYS),...(normaliseGrade(k.g??k)||{})}}}).filter(k=>isFinite(k.u));if(!nk.length){msg('Paste: no keyframes found');return}keys=nk;sel=0;msg(`Pasted ${nk.length} keyframes`)}
  else{const g=normaliseGrade(o);if(!g){msg('Paste: no grade values found');return}Object.assign(keys[sel].g,g);msg(`Pasted ${Object.keys(g).length} values into the ${kClock(keys[sel])} key`)}
  commit();renderAll();$('#vgPasteBox').hidden=true;$('#vgPasteTxt').value=''};
 // live readout: where the current time sits between keyframes
 setInterval(()=>{if(!box.open||!box.closest('details#visualDebug')?.open||performance.now()<hold)return;const u=uNow();const K=[...keys].sort((a,b)=>a.u-b.u);
  let st;const at=K.find(k=>Math.abs(k.u-u)<.002);if(at)st=`on the ${kClock(at)} keyframe`;else if(u<K[0].u)st=`holding ${kClock(K[0])}`;else if(u>K[K.length-1].u)st=`holding ${kClock(K[K.length-1])}`;
  else{let i=0;while(u>K[i+1].u)i++;st=`blending ${kClock(K[i])} → ${kClock(K[i+1])} (${Math.round((u-K[i].u)/(K[i+1].u-K[i].u)*100)}%)`}
  const w=W();info.textContent=`Now ${clock(hourNow())} · ${st} · editing ${kClock(keys[sel])}${w?` · sun ${clock(w.rise)}–${clock(w.set)}`:''}${R()?.gpu?.hdrOut?' · HDR':' · SDR'}`;if(document.activeElement!==keySel)renderKeys()},500);
 // start on the keyframe nearest the current time
 {const u=uNow();let b=0;keys.forEach((k,i)=>{if(Math.abs(k.u-u)<Math.abs(keys[b].u-u))b=i});sel=b}
 renderAll();commit();
}
