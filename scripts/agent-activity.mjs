#!/usr/bin/env node
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const directory = process.env.TERRARIUM_AGENT_STATE_DIR || join(homedir(), '.local', 'state', 'digital-terrarium', 'agents');
const clean = value => /^[a-zA-Z0-9_. /:@+-]{0,96}$/.test(value || '') ? value : '';
const requestedID = process.env.TERRARIUM_AGENT_ID || 'local-operator';
if(!/^[a-zA-Z0-9_.-]{1,48}$/.test(requestedID))throw Error('invalid agent ID');
const id = requestedID;
const target = join(directory, id + '.json');

async function publish(phase, detail = '', kind = '', name = '') {
 if (!['idle','thinking','working','tool','waiting','error'].includes(phase)) throw Error('invalid phase');
 if (!['','process','filesystem'].includes(kind)) throw Error('target kind must be process or filesystem');
 const activity = {version:1,id,name:clean(process.env.TERRARIUM_AGENT_NAME || 'Local operator'),sampledAt:new Date().toISOString(),phase};
 if (clean(detail)) activity.detail=clean(detail);
 if (kind && clean(name)) activity.target={kind,name:clean(name)};
 await mkdir(directory,{recursive:true,mode:0o700});
 const temporary=target+'.'+process.pid+'.tmp';
 await writeFile(temporary,JSON.stringify(activity)+'\n',{mode:0o600});
 await rename(temporary,target);
}

async function demo() {
 const sequence=[
  ['thinking','mapping system','process','llama-server'],
  ['tool','reading project','filesystem','/home/quartermeat/work/digital-terrarium'],
  ['working','following threads','process','electron'],
  ['tool','inspecting storage','filesystem','/'],
  ['waiting','ready for direction','',''],
 ];
 for (const step of sequence) for(let tick=0;tick<12;tick++){await publish(...step);await new Promise(resolve=>setTimeout(resolve,750));}
 await rm(target,{force:true});
}

async function run(detail,kind,name,command) {
 if(!command.length)throw Error('run requires a command after --');
 let stopping=false;
 const heartbeat=()=>publish('working',detail,kind,name).catch(error=>{if(!stopping)console.error(error.message);});
 await heartbeat();
 const timer=setInterval(heartbeat,1000);timer.unref();
 const child=spawn(command[0],command.slice(1),{stdio:'inherit',env:process.env});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
 const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 stopping=true;clearInterval(timer);
 const failed=result.code!==0||result.signal;
 // Keep the terminal state visible briefly, then leave no immortal agent behind.
 for(let tick=0;tick<4;tick++){await publish(failed?'error':'waiting',failed?'command failed':'completed',kind,name);await new Promise(resolve=>setTimeout(resolve,750));}
 await rm(target,{force:true});
 if(result.signal)process.kill(process.pid,result.signal);
 process.exitCode=result.code??1;
}

const args=process.argv.slice(2),command=args.shift()||'help';
if(command==='publish'){const [phase,detail='',kind='',...nameParts]=args;await publish(phase,detail,kind,nameParts.join(' '));}
else if(command==='run'){
 const divider=args.indexOf('--');if(divider<0)throw Error('run requires -- before the command');
 const [detail='running command',kind='',...nameParts]=args.slice(0,divider);
 await run(detail,kind,nameParts.join(' '),args.slice(divider+1));
}
else if(command==='stop') await rm(target,{force:true});
else if(command==='demo') await demo();
else {
 console.log('Usage: node scripts/agent-activity.mjs publish PHASE [DETAIL] [process|filesystem] [TARGET]');
 console.log('       node scripts/agent-activity.mjs run DETAIL [process|filesystem] [TARGET] -- COMMAND [ARG...]');
 console.log('       node scripts/agent-activity.mjs demo | stop');
 process.exitCode=command==='help'?0:2;
}
