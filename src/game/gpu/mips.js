// Mipmap generation by successive linear blits (render pass per level).
const CODE=/*wgsl*/`
@group(0) @binding(0) var src:texture_2d<f32>;@group(0) @binding(1) var s:sampler;
struct VO{@builtin(position) p:vec4f,@location(0) uv:vec2f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{let q=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:VO;o.p=vec4f(q*2.-1.,0.,1.);o.uv=vec2f(q.x,1.-q.y);return o;}
@fragment fn fs(v:VO)->@location(0) vec4f{return textureSample(src,s,v.uv);}`;
const pipes=new Map();
export const mipCount=(w,h)=>Math.floor(Math.log2(Math.max(w,h)))+1;
export function generateMips(dev,tex,layers=1){const fmt=tex.format;let p=pipes.get(dev.label+fmt);
 if(!p){const m=dev.createShaderModule({code:CODE});p={pipe:dev.createRenderPipeline({layout:'auto',vertex:{module:m,entryPoint:'vs'},fragment:{module:m,entryPoint:'fs',targets:[{format:fmt}]},primitive:{topology:'triangle-list'}}),samp:dev.createSampler({minFilter:'linear',magFilter:'linear'})};pipes.set(dev.label+fmt,p);}
 const enc=dev.createCommandEncoder();
 for(let k=0;k<layers;k++)for(let l=1;l<tex.mipLevelCount;l++){const v=m=>tex.createView({dimension:'2d',baseArrayLayer:k,arrayLayerCount:1,baseMipLevel:m,mipLevelCount:1});const bg=dev.createBindGroup({layout:p.pipe.getBindGroupLayout(0),entries:[{binding:0,resource:v(l-1)},{binding:1,resource:p.samp}]});
  const pass=enc.beginRenderPass({colorAttachments:[{view:v(l),loadOp:'clear',storeOp:'store'}]});pass.setPipeline(p.pipe);pass.setBindGroup(0,bg);pass.draw(3);pass.end();}
 dev.queue.submit([enc.finish()]);}
