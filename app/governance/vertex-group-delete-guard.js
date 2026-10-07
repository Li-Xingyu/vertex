'use strict';
// Runtime-only, idempotent wrapper for ONE explicit rule/client. Other native
// methods, RSS counters, timers, queue settings and notifications are retained.
const P=require('./vertex-lifecycle-policy'),http=require('http');
const RID='f963cc6e',VERSION=4;
const BLOCK_REASONS=new Set(['batch_busy','batch_timeout','permit_changed','other_reference','tracker_changed','members_changed','delete_not_confirmed','manifest_changed','fence_changed']);
function sameMembers(group,hashes){return JSON.stringify(group.map(x=>x.hash).sort())===JSON.stringify([...hashes].sort());}
function normalized(t){return {...t,originProp:t,tracker:P.host(t),uploadSpeed:t.upspeed,downloadSpeed:t.dlspeed,addedTime:t.added_on,completedTime:t.completion_on,savePath:t.save_path,leecher:t.num_leechs};}
function batchState(state,key,removed,exact){
  if(P.exactMode(state)!==exact)throw Error('permit_changed');
  if(!exact)return state;
  const g=state?.exactGroups?.groups.find(g=>g.key===key),f=state?.exitFence?.[key],now=Date.now()/1000;
  if(!g||!f||f.status!=='pending'||!Number.isFinite(f.last)||now<f.last||now-f.last>660||
    f.path!==g.paths[0]||JSON.stringify([...f.members].sort())!==JSON.stringify([...g.members].sort()))throw Error('fence_changed');
  return P.exactEngine().draining(state,key,removed);
}
function get(base,route,cookie=''){
  return new Promise((resolve,reject)=>{
    const u=new URL(base+route);
    if(u.protocol!=='http:'||!['192.168.1.188','127.0.0.1'].includes(u.hostname)||!['8088','8089'].includes(u.port))return reject(new Error('destination'));
    const req=http.get(u,{headers:{Cookie:cookie}},res=>{
      let text='';res.on('data',b=>{text+=b;if(text.length>32*1024**2)req.destroy(new Error('size'));});
      res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('http');resolve(JSON.parse(text));}catch(e){reject(e);}});
    });req.setTimeout(12000,()=>req.destroy(new Error('timeout')));req.on('error',reject);
  });
}
function install(c,refresh=false){
  if(!c||c.id!=='3dfcd430'&&c._client?.id!=='3dfcd430')throw new Error('wrong_client');
  if(c.codexGroupGuardVersion===VERSION&&!refresh)return false;
  const original=c.codexGroupGuardOriginal||c.deleteTorrent;
  c.orderGroupDeleteCandidates=function(rows,rule){
    if(rule.id!==RID)return rows;
    return orderCandidates(rows,P.loadState(),Date.now()/1000,Number(this.codexGroupGuardStats?.groupsDeleted||0));
  };
  c.codexGroupGuardOriginal=original;
  c.deleteTorrent=async function(torrent,rule){
    if(rule.id!==RID)return original.call(this,torrent,rule);
    this.codexGroupGuardStats=this.codexGroupGuardStats||{removed:0,filesDeleted:0,blocked:0};
    const stats=this.codexGroupGuardStats;
    stats.groupsDeleted=stats.groupsDeleted||0;stats.partialBatches=stats.partialBatches||0;
    stats.recordErrors=stats.recordErrors||0;stats.blockReasons=stats.blockReasons||{};
    let removed=0,locked=false,expected;
    const confirmed=[];
    try{
      if(this.codexGroupGuardBatchLock)throw new Error('batch_busy');
      this.codexGroupGuardBatchLock=true;locked=true;
      const deadline=Date.now()+45000;
      const rows=await get(this.clientUrl,'/api/v2/torrents/info',this.cookie);
      const t=rows.find(x=>x.hash===torrent.hash),state=P.loadState(),exact=P.exactMode(state);
      if(exact&&this.supportsConfirmedGroupHistory!==true)throw new Error('permit_changed');
      if(!t||!P.decision(rows,t,state).allCleanup)throw new Error('permit_changed');
      const structure=P.structural(rows,t,Date.now()/1000,state),group=structure.group,key=structure.key;
      expected=new Set(group.map(x=>x.hash));
      // One native deletion slot drains ONE qualifying content group, not
      // arbitrary groups. The trigger retains the native 600-second fit gate.
      const order=[t.hash,...group.map(x=>x.hash).filter(h=>h!==t.hash)];
      // Vertex is bridge-networked, not the NAS host: container localhost:8088
      // is NOT the main downloader. The host auditor maps its bind mounts and
      // references; missing/stale evidence is already blocked by fresh(state).
      if(state.otherRootProtected!==true)throw new Error('other_reference');
      for(const hash of order){
        if(Date.now()>deadline)throw new Error('batch_timeout');
        const current=await get(this.clientUrl,'/api/v2/torrents/info',this.cookie),member=current.find(x=>x.hash===hash),s=batchState(P.loadState(),key,confirmed,exact);
        if(!member||!sameMembers(P.structural(current,member,Date.now()/1000,s).group,expected))throw new Error('members_changed');
        if(!P.decision(current,member,s).allCleanup)throw new Error('permit_changed');
        if(s.otherRootProtected!==true)throw new Error('other_reference');
        const audit=s.audits[key];
        // Revalidate every remaining real tracker before each operation;
        // a newly protected sibling stops the entire batch before file delete.
        for(const sibling of P.structural(current,member,Date.now()/1000,s).group){
          if(exact){
            const E=P.exactEngine(),files=await get(this.clientUrl,'/api/v2/torrents/files?hash='+encodeURIComponent(sibling.hash),this.cookie);
            if(!E.validateManifest(E.structure(current,sibling,s,Date.now()/1000),sibling,files,'3dfcd430'))throw Error('manifest_changed');
          }
          const trackers=await get(this.clientUrl,'/api/v2/torrents/trackers?hash='+encodeURIComponent(sibling.hash),this.cookie);
          const hosts=[...new Set(trackers.filter(x=>/^https?:\/\/|^udp:\/\//.test(x.url)).map(x=>new URL(x.url).hostname.toLowerCase()))].sort();
          if(JSON.stringify(hosts)!==JSON.stringify([...audit.trackers[sibling.hash]].sort())||!P.hrMet(sibling,hosts))throw new Error('tracker_changed');
        }
        // qB has no atomic delete-if-last-reference. Recheck immediately before
        // the request; IYUU pending fences reduce routine automated re-adds.
        const latest=await get(this.clientUrl,'/api/v2/torrents/info',this.cookie),live=latest.find(x=>x.hash===hash),lastState=batchState(P.loadState(),key,confirmed,exact);
        if(!live||!sameMembers(P.structural(latest,live,Date.now()/1000,lastState).group,expected))throw new Error('members_changed');
        if(!P.decision(latest,live,lastState).allCleanup)throw new Error('permit_changed');
        if(lastState.otherRootProtected!==true)throw new Error('other_reference');
        if(Date.now()>deadline)throw new Error('batch_timeout');
        const deleteFiles=expected.size===1;
        await this.client.deleteTorrent(this.clientUrl,this.cookie,hash,deleteFiles);
        const after=await get(this.clientUrl,'/api/v2/torrents/info',this.cookie);
        if(after.some(x=>x.hash===hash))throw new Error('delete_not_confirmed');
        expected.delete(hash);confirmed.push(live);removed++;stats.removed++;
        if(deleteFiles)stats.filesDeleted++;
        // Additional siblings bypass native autoDelete bookkeeping. Record
        // actual confirmed exits, not attempts, and keep a failure counter.
        try{
          const util=require('/app/vertex/app/libs/util'),when=Math.floor(Date.now()/1000);
          await util.runRecord('update torrents set size = ?, tracker = ?, upload = ?, download = ?, delete_time = ?, record_note = ? where hash = ?',
            [live.size,P.host(live),live.uploaded,live.downloaded,when,'删种规则: '+rule.alias+'; 内容组已确认退出',hash]);
          if(this.groupDeleteOwnsHistory?.has(rule.id)||hash!==torrent.hash)await util.runRecord('insert into torrent_flow (hash, upload, download, time) values (?, ?, ?, ?)',[hash,live.uploaded,live.downloaded,when]);
        }catch(_){stats.recordErrors++;}
        try{await this.ntf.deleteTorrent(this._client,normalized(live),rule,deleteFiles);}catch(_){}
        require('/app/vertex/app/libs/logger').info('内容组回收确认',this.alias,rule.alias,'files='+deleteFiles,'batch=true');
      }
      stats.groupsDeleted++;
      require('/app/vertex/app/libs/logger').info('内容组整批回收确认','members='+removed,'files=true');
      return true;
    }catch(e){
      stats.blocked++;if(removed)stats.partialBatches++;
      const reason=BLOCK_REASONS.has(e.message)?e.message:'operation_failed';
      stats.blockReasons[reason]=(stats.blockReasons[reason]||0)+1;
      require('/app/vertex/app/libs/logger').info('内容组整批回收停止','reason='+reason,'removed='+removed);
      return false;
    }finally{if(locked)this.codexGroupGuardBatchLock=false;}
  };
  // The patched native scheduler defers history writes for this rule until the
  // guard confirms each removal. Other native rule bookkeeping is unchanged.
  if(c.supportsConfirmedGroupHistory===true){c.groupDeleteOwnsHistory=c.groupDeleteOwnsHistory||new Set();c.groupDeleteOwnsHistory.add(RID);}
  c.codexGroupGuardVersion=VERSION;return true;
}
function orderCandidates(rows,state,now,completedBatches=0){
  if(!P.exactMode(state)||!P.fresh(state,now))return rows;
  const ranked=new Map(),waiting=new Map((state.refreshHints?.groups||[]).map(g=>[g.key,g.since]));
  for(const e of P.exactEngine().context(rows,state,now).groups){
    if(!e.valid||!e.group.length||!P.decision(rows,e.group[0],state,now).allCleanup)continue;
    const a=state.audits[e.key];
    if(!Number.isSafeInteger(a?.allocated)||a.allocated<0)continue;
    const since=waiting.get(e.key),age=Number.isFinite(since)&&since>0&&since<=now?since:now;
    for(const t of e.group)ranked.set(t,{bytes:a.allocated,since:age});
  }
  // Alternate largest audited allocation with oldest waiting group after each
  // successful batch. Size cannot override eligibility or the native fit gate.
  const fair=completedBatches%2===1;
  return [...rows].sort((a,b)=>{
    const x=ranked.get(a),y=ranked.get(b);
    if(!x||!y)return Number(!!y)-Number(!!x);
    return (fair?x.since-y.since:y.bytes-x.bytes)||(fair?y.bytes-x.bytes:x.since-y.since);
  });
}
module.exports={install,get,RID,VERSION,orderCandidates};
