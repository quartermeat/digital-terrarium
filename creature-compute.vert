#version 300 es
precision highp float;
layout(location=0) in vec4 body;
layout(location=1) in vec4 state;
layout(location=2) in vec4 previous;
uniform vec4 params;
uniform int foodCount;
uniform vec2 food[120];
out vec4 nextBody;
out vec4 nextState;
out vec4 result;
void main(){
 float dt=params.x, time=params.y;
 bool aquarium=params.z>.5;
 vec2 position=body.xy;
 float phase=body.z, speed=body.w;
 float energy=state.x, nibble=state.y, heading=state.z, activity=0.;
 float closest=-1., distance=1e10;
 vec2 target=vec2(.5+sin(time*.09+phase)*.43,.77+sin(time*.2+phase)*.15);
 if(aquarium)target.y=.48+cos(time*.12+phase)*.35;
 for(int j=0;j<120;j++){
  if(j>=foodCount)break;
  float d=length(food[j]-position);
  if(d<distance){distance=d;closest=float(j);target=food[j];}
 }
 vec2 delta=target-position;
 float d=length(delta), velocity=speed;
 if(!aquarium){
  nibble=max(0.,nibble-dt);
  if(sin(time*2.1+phase)>.65)activity=1.;
  if(nibble>0.)activity=2.;
  velocity*=1.65;
  if(activity>.5)velocity=0.;
 }
 if(d>0.){
  position+=delta/d*min(d,velocity*dt);
  float aim=atan(delta.y,delta.x);
  if(aquarium)heading=aim;
  else heading+=atan(sin(aim-heading),cos(aim-heading))*min(1.,dt*9.);
 }
 nextBody=vec4(position,phase,speed);
 nextState=vec4(max(.2,energy-dt*.015),nibble,heading,activity);
 result=vec4(closest,distance,0.,0.);
 gl_Position=vec4(0.,0.,0.,1.);
}
