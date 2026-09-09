// WebGL2 transform feedback executes the vertex shader once per creature,
// capturing state without rasterizing pixels. No experimental GPU flags needed.
export async function createGLCreatureCompute(count) {
 const canvas=document.createElement('canvas');
 const gl=canvas.getContext('webgl2');
 if(!gl)throw Error('WebGL2 unavailable');
 const buffers=[],shaders=[];
 let program,vao,feedback;
 const destroy=()=>{buffers.forEach(b=>gl.deleteBuffer(b));shaders.forEach(s=>gl.deleteShader(s));if(program)gl.deleteProgram(program);if(vao)gl.deleteVertexArray(vao);if(feedback)gl.deleteTransformFeedback(feedback);gl.getExtension('WEBGL_lose_context')?.loseContext();};
 try{
  const response=await fetch(new URL('./creature-compute.vert',import.meta.url));
  if(!response.ok)throw Error('GL creature shader unavailable');
  const compile=(type,source)=>{const s=gl.createShader(type);shaders.push(s);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
  program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,await response.text()));
  gl.attachShader(program,compile(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(0.);}'));
  gl.transformFeedbackVaryings(program,['nextBody','nextState','result'],gl.INTERLEAVED_ATTRIBS);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  vao=gl.createVertexArray();gl.bindVertexArray(vao);
  for(let i=0;i<2;i++){const b=gl.createBuffer();buffers.push(b);gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,count*48,gl.DYNAMIC_COPY);}
  gl.bindBuffer(gl.ARRAY_BUFFER,buffers[0]);
  for(let i=0;i<2;i++){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,4,gl.FLOAT,false,48,i*16);}
  feedback=gl.createTransformFeedback();
  const params=gl.getUniformLocation(program,'params'),foodCount=gl.getUniformLocation(program,'foodCount'),food=gl.getUniformLocation(program,'food[0]');
  let destroyed=false;
  return {
   label:'GPU / WebGL2 transform feedback',
   async step(creatures,packets,dt,time,aquarium){
    if(destroyed||gl.isContextLost())throw Error('GL compute context lost');
    const data=new Float32Array(count*12);
    creatures.forEach((c,i)=>data.set([c.x,c.y,c.phase,c.speed,c.energy,c.nibble??0,c.heading??0,0,-1,0,0,0],i*12));
    gl.useProgram(program);gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffers[0]);gl.bufferSubData(gl.ARRAY_BUFFER,0,data);
    gl.uniform4f(params,dt,time,aquarium?1:0,count);gl.uniform1i(foodCount,packets.length);
    if(packets.length)gl.uniform2fv(food,new Float32Array(packets.flatMap(p=>[p.x,p.y])));
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,feedback);gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,buffers[1]);
    gl.enable(gl.RASTERIZER_DISCARD);gl.beginTransformFeedback(gl.POINTS);gl.drawArrays(gl.POINTS,0,count);gl.endTransformFeedback();gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,null);gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,null);
    gl.bindBuffer(gl.COPY_READ_BUFFER,buffers[1]);gl.getBufferSubData(gl.COPY_READ_BUFFER,0,data);gl.bindBuffer(gl.COPY_READ_BUFFER,null);
    if(gl.getError()!==gl.NO_ERROR||gl.isContextLost()||!data.every(Number.isFinite))throw Error('GL compute failed');
    creatures.forEach((c,i)=>{const n=i*12;Object.assign(c,{x:data[n],y:data[n+1],energy:data[n+4],nibble:data[n+5],heading:data[n+6],activity:['scurrying','scanning','nibbling'][Math.round(data[n+7])],target:Math.round(data[n+8]),distance:data[n+9]});});
   },
   destroy(){if(!destroyed){destroyed=true;destroy();}},
  };
 }catch(error){destroy();throw error;}
}
