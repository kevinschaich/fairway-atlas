import './net-cache.js';
// Network requests stay in the end user's browser. Isolating the abort timer
// prevents main-thread rendering/compilation from extending provider deadlines.
import {requestProviders,facilityBounds,mergeProviderCooldowns} from './data-sources.js';
import {parseRouting,joinRings} from './course-data.js';
self.onmessage=async({data:m})=>{
 if(m.type!=='request')return;
 mergeProviderCooldowns(m.cooldowns);
 try{
  const data=await requestProviders(m.item,m.stage,{bbox:m.bbox,order:m.order,deadlineMs:m.deadlineMs,onAttempt:row=>self.postMessage({type:'attempt',row}),validateResult:data=>{
   if(m.validation==='boundary'){
    facilityBounds(data,m.item);if(!joinRings(data.elements.find(e=>e.type===m.item.source.type&&e.id===m.item.source.id)||{}).length)throw Error('No closed course boundary');
   }else if(m.validation!=='scenery'){
    const elements=new Map(data.elements.map(e=>[e.type+'/'+e.id,e]));for(const e of m.validationData?.facility?.elements||[])elements.set(e.type+'/'+e.id,e);
    parseRouting(m.item,{...data,elements:[...elements.values()]});
   }
  }});
  self.postMessage({type:'result',data});
 }catch(error){self.postMessage({type:'error',name:error.name,message:error.message})}
};
