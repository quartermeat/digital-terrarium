// Mirrors validAgent in agents.go: thinking/working/tool describe activity in
// progress and expire after five seconds, while idle/waiting/error describe a
// condition that stays true until a fresh report supersedes it.
const AT_REST_PHASES=['idle','waiting','error'];
export const agentFresh = (agent, now=Date.now()) => {
 if(agent?.version!==1)return false;
 const age=now-Date.parse(agent?.sampledAt);
 if(age<0)return false;
 if(AT_REST_PHASES.includes(agent?.phase))return true;
 return age<5000;
};

export function chooseAgentTarget(agent, creatures, disks, width, height) {
 const process = name => creatures.find(c=>c.group && c.group.name.toLowerCase().includes(name.toLowerCase()));
 if(agent?.target?.kind==='process') {
  const c=process(agent.target.name); if(c)return {x:c.x*width,y:c.y*height,label:'process '+c.group.name};
 }
 if(agent?.target?.kind==='filesystem') {
  const candidates=disks.map((disk,i)=>({disk,i})).filter(({disk})=>agent.target.name===disk.mount||agent.target.name.startsWith(disk.mount==='/'?'/':disk.mount+'/'));
  const match=candidates.sort((a,b)=>b.disk.mount.length-a.disk.mount.length)[0];
  if(match){const count=Math.min(disks.length,8);return{x:width*(.07+match.i*.57/Math.max(1,count-1)),y:height*.78,label:'filesystem '+match.disk.mount};}
 }
 const busy=creatures.filter(c=>c.group).sort((a,b)=>(b.group.running-a.group.running)||((b.group.cpu??0)-(a.group.cpu??0)))[0];
 return busy?{x:busy.x*width,y:busy.y*height,label:'active threads'}:{x:width*.5,y:height*.45,label:'system'};
}

export function agentWaypoints(agent, creatures, disks, width, height) {
 const primary=chooseAgentTarget(agent,creatures,disks,width,height);
 const points=[primary];
 for(const c of creatures)if(c.group)points.push({x:c.x*width,y:c.y*height,label:'process '+c.group.name});
 const count=Math.min(disks.length,8);
 disks.slice(0,count).forEach((disk,i)=>points.push({x:width*(.07+i*.57/Math.max(1,count-1)),y:height*.78,label:'filesystem '+disk.mount}));
 return points.filter((point,index)=>points.findIndex(other=>other.label===point.label)===index);
}
