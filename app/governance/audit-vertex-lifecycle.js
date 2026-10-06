'use strict';
// One-shot Unraid audit: qB GETs/auth only, file lstat/readdir only.
// Writes only bounded governance metadata. Never invokes torrent pause/delete.
const fs=require('fs'), path=require('path').posix, http=require('http');
const {execFileSync}=require('child_process');
const P=require('./vertex-lifecycle-policy');
const ROOT='/mnt/user/Movie/Brash';
const DIR='/mnt/user/appdata/vertex/data/governance';
const STATE=DIR+'/state.json';
const CLIENT='/mnt/user/appdata/vertex/data/client/3dfcd430.json';
const SERIAL='WDC_WUH721816ALE6L4_2CKGZZRJ';
const FENCE='/mnt/user/appdata/iyuuplus/data/vertex-exit-fence.json';
function buildFence(state,groups,old,rows) {
  const entries={};
  for(const [key,v] of Object.entries(old.exitFence||{})){
    if(state.time-v.last>=14*86400)continue;
    if(v.status==='retired')entries[key]=v;
    else if(P.exactMode(state)&&Array.isArray(rows)){
      // A path->identity migration or membership revision is not a deletion.
      // Do not manufacture 14-day tombstones for still-present payloads.
      const live=rows.filter(t=>v.members.includes(t.hash)||P.cp(t)===v.path||P.cp(t).startsWith(v.path+'/')||v.path.startsWith(P.cp(t)+'/'));
      if(!live.length)entries[key]={...v,status:'retired',last:state.time};
      else if(live.some(t=>!P.exactEngine().structure(rows,t,state,state.time).bound))entries[key]={...v,last:state.time};
    }
    else if(!state.history[key])entries[key]={...v,status:'retired',last:state.time};
    // Live groups that regain demand/yield are no longer pending exits.
  }
  for(const {key,group} of groups)entries[key]={last:state.time,status:'pending',path:P.cp(group[0]),name:group[0].name,
    savePath:String(group[0].save_path).replace(/\/$/,''),members:group.map(t=>t.hash)};
  return entries;
}
function buildHrAdmission(state,rows,entries) {
  // This proof controls NEW risky reseeds, not existing H&R or file deletion.
  // Low yield is independent of old references having met their H&R already.
  const groups={},now=state.time;
  for(const {key:identityKey,group} of P.groupEntries(rows,state,now)){
    const content=P.cp(group[0]),structure=P.structural(rows,group[0],now,state);
    if(!P.safePath(content)||structure.overlap||!group.every(P.managed))continue;
    // IYUU admission keeps its conservative physical-scope wire contract; it
    // never supplies a logical identity or a deletion permit to Vertex.
    const key=P.digest(content),up=P.delta(state.history[identityKey],7200,now);
    const live=group.reduce((n,t)=>n+Number(t.upspeed??t.uploadSpeed),0);
    const known=group.every(t=>{const hosts=P.hostsFor(t,state);return hosts.length>0&&hosts.every(h=>!!P.known[h]);});
    groups[key]={path_sig:key,time:now,members:group.map(t=>t.hash).sort(),
      complete:group.every(t=>Number(t.progress)===1&&Number(t.amount_left)===0),
      provenance_known:known,draining:entries[identityKey]?.status==='pending',
      history_complete:up!==null,window_seconds:7200,uploaded_window_bytes:up===null?0:up,
      current_upload_bps:Number.isFinite(live)&&live>=0?live:-1};
  }
  if(Object.keys(groups).length>8000)throw Error('hr_admission_budget');
  return {version:1,time:now,groups};
}
function writeFence(state,groups,old,rows=[]) {
  if(state.allSiteEnabled){
    const iyuu='/mnt/user/appdata/iyuuplus/iyuu';
    for(const [file,marker] of [
      ['/app/common/VertexExitFence.php','class VertexExitFence'],
      ['/app/admin/services/reseed/ReseedServices.php','VertexExitFence::sourceBlocked'],
      ['/app/admin/services/reseed/ReseedDownloadServices.php','VertexExitFence::additionBlocked']
    ])if(!fs.readFileSync(iyuu+file,'utf8').includes(marker))throw new Error('iyuu_fence_missing');
  }
  const entries=buildFence(state,groups,old,rows);
  if(Object.keys(entries).length>8000)throw new Error('fence_budget');
  const data={version:1,enabled:state.allSiteEnabled,time:state.time,entries,
    hrAdmission:buildHrAdmission(state,rows,entries)};
  fs.writeFileSync(FENCE+'.tmp',JSON.stringify(data),{mode:0o644});fs.chownSync(FENCE+'.tmp',99,100);fs.renameSync(FENCE+'.tmp',FENCE);
  state.exitFence=entries;state.fenceReady=true;
}
function writeState(state) {
  const data=JSON.stringify(state);
  if(Buffer.byteLength(data)>32*1024**2)throw new Error('state_size');
  fs.writeFileSync(STATE+'.tmp',data,{mode:0o600});
  fs.chownSync(STATE+'.tmp',99,100);
  fs.renameSync(STATE+'.tmp',STATE);
}
function request(url,method='GET',body='',cookie='',deadlineMs=null) {
  return new Promise((resolve,reject)=>{
    const u=new URL(url);if(u.protocol!=='http:' || !['127.0.0.1','192.168.1.188'].includes(u.hostname) || !['8088','8089'].includes(u.port))return reject(new Error('destination'));
    let timer;
    const req=http.request(u,{method,headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},r=>{
      let bytes=0,chunks=[];r.on('data',b=>{bytes+=b.length;if(bytes>32*1024*1024)req.destroy(new Error('response_size'));else chunks.push(b);});
      r.on('end',()=>{clearTimeout(timer);resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(chunks).toString()});});
    });req.setTimeout(12000,()=>req.destroy(new Error('timeout')));req.on('error',e=>{clearTimeout(timer);reject(e);});
    if(deadlineMs!==null)timer=setTimeout(()=>req.destroy(new Error('timeout')),deadlineMs);
    if(body)req.write(body);req.end();
  });
}
async function json(url,cookie='',deadlineMs=null) {const r=await request(url,'GET','',cookie,deadlineMs);if(r.status!==200)throw new Error('qbit_http');return JSON.parse(r.body);}
function peerInterestProof(snapshot,leechers){
  if(snapshot?.full_update!==true||!snapshot.peers||Array.isArray(snapshot.peers)||typeof snapshot.peers!=='object'||
    !Number.isInteger(leechers)||leechers<0)throw Error('peer_shape');
  const peers=Object.values(snapshot.peers);
  if(peers.length>10000||(!peers.length&&leechers>0))throw Error('peer_shape');
  let interested=0;
  for(const p of peers){
    if(!p||typeof p.flags!=='string')throw Error('peer_shape');
    // U/u means remote interest (unchoked/choked), not actual upload. Never use
    // relevance: qB calculates it from pieces the remote peer can give US.
    if(/[Uu]/.test(p.flags))interested++;
  }
  // Persist counters only, never peer addresses, clients or raw peer records.
  return {seen:peers.length,interested,leechers};
}
async function collectPeerInterest(group,base,cookie,budget,get=json,clock=Date.now){
  if(!budget.deadline)budget.deadline=clock()+18000;
  if(group.length>16||budget.requests+group.length>16)throw Error('peer_budget');
  const proof={version:1,time:0,members:{}};
  for(const t of group){
    const left=budget.deadline-clock();if(left<=0)throw Error('peer_budget');
    budget.requests++;
    const v=await get(base+'/api/v2/sync/torrentPeers?hash='+encodeURIComponent(t.hash)+'&rid=0',cookie,Math.min(5000,left));
    proof.members[t.hash]=peerInterestProof(v,Number(t.num_leechs??t.leecher));
  }
  proof.time=Math.floor(clock()/1000);return proof;
}
function physicalDisk() {
  const ini=fs.readFileSync('/var/local/emhttp/disks.ini','utf8');
  const section=ini.split(/(?=^\[)/m).find(s=>s.includes('id="'+SERIAL+'"'));
  if(!section || !/^\["?disk3"?\]/.test(section))throw new Error('serial_mismatch');
  const info=fs.statfsSync('/mnt/disk3');return info.bavail*info.bsize;
}
function hostPath(p,mounts) {
  const m=[...mounts].sort((a,b)=>b.Destination.length-a.Destination.length).find(x=>p===x.Destination || p.startsWith(x.Destination+'/'));
  if(!m || m.Type!=='bind')throw new Error('unmapped_other_path');
  let out=path.normalize(m.Source+p.slice(m.Destination.length));
  out=out.replace(/^\/mnt\/(?:disk\d+|user0)\/Movie\/Brash(?=\/|$)/,ROOT);
  return out;
}
function referencesOther(rows,mounts) {
  return rows.some(t=>{
    if(!t.content_path || !t.save_path)throw new Error('other_path_missing');
    const p=hostPath(t.content_path,mounts);
    return p===ROOT || p.startsWith(ROOT+'/') || ROOT.startsWith(p+'/');
  });
}
function fileAudit(group,manifests,trackers,partial=false) {
  const first=manifests[group[0].hash];
  if(!first?.length || group.some(t=>JSON.stringify(manifests[t.hash])!==JSON.stringify(first)))return {ok:false,reason:'manifest_mismatch'};
  const expected=new Map(), content=ROOT+P.cp(group[0]).slice('/downloads'.length);
  let allocated=0;
  const parents=new Set();
  for(const f of first) {
    if(!f.name || f.name.startsWith('/') || f.name.includes('\\') || f.name.includes('\0') || f.name.split('/').some(x=>['.','..',''].includes(x)))return {ok:false,reason:'unsafe_manifest'};
    const save=group[0].save_path;
    if(save!=='/downloads' && save!=='/downloads/')return {ok:false,reason:'save_path'};
    const target=path.join(ROOT,f.name);
    if(target!==content && !target.startsWith(content+'/'))return {ok:false,reason:'manifest_outside_content'};
    if(expected.has(target))return {ok:false,reason:'duplicate_manifest_path'};
    let st;try{st=fs.lstatSync(target);}catch(e){if(partial && e.code==='ENOENT')continue;throw e;}
    if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || (partial?st.size>f.size:st.size!==f.size))return {ok:false,reason:'file_attributes'};
    let parent=path.dirname(target);
    while(parent===ROOT || parent.startsWith(ROOT+'/')) {
      if(!parents.has(parent)){const s=fs.lstatSync(parent);if(!s.isDirectory()||s.isSymbolicLink())return {ok:false,reason:'symlink_parent'};parents.add(parent);}
      if(parent===ROOT)break;parent=path.dirname(parent);
    }
    allocated+=st.blocks*512;expected.set(target,1);
  }
  // Reject unknown files inside the content directory, not just manifest files.
  let visited=0,matched=0;
  function walk(p) {
    if(++visited>50000)throw new Error('file_budget');
    const s=fs.lstatSync(p);if(s.isSymbolicLink())throw new Error('symlink');
    if(s.isFile()){if(!expected.has(p))throw new Error('unmanaged_file');matched++;return;}
    if(!s.isDirectory())throw new Error('file_type');
    for(const name of fs.readdirSync(p))walk(path.join(p,name));
  }
  try{walk(content);}catch(e){
    if(!(partial&&e.code==='ENOENT'&&expected.size===0))throw e;
    // A truly empty future download has no content path yet. Still validate
    // every existing ancestor so an absent leaf behind a symlink is protected.
    let parent=path.dirname(content);
    while(parent===ROOT||parent.startsWith(ROOT+'/')){
      try{const st=fs.lstatSync(parent);if(!st.isDirectory()||st.isSymbolicLink())return {ok:false,reason:'symlink_parent'};}
      catch(err){if(err.code!=='ENOENT')throw err;}
      if(parent===ROOT)break;parent=path.dirname(parent);
    }
  }
  if(matched!==expected.size)return {ok:false,reason:'manifest_count'};
  if(group.some(t=>!P.hrMet(t,trackers[t.hash]) || (P.host(t)&&!trackers[t.hash].includes(P.host(t)))))return {ok:false,reason:'unknown_tracker'};
  return {ok:true,allocated,members:group.map(t=>t.hash),trackers};
}
async function run() {
  const now=Math.floor(Date.now()/1000),cfg=JSON.parse(fs.readFileSync(CLIENT));
  let old={};try{old=JSON.parse(fs.readFileSync(STATE));}catch(e){if(e.code!=='ENOENT')throw e;}
  const base=cfg.clientUrl.replace(/\/$/,'');
  if(!base.endsWith(':8089'))throw new Error('wrong_client');
  const login=await request(base+'/api/v2/auth/login','POST',new URLSearchParams({username:cfg.username,password:cfg.password}).toString());
  if(login.status!==200 || login.body.trim()!=='Ok.')throw new Error('qbit_auth');
  const cookie=(login.headers['set-cookie']||[]).map(x=>x.split(';')[0]).join(';');
  const rows=await json(base+'/api/v2/torrents/info',cookie);
  if(!Array.isArray(rows) || !rows.length)throw new Error('snapshot_shape');
  const sync=await json(base+'/api/v2/sync/maindata?rid=0',cookie);
  const prefs=await json(base+'/api/v2/app/preferences',cookie);
  if(!['/downloads','/downloads/'].includes(prefs.save_path))throw new Error('capacity_path');
  const free=Number(sync.server_state?.free_space_on_disk),physical=physicalDisk(),projected=free-P.remaining(rows);
  let mtFast=false;
  try{mtFast=JSON.parse(fs.readFileSync(DIR+'/mt-fast-upload-config.json')).enabled===true;}
  catch(e){if(e.code!=='ENOENT')throw e;}
  let allSite=false;
  try{allSite=JSON.parse(fs.readFileSync(DIR+'/all-site-upload-config.json')).enabled===true;}
  catch(e){if(e.code!=='ENOENT')throw e;}
  const state={version:1,ok:true,time:now,free,physicalFree:physical,projectedFree:projected,
    capacityRevision:1,capacityCounters:Object.fromEntries(rows.map(t=>[t.hash,Number(t.downloaded)])),
    pressure:P.pressure(old.pressure,free,projected,physical),history:{},audits:{},activeGroup:null,retirement:{},
    mtFastEnabled:mtFast,mtNearComplete:{},allSiteEnabled:allSite,nearComplete:{},trackerHosts:{},fenceReady:false,yieldPolicyRevision:P.YIELD_REVISION,
    summary:{tasks:rows.length,completeGroups:0,unknownHrGroups:0,hrNotMetGroups:0,auditedGroups:0,quietGroups:0,pauseCandidates:0,oldPartialCandidates:0,otherTasks:0,mtFastCandidates:0,mtFastAudited:0,allSiteCandidates:0,allSiteAudited:0,sharedExitGroups:0}};
  if(P.reclaimConfig()){
    if(!allSite)throw Error('exact_requires_all_site');
    const file=path.join(DIR,'../content-groups/3dfcd430-shadow.json'),st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.size>32*1024**2)throw Error('identity_state');
    state.groupingMode='exact-v1';
    state.exactGroups=P.exactEngine().prepare(JSON.parse(fs.readFileSync(file,'utf8')),rows,'3dfcd430',now);
    state.summary.identity=state.exactGroups.summary;
  }
  // cg1:<identity>:<membership revision> cannot inherit path-keyed history.
  state.history=P.observe(old.history||{},rows,now,state);
  const other=await json('http://127.0.0.1:8088/api/v2/torrents/info');
  if(!Array.isArray(other))throw new Error('other_snapshot');
  const mounts=JSON.parse(execFileSync('docker',['inspect','-f','{{json .Mounts}}','qbittorrent'],{timeout:10000,encoding:'utf8'}));
  state.summary.otherTasks=other.length;
  if(referencesOther(other,mounts))throw new Error('other_downloader_shared_root');
  state.otherRootProtected=true;
  // The primary field is frequently empty on paused IYUU tasks. Resolve from
  // real trackers, never guess from category/name or use missing as no H&R.
  for(const t of rows)if(allSite&&P.managed(t)&&!P.host(t)){
    const list=await json(base+'/api/v2/torrents/trackers?hash='+encodeURIComponent(t.hash),cookie);
    state.trackerHosts[t.hash]=[...new Set(list.filter(x=>/^https?:\/\/|^udp:\/\//.test(x.url)).map(x=>new URL(x.url).hostname.toLowerCase()))];
  }
  const candidates=[];
  for(const {key,group} of P.groupEntries(rows,state,now,true)) {
    if(group.some(t=>Number(t.progress)>=.9&&Number(t.progress)<1)){
      const continued=old.ok===true&&now>old.time&&now-old.time<=660&&group.every(t=>old.history?.[key]?.members.includes(t.hash));
      state.nearComplete[key]=continued&&old.nearComplete?.[key]||now;
    }
    if(group.every(t=>t.category==='MTEAM'&&Number(t.progress)<1)&&group.some(t=>Number(t.progress)>=.9)){
      const continued=old.ok===true&&now>old.time&&now-old.time<=660&&group.every(t=>old.history?.[key]?.members.includes(t.hash));
      state.mtNearComplete[key]=continued&&old.mtNearComplete?.[key]||now;
    }
    const retired=group.some(t=>String(t.tags||'').split(',').map(x=>x.trim()).includes(P.RETIRE_TAG)) &&
      group.every(t=>Number(t.progress)<1 && ['pausedDL','stoppedDL','error'].includes(t.state));
    if(retired)state.retirement[key]=old.retirement?.[key] && group.every(t=>old.history?.[key]?.members.includes(t.hash))?old.retirement[key]:now;
    if(group.every(t=>Number(t.progress)===1)) {
      state.summary.completeGroups++;
      if(group.some(t=>!P.known[P.host(t)]))state.summary.unknownHrGroups++;
      else if(group.some(t=>!P.hrMet(t)))state.summary.hrNotMetGroups++;
    }
    if(allSite&&P.groupLowYield(rows,group[0],state,now)){
      candidates.push({key,group,partial:group.some(t=>Number(t.progress)<1),all:true});state.summary.allSiteCandidates++;
      if(group.length>1)state.summary.sharedExitGroups++;
    }
    else if(!allSite&&mtFast&&P.mtLowYield(rows,group[0],state,now)){
      candidates.push({key,group,partial:group.some(t=>Number(t.progress)<1),fast:true});state.summary.mtFastCandidates++;
    }
    else if(!allSite&&!group.some(t=>t.category==='MTEAM')&&P.structural(rows,group[0],now,state).complete)candidates.push({key,group,partial:false});
    else if(!allSite&&!group.some(t=>t.category==='MTEAM')&&P.partialRetirable(rows,group[0],state,now))candidates.push({key,group,partial:true});
    if(group.every(t=>Number(t.progress)<1 && ['pausedDL','stoppedDL','error'].includes(t.state)) && group.some(t=>Number(t.completed)>0) &&
      group.every(t=>now-Number(t.last_activity||t.added_on)>7*86400))state.summary.oldPartialCandidates++;
  }
  // Bound expensive manifests/filesystem work. Keep a current active group first.
  // Keep the four currently audited drains fresh until their last member exits.
  // Productive/ineligible groups fall out; oldest pending audits rotate in.
  const pending={...(old.auditAttempt||{})};
  candidates.sort(auditOrder(old,pending,state));
  const peerBudget={requests:0,deadline:0};
  for(const {key,group,partial,fast,all} of candidates.slice(0,4)) {
    pending[key]=now;
    const manifests={},trackers={},exact=P.exactMode(state),E=exact?P.exactEngine():null;
    try {
      for(const t of group) {
        const files=await json(base+'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash),cookie);
        if(!Array.isArray(files))throw new Error('manifest_shape');
        if(exact&&!E.validateManifest(E.structure(rows,t,state,now),t,files,'3dfcd430'))throw Error('identity_manifest_changed');
        manifests[t.hash]=files.map(f=>({name:f.name,size:f.size})).sort((a,b)=>a.name.localeCompare(b.name));
        const list=await json(base+'/api/v2/torrents/trackers?hash='+encodeURIComponent(t.hash),cookie);
        trackers[t.hash]=[...new Set(list.filter(x=>/^https?:\/\/|^udp:\/\//.test(x.url)).map(x=>new URL(x.url).hostname.toLowerCase()))];
      }
      const audit=fileAudit(group,manifests,trackers,partial);audit.time=now;audit.partial=partial;state.audits[key]=audit;
      if(exact){const identity=E.structure(rows,group[0],state,now);audit.groupKey=key;audit.groupRevision=identity.revision;}
      if(audit.ok&&all&&!P.legacyLowYield(rows,group[0],state,now)){
        if(!P.noHrYieldCandidate(rows,group[0],state,now)){audit.ok=false;audit.reason='yield_protected';}
        else{
          try{
            audit.peerInterest=await collectPeerInterest(group,base,cookie,peerBudget);
            // A grace-blocked group must rotate out of the four priority audit
            // slots. It is reconsidered naturally, not starved or frozen ready.
            if(!P.noHrYieldPermit(rows,group[0],state,Math.floor(Date.now()/1000))){audit.ok=false;audit.reason='peer_warmup';}
          }catch(_){audit.ok=false;audit.reason='peer_unavailable';}
        }
      }
      if(audit.ok){state.summary.auditedGroups++;if(fast)state.summary.mtFastAudited++;if(all)state.summary.allSiteAudited++;if(P.quiet(state.history[key],audit.allocated,state.pressure,now))state.summary.quietGroups++;}
    }catch(_){state.audits[key]={ok:false,time:now,reason:'audit_failed'};}
  }
  state.summary.peerRequests=peerBudget.requests;
  state.auditAttempt=Object.fromEntries(candidates.map(x=>[x.key,pending[x.key]||0]));
  const ready=candidates.filter(x=>state.audits[x.key]?.ok && (x.all || x.fast || P.quiet(state.history[x.key],state.audits[x.key].allocated,state.pressure,now)));
  ready.sort((a,b)=>(b.key===old.activeGroup)-(a.key===old.activeGroup) ||
    Number(!!b.fast)-Number(!!a.fast) ||
    (P.delta(state.history[a.key],a.fast?1800:(state.pressure?6:12)*3600,now)/Math.max(1,state.audits[a.key].allocated))-(P.delta(state.history[b.key],b.fast?1800:(state.pressure?6:12)*3600,now)/Math.max(1,state.audits[b.key].allocated)) || state.audits[b.key].allocated-state.audits[a.key].allocated);
  state.activeGroup=ready[0]?.key || null;
  state.summary.pauseCandidates=rows.filter(t=>P.slowPause(rows,t,state,now)).length;
  writeFence(state,candidates.filter(x=>x.all),old,rows);
  writeState(state);
  console.log(JSON.stringify({ok:true,...state.summary,pressure:state.pressure,physicalFreeGiB:Math.round(physical/P.GiB),projectedFreeGiB:Math.round(projected/P.GiB),selectedGroups:state.activeGroup?1:0}));
  return state;
}
if(require.main===module)run().catch(e=>{
  // Retain observation history across a failed audit, not obsolete exemptions;
  // the false validity bit still blocks all physical deletion/admission.
  try{let old={};try{old=JSON.parse(fs.readFileSync(STATE));}catch(_){}delete old.protectedPaused;writeState({...old,version:1,ok:false,time:Math.floor(Date.now()/1000)});}catch(_){}
  const kinds=new Set(['destination','response_size','timeout','qbit_http','serial_mismatch','qbit_auth','wrong_client','snapshot_shape','capacity_path','other_snapshot','unmapped_other_path','other_path_missing','other_downloader_shared_root']);
  console.log(JSON.stringify({ok:false,error:kinds.has(e.message)?e.message:'audit_unavailable',deletionPerformed:false}));process.exitCode=1;
});
function auditOrder(old,pending,state){
  const paused=x=>x.group.every(t=>['pausedDL','stoppedDL','pausedUP','stoppedUP'].includes(t.state));
  return (a,b)=>Number(!!old.audits?.[b.key]?.ok)-Number(!!old.audits?.[a.key]?.ok)||
    Number(paused(b))-Number(paused(a))||(pending[a.key]||0)-(pending[b.key]||0)||Number(!!b.fast)-Number(!!a.fast)||
    (state.history[a.key]?.up||0)-(state.history[b.key]?.up||0)||Number(b.group[0].size)-Number(a.group[0].size);
}
module.exports={request,physicalDisk,hostPath,referencesOther,fileAudit,run,buildFence,buildHrAdmission,peerInterestProof,collectPeerInterest,auditOrder};
