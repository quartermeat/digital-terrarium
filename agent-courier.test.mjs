import test from 'node:test';
import assert from 'node:assert/strict';
import {agentWaypoints} from './agent-activity.mjs';

test('agent courier visits its named target, live processes, and filesystem roots',()=>{
 const creatures=[{x:.1,y:.2,group:{name:'electron',running:0,cpu:.5}},{x:.7,y:.4,group:{name:'llama-server',running:2,cpu:.1}}];
 const disks=[{mount:'/'},{mount:'/home'}];
 const route=agentWaypoints({target:{kind:'process',name:'llama'}},creatures,disks,100,100);
 assert.equal(route[0].label,'process llama-server');
 assert.deepEqual(route.map(point=>point.label),['process llama-server','process electron','filesystem /','filesystem /home']);
});
