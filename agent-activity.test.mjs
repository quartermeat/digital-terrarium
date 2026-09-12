import test from 'node:test';
import assert from 'node:assert/strict';
import {agentFresh,chooseAgentTarget} from './agent-activity.mjs';

test('agent freshness rejects stale and future reports',()=>{
 const now=Date.now(), base={version:1,phase:'tool',sampledAt:new Date(now).toISOString()};
 assert.equal(agentFresh(base,now),true);
 assert.equal(agentFresh({...base,sampledAt:new Date(now-6000).toISOString()},now),false);
 assert.equal(agentFresh({...base,sampledAt:new Date(now+100).toISOString()},now),false);
});

test('idle, waiting, and error reports stay fresh regardless of age',()=>{
 const now=Date.now(), ancient=new Date(now-3600000).toISOString();
 for(const phase of ['idle','waiting','error']){
  assert.equal(agentFresh({version:1,phase,sampledAt:ancient},now),true);
 }
 assert.equal(agentFresh({version:1,phase:'tool',sampledAt:ancient},now),false);
});

test('agent targets processes, longest filesystem mount, then busiest threads',()=>{
 const creatures=[{x:.1,y:.2,group:{name:'electron',running:0,cpu:.5}},{x:.7,y:.4,group:{name:'llama-server',running:2,cpu:.1}}];
 const disks=[{mount:'/'},{mount:'/home'}];
 assert.equal(chooseAgentTarget({target:{kind:'process',name:'llama'}},creatures,disks,100,100).x,70);
 assert.equal(chooseAgentTarget({target:{kind:'filesystem',name:'/home/me/file'}},creatures,disks,100,100).label,'filesystem /home');
 assert.equal(chooseAgentTarget({},creatures,disks,100,100).label,'active threads');
});
