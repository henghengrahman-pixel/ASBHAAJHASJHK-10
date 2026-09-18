import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LiveChatClient} from '../src/livechat.js';
import {OpenAIClient} from '../src/ai.js';

function lcError(status,message){const e=new Error(`LIVECHAT_${status}: ${message}`);e.status=status;return e;}

test('v1.33.2 public-agent capacity falls back to agent-only membership without evicting humans',async()=>{
  const calls=[];
  const lc=new LiveChatClient({base:'http://local',accountId:'agent@example.com',requesterUserId:'agent@example.com',pat:'p'});
  let sends=0;
  lc.call=async(action,body,options)=>{
    calls.push({action,body,options});
    if(action==='send_event' && sends++===0) throw lcError(403,'Requester is not user of the chat');
    if(action==='add_user_to_chat' && body.visibility==='all') throw lcError(422,'Public agents in chat limit reached');
    if(action==='add_user_to_chat' && body.visibility==='agents') return {};
    if(action==='send_event') return {event_id:'out-private-membership'};
    throw new Error(`unexpected ${action}`);
  };
  const out=await lc.sendMessage('c1','halo');
  assert.equal(out.event_id,'out-private-membership');
  assert.equal(calls.map(x=>x.action).join(','),'send_event,add_user_to_chat,add_user_to_chat,send_event');
  assert.equal(calls[1].body.visibility,'all');
  assert.equal(calls[2].body.visibility,'agents');
  assert.equal(calls[2].body.ignore_requester_presence,true);
});

test('v1.33.2 structured JSON uses schema mode and the dedicated non-truncating token budget',async()=>{
  const client=new OpenAIClient();
  client.ready=()=>true;
  const seen=[];
  client.request=async(url,payload)=>{
    seen.push({url,payload});
    return {output:[{content:[{text:'{"ok":true}'}]}],usage:{total_tokens:4}};
  };
  const out=await client.completeJson('system',[{role:'user',content:'x'}],{name:'test_json',schema:{type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}},required:['ok']}});
  assert.equal(out.json.ok,true);
  assert.match(seen[0].url,/\/responses$/);
  assert.equal(seen[0].payload.text.format.type,'json_schema');
  assert.equal(seen[0].payload.text.format.strict,true);
  assert.ok(Number(seen[0].payload.max_output_tokens)>=512);
});

test('v1.33.2 malformed structured output gets one bounded structured retry and recovers',async()=>{
  const client=new OpenAIClient();
  client.ready=()=>true;
  let n=0;
  client.request=async()=>{
    n++;
    if(n===1) return {output:[{content:[{text:'{"ok":'}]}]};
    return {output:[{content:[{text:'{"ok":true}'}]}]};
  };
  const out=await client.completeJson('system',[{role:'user',content:'x'}],{name:'retry_json',schema:{type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}},required:['ok']}});
  assert.equal(out.json.ok,true);
  assert.equal(out.recovered,true);
  assert.equal(n,2);
});

test('v1.33.2 session boundary is audit/info, not an errors-table event, and legacy false errors are purged',()=>{
  const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
  const start=db.indexOf('export async function beginNewConversationSession');
  const block=db.slice(start,start+9000);
  assert.match(block,/eventType:'SESSION_STARTED'/);
  assert.doesNotMatch(block,/logError\('engine','NEW_SESSION_BOUNDARY'/);
  assert.match(db,/DELETE FROM errors WHERE source='engine' AND code='NEW_SESSION_BOUNDARY'/);
});
