import { createGLCreatureCompute } from './creature-compute-gl.mjs';
export async function createCreatureCompute(count) {
 try { return await createWebGPUCreatureCompute(count); }
 catch(error) { console.info('WebGPU unavailable, trying WebGL2',error);return createGLCreatureCompute(count); }
}
// Keep Canvas 2D rendering for now; read back one compact creature buffer per tick.
// Food ownership is resolved in stable creature order by the host after compute.
async function createWebGPUCreatureCompute(count) {
 if (!navigator.gpu) throw Error('WebGPU unavailable');
 const adapter = await navigator.gpu.requestAdapter();
 if (!adapter || adapter.info?.isFallbackAdapter) throw Error('Hardware compute adapter unavailable');
 const device = await adapter.requestDevice();
 try {
  const response = await fetch(new URL('./creature-compute.wgsl', import.meta.url));
  if (!response.ok) throw Error('Creature shader unavailable');
  const module = device.createShaderModule({code:await response.text()});
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter(m=>m.type==='error');
  if (errors.length) throw Error(errors.map(m=>m.message).join('\n'));
  const pipeline = await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  const bytes = count*48;
  const state = device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
  const food = device.createBuffer({size:120*8,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  const params = device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const readback = device.createBuffer({size:bytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
  const bindings=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[state,food,params].map((buffer,binding)=>({binding,resource:{buffer}}))});
  let failed=null;
  device.lost.then(info=>{failed=Error(`GPU device lost: ${info.message}`);});
  device.addEventListener('uncapturederror',event=>{failed=Error(event.error.message);});
  return {
   label: 'GPU / WebGPU compute',
   async step(creatures, packets, dt, time, aquarium) {
    if(failed)throw failed;
    const data=new Float32Array(count*12);
    creatures.forEach((c,i)=>data.set([c.x,c.y,c.phase,c.speed,c.energy,c.nibble??0,c.heading??0,0,-1,0,0,0],i*12));
    device.queue.writeBuffer(state,0,data);
    if(packets.length)device.queue.writeBuffer(food,0,new Float32Array(packets.flatMap(p=>[p.x,p.y])));
    device.queue.writeBuffer(params,0,new Float32Array([dt,time,aquarium?1:0,count,packets.length,0,0,0]));
    const encoder=device.createCommandEncoder(), pass=encoder.beginComputePass();
    pass.setPipeline(pipeline);pass.setBindGroup(0,bindings);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();
    encoder.copyBufferToBuffer(state,0,readback,0,bytes);device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const output=new Float32Array(readback.getMappedRange()).slice();readback.unmap();
    if(failed)throw failed;
    if(!output.every(Number.isFinite))throw Error('Non-finite GPU state');
    creatures.forEach((c,i)=>{const n=i*12;Object.assign(c,{x:output[n],y:output[n+1],energy:output[n+4],nibble:output[n+5],heading:output[n+6],activity:['scurrying','scanning','nibbling'][Math.round(output[n+7])],target:Math.round(output[n+8]),distance:output[n+9]});});
   },
   destroy(){device.destroy();},
  };
 } catch(error){device.destroy();throw error;}
}
