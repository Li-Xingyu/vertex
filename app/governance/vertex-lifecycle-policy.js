'use strict';
// Pure, fail-closed policy shared by the read-only auditor and Vertex rules.
// No task deletion, network access, credentials, or download-file writes here.
const crypto = require('crypto');
const GiB = 1024 ** 3, TiB = 1024 * GiB;
const SPACE_FLOOR = 500 * GiB;
const MIN_SIZE = 2 * GiB, MAX_SIZE = 600 * GiB;
const categories = new Set(['CARPT','ZMPT','HDKYLIN','BTSCHOOL','HDFANS','NANYANG','HAIDAN','KUFEI','MTEAM','HHCLUB','AUDIENCES']);
const known = {
  'tracker.carpt.net':[86400,10], 'carpt.net':[86400,10],
  'tracker.hdkyl.in':[172800,2], 'www.hdkylin.top':[172800,2],
  'hdkyl.in':[172800,2], 'hdkylin.top':[172800,2],
  // Operator supplied BTSchool rules on 2026-10-03: 20h within 10 days after
  // completion OR upload above download. Reseed downloaded=0 is not exemption.
  'pt.btschool.club':[72000,1],
  // No H&R confirmed directly by the operator on 2026-10-02.
  // Nanyang confirmed by the operator on 2026-10-03; live audited tracker only.
  'tracker.nanyangpt.com':[0,0],
  'zmpt.cc':[0,0], 'tracker.zmpt.cc':[0,0],
  'announce.haidan.cc':[0,0], 'www.haidan.cc':[0,0], 'haidan.cc':[0,0],
  'hdfans.org':[0,0], 'tracker.hdfans.org':[0,0],
  'kufei.org':[0,0], 'tracker.kufei.org':[0,0],
  // Operator explicitly confirmed no MT H&R; this is the live verified host.
  'tracker.m-team.cc':[0,0],
  // HH marked torrents: 72h in 20 days; ratio cannot substitute seeding time.
  'tracker.hhanclub.net':[259200,Infinity],
  // Audiences user-supplied marked HR: 48h OR ratio1 within14d. Both hosts
  // verified in an authenticated site .torrent on 2026-10-07. Unknown/tagged
  // reseeds retain this conservative floor; source proof never transfers.
  't.audiences.me':[172800,1], 'tracker.cinefiles.info':[172800,1]
};
const raw = t => t.originProp || t;
const cp = t => String(raw(t).content_path || '');
const digest = p => crypto.createHash('sha256').update(p).digest('hex');
const number = (t, key, original) => Number(t[key] ?? raw(t)[original || key] ?? NaN);
const host = t => {
  const value=String(t.tracker || raw(t).tracker || '').toLowerCase();
  try{return value.includes('://')?new URL(value).hostname:/^[a-z0-9.-]+$/.test(value)?value:'';}
  catch(_){return '';}
};
const managed = t => categories.has(t.category) || (!t.category && String(t.tags || raw(t).tags || '').split(',').map(x=>x.trim()).includes('IYUU自动辅种'));
const safePath = p => p.startsWith('/downloads/') && p !== '/downloads/' && !p.includes('\\') && !p.includes('\0') && !p.slice(1).split('/').some(x=>x==='.' || x==='..' || x==='');
function hrMet(t, hosts) {
  const hs = hosts || [host(t)];
  const size = Number(t.totalSize || raw(t).total_size || t.size || 0);
  const seed = number(t,'seeding_time'), uploaded = number(t,'uploaded');
  return hs.length > 0 && hs.every(h => {
    if(!known[h])return false;
    const timeMet=Number.isFinite(seed) && seed >= known[h][0] + 600;
    // A seed-only qB task often reports zero local download, unlike the site's
    // H&R/accounting record. For BTSchool use the full content size AND any
    // larger actual local download; equality is deliberately not sufficient.
    const downloaded=number(t,'downloaded');
    const ratioMet=h==='pt.btschool.club'
      ? Number.isFinite(size) && size>0 && Number.isFinite(downloaded) && downloaded>=0 &&
        Number.isFinite(uploaded) && uploaded>Math.max(size,downloaded)
      : size>0 && Number.isFinite(uploaded) && uploaded/size>known[h][1];
    return hostNoHr(t,h) || timeMet || ratioMet;
  });
}
let hhCache=null,hhAt=0;
function hhProof(t){
  try{if(require('./hhan-provider-lifecycle').revoked(t))return null;}catch(_){return null;}
  if(Date.now()-hhAt>=5000){hhAt=Date.now();try{const fs=require('fs'),f=require('path').join(__dirname,'hhan-proof.json');
    if(fs.statSync(f).size>4*1024**2)throw Error('proof_size');const v=JSON.parse(fs.readFileSync(f));hhCache=v.version===1?v.entries:null;
  }catch(_){hhCache=null;}}
  const p=hhCache?.[t.hash];return p&&p.hr===false&&p.rssId==='57d6ce6e'&&
    p.size===Number(t.size)&&p.addedOn===number(t,'addedTime','added_on')&&p.time>0&&p.time<=Date.now()/1000?p:null;
}
function hostNoHr(t,h){if(['t.audiences.me','tracker.cinefiles.info'].includes(h)){try{return require('./audiences-provider-lifecycle').noHr(t);}catch(_){return false;}}return known[h]?.[0]===0&&known[h]?.[1]===0||h==='tracker.hhanclub.net'&&!!hhProof(t);}
const noHr = t => hostNoHr(t,host(t));
const RETIRE_TAG='Vertex低收益退出';
// Same pure module ships in the Vertex image and beside the existing host
// auditor. A missing module/evidence in exact mode NEVER falls back to paths.
const exactMode = state => state?.groupingMode==='exact-v1';
const exactEngine = () => require('./content-groups/reclaim');
const removedRows = state => exactMode(state)?exactEngine().removedRows(state):[];
const hadComplete = (group,state) => group.some(x=>Number(x.progress)===1)||removedRows(state).some(x=>Number(x.progress)===1);
function groupKey(rows,t,state,now=Date.now()/1000){return structural(rows,t,now,state).key;}
function sameContent(a,b,state){return exactMode(state)||a.name===b.name&&Number(a.size)===Number(b.size)&&
  (a.savePath||raw(a).save_path)===(b.savePath||raw(b).save_path);}
function groupEntries(rows,state,now=Date.now()/1000,observation=false){
  if(exactMode(state))return exactEngine().context(rows,state,now).groups.filter(g=>observation?g.bound:g.valid).map(g=>({key:g.key,group:g.group,revision:g.revision}));
  return [...contentIndex(rows).groups].map(([p,group])=>({key:digest(p),group}));
}
// Each native fit-time/reject sweep evaluates thousands of rules over the SAME
// immutable qB snapshot. Repeated full filters caused >2s event-loop stalls,
// enough to miss node-cron2's exact second-0 execution. Index by snapshot, not
// by a global path cache; live delete guard GETs always produce a new array.
const indexes=new WeakMap();
function contentIndex(rows) {
  const tick=Math.floor(Date.now()/1000),old=indexes.get(rows);
  if(old&&old.length===rows.length&&old.tick===tick)return old;
  const groups=new Map(),overlaps=new Set();
  for(const t of rows){const p=cp(t);if(!groups.has(p))groups.set(p,[]);groups.get(p).push(t);}
  for(const p of groups.keys()){
    if(!p)continue;
    for(let i=p.lastIndexOf('/');i>0;i=p.lastIndexOf('/',i-1)){
      const parent=p.slice(0,i);if(groups.has(parent)){overlaps.add(p);overlaps.add(parent);}
    }
    if(groups.has('')){overlaps.add('');overlaps.add(p);}
  }
  const out={groups,overlaps,length:rows.length,tick};indexes.set(rows,out);return out;
}
function partialRetirable(rows,t,state,now=Date.now()/1000) {
  const start=state?.retirement?.[groupKey(rows,t,state,now)];
  if(!fresh(state,now) || !(start>0 && now-start>=7*86400))return false;
  const p=structural(rows,t,now,state);
  return safePath(p.path) && !p.overlap &&
    p.group.length>0 && p.group.some(x=>String(x.tags || raw(x).tags || '').split(',').map(y=>y.trim()).includes(RETIRE_TAG)) &&
    p.group.every(x=>managed(x) && noHr(x) && Number(x.progress)<1 && ['pausedDL','stoppedDL','error'].includes(x.state) &&
      number(x,'uploadSpeed','upspeed')===0 && number(x,'downloadSpeed','dlspeed')===0 &&
      number(x,'leecher','num_leechs')===0 && number(x,'addedTime','added_on')>0 && now-number(x,'addedTime','added_on')>=7*86400);
}
function structural(rows, t, now = Date.now()/1000,state,refreshOnly=false) {
  const path=cp(t),entry=exactMode(state)?exactEngine().structure(rows,t,state,now):null;
  const index=entry?null:contentIndex(rows),group=entry?entry.group:index.groups.get(path)||[];
  const overlap=entry?!(refreshOnly?entry.refreshable:entry.valid):index.overlaps.has(path);
  const complete = safePath(path) && !overlap && group.length > 0 && group.every(x => {
    const completion = number(x,'completedTime','completion_on');
    return managed(x) && Number(x.progress)===1 && hrMet(x) &&
      x.state==='stalledUP' && number(x,'leecher','num_leechs')===0 &&
      number(x,'uploadSpeed','upspeed')>=0 && completion>0 && now-completion>=10*3600 &&
      sameContent(x,t,state);
  }) && group.reduce((n,x)=>n+number(x,'uploadSpeed','upspeed'),0)<64*1024;
  return {path,group,overlap,complete,key:entry?entry.key:digest(path),revision:entry?.revision,identity:entry?.identity};
}
function zeroStale(rows,t,now=Date.now()/1000,state) {
  if(!['pausedDL','stoppedDL','error'].includes(t.state) || Number(t.progress)!==0)return false;
  const p=structural(rows,t,now,state);
  return safePath(p.path) && !p.overlap && p.group.length>0 && p.group.every(x=>
    managed(x) && ['pausedDL','stoppedDL','error'].includes(x.state) &&
    Number(x.progress)===0 && number(x,'completed')===0 && number(x,'downloaded')===0 &&
    number(x,'addedTime','added_on')>0 && now-number(x,'addedTime','added_on')>=7*86400);
}
function observe(previous,rows,now,state) {
  const output={};
  for(const {key,group} of groupEntries(rows,state,now,true)) {
    const old=previous[key];
    const counters=Object.fromEntries(group.map(t=>[t.hash,{up:number(t,'uploaded'),down:number(t,'downloaded')}]));
    const invalid=Object.values(counters).some(x=>!Number.isFinite(x.up)||!Number.isFinite(x.down));
    const added=old && (Object.keys(counters).some(h=>!Object.hasOwnProperty.call(old.counters,h)) ||
      exactMode(state)&&Object.keys(old.counters).length!==Object.keys(counters).length);
    const reset=old && Object.entries(counters).some(([h,v])=>old.counters[h] && (v.up<old.counters[h].up || v.down<old.counters[h].down));
    const restart=!old || invalid || added || reset || now<=old.last || now-old.last>660;
    let up=restart?0:old.up, down=restart?0:old.down;
    if(!restart)for(const [h,v] of Object.entries(counters)){up+=Math.max(0,v.up-(old.counters[h]?.up??v.up));down+=Math.max(0,v.down-(old.counters[h]?.down??v.down));}
    const samples=restart?[]:old.samples.filter(x=>x.time>=now-13*3600);
    const peers=group.map(t=>number(t,'leecher','num_leechs'));
    samples.push({time:now,up,down,leechers:peers.every(x=>Number.isFinite(x)&&x>=0)?peers.reduce((a,b)=>a+b,0):null});
    output[key]={members:restart?Object.keys(counters):[...new Set([...old.members,...Object.keys(counters)])],counters,last:now,up,down,samples,valid:!invalid};
  }
  return output;
}
function delta(history,seconds,now,field='up') {
  if(!history?.valid || now-history.last>660)return null;
  const sample=[...history.samples].reverse().find(x=>x.time<=now-seconds);
  if(!sample || now-seconds-sample.time>660)return null;
  return Math.max(0,history[field]-sample[field]);
}
function quiet(history,allocated,pressure,now) {
  const seconds=(pressure?6:12)*3600, uploaded=delta(history,seconds,now);
  const budget=Math.min((pressure?128:256)*1024**2,allocated*.001);
  return allocated>0 && uploaded!==null && uploaded<=budget;
}
function remaining(rows) {
  const groups=new Map();
  for(const t of rows) {
    if(Number(t.progress)>=1 || (!['MTEAM','HHCLUB'].includes(t.category) && ['pausedDL','stoppedDL','error','missingFiles'].includes(t.state)))continue;
    const left=Number(raw(t).amount_left);
    if(!Number.isFinite(left) || left<0)return Infinity;
    const key=cp(t)||t.hash;groups.set(key,Math.max(groups.get(key)||0,left));
  }
  return [...groups.values()].reduce((a,b)=>a+b,0);
}
function pressure(previous,free,projected,physical) {
  if(![free,projected,physical].every(Number.isFinite))return true;
  return projected<SPACE_FLOOR || physical<SPACE_FLOOR;
}
function fresh(state,now) {return state?.version===1 && state.ok===true && now>=state.time && now-state.time<=660;}
function noDemand(history,seconds,now) {
  if(!history?.valid || now-history.last>660)return false;
  const anchor=[...history.samples].reverse().find(x=>x.time<=now-seconds);
  if(!anchor || now-seconds-anchor.time>660)return false;
  return history.samples.filter(x=>x.time>=anchor.time).every(x=>x.leechers===0);
}
// Category is not a tracker identity: IYUU deliberately leaves it empty, and
// paused qB rows often omit the primary tracker. Only audited hosts fill gaps.
function hostsFor(t,state) {
  const h=host(t);
  return h?[h]:(state?.trackerHosts?.[t.hash]||[]);
}
// Connected peers can hold identical pieces and request nothing. Relax ONLY
// pure HH groups with exact no-HR proofs; every real audited host must still be
// HH. Mixed-site groups retain the original zero-peer requirement.
function hhIdlePeers(group,state,history,now) {
  if(!group.length||!group.every(x=>{
    const audited=state.audits?.[groupKey(group,x,state,now)]?.trackers?.[x.hash],hs=audited||hostsFor(x,state);
    return hs.length>0&&hs.every(h=>h==='tracker.hhanclub.net'&&hostNoHr(x,h))&&
      Number.isFinite(number(x,'leecher','num_leechs'))&&number(x,'leecher','num_leechs')>=0;
  }))return false;
  const partial=group.filter(x=>Number(x.progress)<1);
  if(!partial.length)return true;
  const down=delta(history,1800,now,'down');
  return down!==null&&down<=1024**2&&partial.every(x=>
    number(x,'downloadSpeed','dlspeed')===0&&number(x,'seeder','num_seeds')===0);
}
function legacyLowYield(rows,t,state,now=Date.now()/1000,refreshOnly=false) {
  if(!fresh(state,now))return false;
  const p=structural(rows,t,now,state,refreshOnly),key=p.key,h=state.history?.[key];
  const hhIdle=hhIdlePeers(p.group,state,h,now);
  if(!safePath(p.path)||p.overlap||!p.group.length||!p.group.every(x=>
    managed(x)&&hrMet(x,hostsFor(x,state))&&sameContent(x,t,state)&&
    (number(x,'leecher','num_leechs')===0||hhIdle)&&number(x,'uploadSpeed','upspeed')>=0&&
    number(x,'uploadSpeed','upspeed')<32*1024**2/1800))return false;
  const partial=p.group.filter(x=>Number(x.progress)<1),complete=p.group.filter(x=>Number(x.progress)===1);
  // An unfinished reference is not automatically H&R debt. Keep every actual
  // host's existing time/ratio proof; never exempt it merely by category.
  if(partial.some(x=>!hrMet(x,hostsFor(x,state))||
    !['downloading','stalledDL','pausedDL','stoppedDL'].includes(x.state)||
    !(Number(x.progress)>=0)||!(number(x,'addedTime','added_on')>0)||now-number(x,'addedTime','added_on')<3600))return false;
  if(complete.some(x=>!['stalledUP','uploading','pausedUP','stoppedUP'].includes(x.state)||
    !(number(x,'completedTime','completion_on')>0)||now-number(x,'completedTime','completion_on')<7200))return false;
  if(p.group.length!==partial.length+complete.length)return false;
  if(partial.some(x=>Number(x.progress)>=.9)){
    const since=state.nearComplete?.[key];if(!(since>0&&now-since>=7200))return false;
  }
  const seconds=hadComplete(p.group,state)?7200:1800,limit=hadComplete(p.group,state)?128*1024**2:32*1024**2;
  const up=delta(h,seconds,now);
  return up!==null&&up<limit&&(noDemand(h,seconds,now)||hhIdle);
}
const YIELD_REVISION=1,LOW_UPLOAD=32*1024**2/1800;
function liveUploaded(group,history,seconds,now,state){
  const observed=delta(history,seconds,now);if(!Number.isFinite(observed))return null;
  let extra=0;
  for(const t of [...group,...removedRows(state)]){
    const previous=history.counters?.[t.hash]?.up,current=number(t,'uploaded');
    if(!Number.isFinite(previous)||!Number.isFinite(current)||previous<0||current<previous)return null;
    extra+=current-previous;
  }
  // Include delivered bytes after the last five-minute audit, even if the
  // uploader has already become idle again. Counter rollback/new refs protect.
  return observed+extra;
}
function liveWindowLow(group,state,now,key){
  const complete=hadComplete(group,state),up=liveUploaded(group,state.history?.[key],complete?7200:1800,now,state);
  return up!==null&&up<(complete?128:32)*1024**2;
}
function liveGroupLow(group){
  const rates=group.map(x=>number(x,'uploadSpeed','upspeed'));
  return group.length>0&&rates.every(v=>Number.isFinite(v)&&v>=0)&&rates.reduce((a,b)=>a+b,0)<LOW_UPLOAD;
}
// Screening is inexpensive. A primary tracker may nominate a group for audit,
// but only ALL real audited trackers can permit the connected-peer exit path.
function noHrYieldCandidate(rows,t,state,now=Date.now()/1000,refreshOnly=false) {
  if(!fresh(state,now))return false;
  const p=structural(rows,t,now,state,refreshOnly),key=p.key,h=state.history?.[key];
  if(!safePath(p.path)||p.overlap||!liveGroupLow(p.group)||!p.group.every(x=>{
    const hs=state.audits?.[key]?.trackers?.[x.hash]||hostsFor(x,state);
    return managed(x)&&hs.length>0&&hs.every(v=>hostNoHr(x,v))&&
      sameContent(x,t,state)&&
      Number.isFinite(number(x,'leecher','num_leechs'))&&number(x,'leecher','num_leechs')>=0;
  }))return false;
  const partial=p.group.filter(x=>Number(x.progress)<1),complete=p.group.filter(x=>Number(x.progress)===1);
  if(partial.some(x=>!['downloading','stalledDL','pausedDL','stoppedDL'].includes(x.state)||
    !(Number(x.progress)>=0)||!(number(x,'addedTime','added_on')>0)||now-number(x,'addedTime','added_on')<3600))return false;
  if(complete.some(x=>!['stalledUP','uploading','pausedUP','stoppedUP'].includes(x.state)||
    !(number(x,'completedTime','completion_on')>0)||now-number(x,'completedTime','completion_on')<7200))return false;
  if(p.group.length!==partial.length+complete.length)return false;
  if(partial.some(x=>Number(x.progress)>=.9)){
    const since=state.nearComplete?.[key];if(!(since>0&&now-since>=7200))return false;
  }
  const up=liveUploaded(p.group,h,hadComplete(p.group,state)?7200:1800,now,state),limit=(hadComplete(p.group,state)?128:32)*1024**2;
  return Number.isFinite(up)&&up!==null&&up<limit;
}
function noHrYieldPermit(rows,t,state,now=Date.now()/1000) {
  if(state?.yieldPolicyRevision!==YIELD_REVISION||!noHrYieldCandidate(rows,t,state,now))return false;
  const p=structural(rows,t,now,state),group=p.group,key=p.key,audit=state.audits?.[key],proof=audit?.peerInterest;
  if(!auditPermit(group,audit,now)||proof?.version!==1||!Number.isFinite(proof.time)||
    now<proof.time||now-proof.time>660||!group.every(x=>{
      const hs=audit.trackers[x.hash],v=proof.members?.[x.hash];
      return hs.length>0&&hs.every(h=>hostNoHr(x,h))&&v&&
        Number.isInteger(v.seen)&&v.seen>=0&&Number.isInteger(v.interested)&&v.interested>=0&&v.interested<=v.seen&&
        Number.isInteger(v.leechers)&&v.leechers>=0&&
        // A newly connected downloader requires a fresh observation, not an
        // assumption that it has the same interests as the old peer snapshot.
        number(x,'leecher','num_leechs')<=v.leechers;
    }))return false;
  const interested=group.some(x=>proof.members[x.hash].interested>0);
  if(!interested)return true;
  // Interest is an opportunity, not delivered bytes. Grant finite extra warmup
  // and a longer actual-upload window, never indefinite peer-based protection.
  const complete=hadComplete(group,state);
  if(group.some(x=>Number(x.progress)<1?now-number(x,'addedTime','added_on')<7200:
    now-number(x,'completedTime','completion_on')<10800))return false;
  const up=liveUploaded(group,state.history[key],complete?10800:3600,now,state);
  return Number.isFinite(up)&&up!==null&&up<(complete?192:64)*1024**2;
}
function groupLowYield(rows,t,state,now=Date.now()/1000) {
  const structure=structural(rows,t,now,state),group=structure.group;
  return liveGroupLow(group)&&(legacyLowYield(rows,t,state,now)||
    state?.yieldPolicyRevision===YIELD_REVISION&&noHrYieldCandidate(rows,t,state,now))&&
    (state?.yieldPolicyRevision!==YIELD_REVISION||liveWindowLow(group,state,now,structure.key));
}
// Only nominates work to the read-only metadata observer. Never called by
// decision()/auditPermit()/the delete guard; no timestamp or permit is forged.
function refreshCandidate(rows,t,state,now=Date.now()/1000){
  if(!exactMode(state)||!fresh(state,now)||!state.allSiteEnabled||!state.otherRootProtected)return false;
  const p=structural(rows,t,now,state,true);
  return !p.overlap&&liveGroupLow(p.group)&&
    (legacyLowYield(rows,t,state,now,true)||state.yieldPolicyRevision===YIELD_REVISION&&noHrYieldCandidate(rows,t,state,now,true))&&
    (state.yieldPolicyRevision!==YIELD_REVISION||liveWindowLow(p.group,state,now,p.key));
}
function auditPermit(group,audit,now) {
  return group.length>0&&audit?.ok===true&&Array.isArray(audit.members)&&now>=audit.time&&now-audit.time<=660&&group.every(x=>
    audit.members.includes(x.hash)&&Array.isArray(audit.trackers?.[x.hash])&&hrMet(x,audit.trackers[x.hash])&&
    (!host(x)||audit.trackers[x.hash].includes(host(x))));
}
function mtLowYield(rows,t,state,now=Date.now()/1000) {
  if(!fresh(state,now) || t.category!=='MTEAM')return false;
  const p=structural(rows,t,now,state),h=state.history?.[p.key];
  if(!safePath(p.path)||p.overlap||!p.group.length||!p.group.every(x=>x.category==='MTEAM'&&noHr(x)&&
    sameContent(x,t,state)&&
    number(x,'leecher','num_leechs')===0&&number(x,'uploadSpeed','upspeed')>=0&&number(x,'uploadSpeed','upspeed')<32*1024**2/1800))return false;
  const partial=p.group.every(x=>Number(x.progress)>=0&&Number(x.progress)<1&&
    ['downloading','stalledDL','pausedDL','stoppedDL'].includes(x.state)&&number(x,'addedTime','added_on')>0&&now-number(x,'addedTime','added_on')>=3600);
  if(partial){
    // >=90% gets an additional, finite completion opportunity, not a permanent
    // exemption. The timestamp resets after a monitoring outage/new member.
    if(p.group.some(x=>Number(x.progress)>=.9)){
      const since=state.mtNearComplete?.[p.key];
      if(!(since>0&&now-since>=7200))return false;
    }
    const up=delta(h,1800,now);
    return up!==null&&up<32*1024**2;
  }
  const complete=p.group.every(x=>Number(x.progress)===1&&['stalledUP','uploading','pausedUP','stoppedUP'].includes(x.state)&&
    number(x,'completedTime','completion_on')>0&&now-number(x,'completedTime','completion_on')>=3600);
  const up=delta(h,3600,now);
  return complete&&up!==null&&up<64*1024**2&&noDemand(h,3600,now);
}
const EXIT_ONLY_REVISION=1;
function promotionSafetyPause(rows,t,state,now=Date.now()/1000,proof) {
  if(!['HHCLUB','AUDIENCES'].includes(t.category))return false;
  // The optional proof is for isolated fixtures. Native rules use hhProof's
  // exact hash/size/added-on/no-HR witness, not a category-based exemption.
  let hh=proof===undefined?(t.category==='HHCLUB'?hhProof(t):null):proof;
  // A prepared native HH submission has a durable expiry witness even while
  // successful-history reconciliation is pending. It never grants HR exemption.
  if(proof===undefined){try{const e=require(t.category==='AUDIENCES'?'./audiences-provider-lifecycle':'./hhan-provider-lifecycle').expiry(t);if(e&&(!hh||e.until<hh.until))hh=e;}catch(_){}}
  if(fresh(state,now)&&Number(t.progress)<1&&['downloading','stalledDL'].includes(t.state)&&
    // Native pause rule has a 1800s continuous fit gate: begin an hour early
    // so the intended actual stop remains about 30 minutes before promotion.
    // Promotion expiry is NOT reclamation. Preserve its existing physical-scope
    // stop-loss even if the read-only identity observer is incomplete/stale.
    hh&&Number.isFinite(hh.until)&&now+3600>=hh.until){const p=structural(rows,t,now);if(safePath(p.path)&&!p.overlap&&!p.group.some(x=>Number(x.progress)===1))return true;}
  return false;
}
function slowPause(rows,t,state,now=Date.now()/1000) {
  // Low yield is handled by the audited group exit, never an indefinite pause.
  // Freeleech-expiry loss prevention remains a separate safety exception.
  return promotionSafetyPause(rows,t,state,now);
}
function deadZero(rows,t,state) {
  if(t.state!=='stalledDL' || Number(t.progress)!==0)return false;
  const p=structural(rows,t,Date.now()/1000,state);
  return safePath(p.path) && !p.overlap && p.group.length>0 && p.group.every(x=>managed(x)&&Number(x.progress)===0&&number(x,'completed')===0&&number(x,'downloaded')===0) &&
    t.state==='stalledDL' && number(t,'downloadSpeed','dlspeed')===0 && number(t,'seeder','num_seeds')===0 && number(t,'availability')===0 && Date.now()/1000-number(t,'addedTime','added_on')>7200;
}
function decision(rows,t,state,now=Date.now()/1000) {
  const p=structural(rows,t,now,state), key=p.key, audit=state?.audits?.[key];
  const terminal=partialRetirable(rows,t,state,now);
  // MT uses its dedicated short-window rule, never the legacy 6/12h path.
  // Mixed MT/other-site content is protected rather than widening deletion.
  const cleanup=state?.allSiteEnabled!==true && !p.group.some(x=>x.category==='MTEAM') && fresh(state,now) && state.activeGroup===key && (p.complete || terminal) && audit?.ok===true &&
    now-audit.time<=660 && p.group.every(x=>audit.members.includes(x.hash) && hrMet(x,audit.trackers[x.hash]) && audit.trackers[x.hash].includes(host(x))) &&
    quiet(state.history[key],audit.allocated,state.pressure,now);
  // Exact grouping is supported ONLY by the audited all-site group executor.
  // Legacy zero/dead/fast rules cannot become an unaudited alternate exit.
  const zero=!exactMode(state)&&zeroStale(rows,t,now,state), pause=slowPause(rows,t,state,now), dead=!exactMode(state)&&deadZero(rows,t,state);
  // Audited MT groups qualify independently, so the 10-minute timers need not
  // run serially. Native deleteNum=1 still bounds actual exits to one/minute.
  const fastCleanup=state?.allSiteEnabled!==true&&state?.mtFastEnabled===true&&mtLowYield(rows,t,state,now)&&
    audit?.ok===true&&now-audit.time<=660&&p.group.every(x=>audit.members.includes(x.hash)&&hrMet(x,audit.trackers[x.hash])&&audit.trackers[x.hash].includes(host(x)));
  const identityPermit=!exactMode(state)||exactEngine().permit(exactEngine().structure(rows,t,state,now),audit);
  const allCleanup=identityPermit&&state?.allSiteEnabled===true&&state.fenceReady===true&&
    groupLowYield(rows,t,state,now)&&auditPermit(p.group,audit,now)&&
    (legacyLowYield(rows,t,state,now)||noHrYieldPermit(rows,t,state,now));
  const reject=!safePath(p.path) || !managed(t) || p.overlap ||
    (Number(t.progress)===1 || p.group.some(x=>Number(x.progress)===1) ? !(cleanup||fastCleanup||allCleanup) : !(cleanup || fastCleanup || allCleanup || zero || pause || dead));
  if(exactMode(state))return {cleanup:false,fastCleanup:false,allCleanup:!!allCleanup,pause,zero:false,dead:false,reject:!(allCleanup||pause)};
  return {cleanup:!!cleanup,fastCleanup:!!fastCleanup,allCleanup:!!allCleanup,pause,zero,dead,reject};
}
function admission(state,size,now=Date.now()/1000,bounds={min:MIN_SIZE,max:MAX_SIZE}) {
  return fresh(state,now) && !state.pressure && state.physicalFree-size>=SPACE_FLOOR &&
    Number.isFinite(state.projectedFree) && state.projectedFree-size>=SPACE_FLOOR && size>bounds.min && size<bounds.max;
}
let cachedState=null,cachedAt=0;
function reclaimConfig(){
  try{const v=JSON.parse(require('fs').readFileSync(require('path').join(__dirname,'content-group-reclaim-config.json'),'utf8'));
    if(v.mode!=='exact-v1'||v.clientId!=='3dfcd430')throw Error('reclaim_config');return v;
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
function loadState(file='/vertex/data/governance/state.json') {
  if(Date.now()-cachedAt<5000)return cachedState;
  cachedAt=Date.now();
  try {const fs=require('fs');if(fs.statSync(file).size>32*1024**2)throw new Error('state_size');cachedState=JSON.parse(fs.readFileSync(file,'utf8'));
    if(reclaimConfig()&&cachedState.groupingMode!=='exact-v1')cachedState={...cachedState,groupingMode:'exact-v1',exactGroups:null};}
  catch(_){cachedState=null;}
  return cachedState;
}
module.exports={GiB,TiB,SPACE_FLOOR,MIN_SIZE,MAX_SIZE,known,noHr,RETIRE_TAG,partialRetirable,raw,cp,digest,host,managed,safePath,hrMet,structural,zeroStale,observe,delta,quiet,remaining,pressure,fresh,slowPause,decision,admission,loadState,noDemand,mtLowYield,groupLowYield,hostsFor,auditPermit,hhIdlePeers,YIELD_REVISION,legacyLowYield,liveGroupLow,noHrYieldCandidate,noHrYieldPermit,liveUploaded,EXIT_ONLY_REVISION,promotionSafetyPause};
Object.assign(module.exports,{exactMode,exactEngine,groupKey,groupEntries,reclaimConfig,refreshCandidate});
