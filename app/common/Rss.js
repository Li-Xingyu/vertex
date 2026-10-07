const rss = require('../libs/rss');
const util = require('../libs/util');
const logger = require('../libs/logger');
const redis = require('../libs/redis');
const cron = require('node-cron');
const bencode = require('bencode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const Push = require('./Push');
const admission = require('../libs/rss-admission');
const providers = require('../libs/torrent-providers');

class Rss {
  constructor (rss) {
    this._rss = rss;
    this.id = rss.id;
    this.maxSleepTime = rss.maxSleepTime;
    this.lastRssTime = 0;
    this.alias = rss.alias;
    this.urls = rss.rssUrls;
    this.clientArr = rss.clientArr || [rss.client];
    this.clientSortBy = rss.clientSortBy;
    this.autoReseed = rss.autoReseed;
    this.onlyReseed = rss.onlyReseed;
    this.reseedClients = rss.reseedClients;
    this.pushMessage = rss.pushMessage;
    this.skipSameTorrent = rss.skipSameTorrent;
    this.scrapeFree = rss.scrapeFree;
    this.scrapeHr = rss.scrapeHr;
    this.sleepTime = rss.sleepTime;
    this.cookie = rss.cookie;
    this.savePath = rss.savePath;
    this.category = rss.category;
    this.paused = rss.paused;
    this.autoTMM = rss.autoTMM;
    this.useCustomRegex = rss.useCustomRegex;
    this.regexStr = rss.regexStr;
    this.replaceStr = rss.replaceStr;
    this.addCountPerHour = rss.addCountPerHour === 0 || rss.addCountPerHour === '0' ? 0 : (+rss.addCountPerHour || 20);
    this.addCount = 0;
    this.countHour = Math.floor(Date.now() / 3600000);
    this.pushTorrentFile = rss.pushTorrentFile;
    this.notify = util.listPush().filter(item => item.id === rss.notify)[0] || {};
    this.notify.push = rss.pushNotify;
    this.notify.dryrun = rss.dryrun;
    this.ntf = new Push(this.notify);
    this._acceptRules = rss.acceptRules || [];
    this._rejectRules = rss.rejectRules || [];
    this.acceptRules = util.listRssRule().filter(item => (this._acceptRules.indexOf(item.id) !== -1)).sort((a, b) => +b.priority - +a.priority);
    this.rejectRules = util.listRssRule().filter(item => (this._rejectRules.indexOf(item.id) !== -1)).sort((a, b) => +b.priority - +a.priority);
    this.downloadLimit = util.calSize(rss.downloadLimit, rss.downloadLimitUnit);
    this.uploadLimit = util.calSize(rss.uploadLimit, rss.uploadLimitUnit);
    this.maxClientUploadSpeed = util.calSize(rss.maxClientUploadSpeed, rss.maxClientUploadSpeedUnit);
    this.maxClientDownloadSpeed = util.calSize(rss.maxClientDownloadSpeed, rss.maxClientDownloadSpeedUnit);
    this.maxClientDownloadCount = +rss.maxClientDownloadCount;
    if (!rss.dryrun) {
      this.rssJob = cron.schedule(rss.cron, async () => { try { await this.rss(); } catch (e) { logger.error(this.alias, e); } });
      this.clearCount = cron.schedule('0 * * * *', () => this._updateHourCount());
      logger.info('Rss 任务', this.alias, '初始化完毕');
    }
  }

  _all (str, keys) {
    if (!keys || keys.length === 0) return true;
    for (const key of keys) {
      if (str.indexOf(key) === -1) return false;
    }
    return true;
  };

  _sum (arr) {
    let sum = 0;
    for (const item of arr) {
      sum += item;
    }
    return sum;
  }

  _getSum (a, b) {
    return a + b;
  };

  async _downloadTorrent (url, _hash) {
    if (_hash && fs.existsSync(path.join(__dirname, '../../torrents', _hash + '.torrent'))) {
      return { hash: _hash, filepath: path.join(__dirname, '../../torrents', _hash + '.torrent') };
    }
    const res = await util.requestPromise({
      url: url,
      method: 'GET',
      encoding: null,
      headers: {
        cookie: this.cookie
      }
    });
    const buffer = Buffer.from(res.body, 'utf-8');
    const torrent = bencode.decode(buffer);
    const size = torrent.info.length || torrent.info.files.map(i => i.length).reduce(this._getSum, 0);
    const fsHash = crypto.createHash('sha1');
    fsHash.update(bencode.encode(torrent.info));
    const md5 = fsHash.digest('md5');
    let hash = '';
    for (const v of md5) {
      hash += v < 16 ? '0' + v.toString(16) : v.toString(16);
    };
    const filepath = path.join(__dirname, '../../torrents', hash + '.torrent');
    fs.writeFileSync(filepath, buffer);
    return {
      filepath,
      hash,
      size,
      name: torrent.info.name.toString()
    };
  };

  _fitConditions (_torrent, conditions) {
    let fit = true;
    const torrent = { ..._torrent };
    torrent.description = torrent.description || '';
    for (const condition of conditions) {
      let value;
      switch (condition.compareType) {
      case 'equals':
        fit = fit && (torrent[condition.key] === condition.value || torrent[condition.key] === +condition.value);
        break;
      case 'bigger':
        value = 1;
        condition.value.split('*').forEach(item => {
          value *= +item;
        });
        fit = fit && torrent[condition.key] > value;
        break;
      case 'smaller':
        value = 1;
        condition.value.split('*').forEach(item => {
          value *= +item;
        });
        fit = fit && torrent[condition.key] < value;
        break;
      case 'contain':
        fit = fit && condition.value.split(',').filter(item => torrent[condition.key].indexOf(item) !== -1).length !== 0;
        break;
      case 'includeIn':
        fit = fit && condition.value.split(',').indexOf(torrent[condition.key]) !== -1;
        break;
      case 'notContain':
        fit = fit && condition.value.split(',').filter(item => torrent[condition.key].indexOf(item) !== -1).length === 0;
        break;
      case 'notIncludeIn':
        fit = fit && condition.value.split(',').indexOf(torrent[condition.key]) === -1;
        break;
      case 'regExp':
        fit = fit && (torrent[condition.key] + '').match(new RegExp(condition.value, 'ig'));
        break;
      case 'notRegExp':
        fit = fit && !(torrent[condition.key] + '').match(new RegExp(condition.value, 'ig'));
        break;
      }
    }
    return fit;
  }

  _fitRule (_rule, _torrent) {
    const rule = { ..._rule };
    const torrent = { ..._torrent };
    if (rule.type === 'javascript') {
      try {
        // eslint-disable-next-line no-eval
        return (eval(rule.code))(torrent);
      } catch (e) {
        logger.error(this.alias, 'Rss 规则', rule.alias, '存在语法错误\n', e);
        return false;
      }
    } else {
      try {
        return rule.conditions.length !== 0 && this._fitConditions(torrent, rule.conditions);
      } catch (e) {
        logger.error(this.alias, 'Rss 规则', rule.alias, '遇到错误\n', e);
        return false;
      }
    }
  }

  destroy () {
    logger.info('销毁 Rss 实例:', this.alias);
    this.rssJob.stop();
    delete this.rssJob;
    this.clearCount.stop();
    delete this.clearCount;
    delete global.runningRss[this.id];
  }

  reloadRssRule () {
    logger.info('重新载入 Rss 规则', this.alias);
    this.acceptRules = util.listRssRule().filter(item => (this._acceptRules.indexOf(item.id) !== -1)).sort((a, b) => +b.priority - +a.priority);
    this.rejectRules = util.listRssRule().filter(item => (this._rejectRules.indexOf(item.id) !== -1)).sort((a, b) => +b.priority - +a.priority);
  }

  reloadPush () {
    logger.info('Rss', this.alias, '重新载入推送方式');
    this.notify = util.listPush().filter(item => item.id === this._rss.notify)[0] || {};
    this.notify.push = this._rss.pushNotify;
    this.ntf = new Push(this.notify);
  }

  _updateHourCount () {
    const hour = Math.floor(Date.now() / 3600000);
    if (this.countHour !== hour) {
      this.countHour = hour;
      this.addCount = 0;
    }
  }

  async _addTracked (torrent, client, category, reseed, submit) {
    const operation = await admission.reserve(this, torrent, client, category, reseed);
    if (!operation) return { deferred: 'reserved' };
    this.addCount += 1;
    const state = { requestStarted: false, accepted: false, trueHash: '' };
    try {
      await submit(operation, state);
      state.accepted = true;
      const actualHash = state.trueHash || (admission.isHash(torrent.hash) ? torrent.hash : '');
      if (client._client.type === 'qBittorrent') {
        await admission.mark(operation, 'confirming', actualHash);
        if (!actualHash || !await client.hasTorrent(actualHash)) return { deferred: 'confirmation', accepted: true };
        await admission.mark(operation, 'confirmed', actualHash);
      } else {
        await admission.mark(operation, 'accepted', actualHash);
      }
      await admission.finish(this, torrent, client, category, operation, state.trueHash, reseed);
    } catch (error) {
      if (state.accepted || error.torrentAccepted) {
        try { await admission.mark(operation, 'accepted', state.trueHash); } catch (_) {}
        logger.warn(this.alias, '下载器已接受，历史待同步', error.code || 'DB_WRITE_PENDING');
        return { deferred: 'history', accepted: true };
      }
      if (!state.requestStarted || error.notSubmitted) {
        try {
          await admission.release(operation);
          if (['SQLITE_CONSTRAINT_UNIQUE', 'RSS_ALREADY_ADMITTED'].includes(error.code)) return { deferred: 'reserved' };
          await util.runRecord('INSERT INTO torrents (hash,name,size,rss_id,link,record_time,record_type,record_note) VALUES (?,?,?,?,?,?,?,?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 3, '添加种子失败: 未提交']);
        } catch (_) {
          logger.warn(this.alias, '未提交操作的历史待同步');
        }
        logger.error(this.alias, '下载器未接受添加', error.code || 'ADD_REJECTED');
        try { await this.ntf.addTorrentError(this._rss, client, torrent); } catch (_) {}
        return { failed: true };
      }
      try { await admission.mark(operation, 'uncertain', state.trueHash); } catch (_) {}
      logger.warn(this.alias, '下载器提交结果待核对，不自动重复添加', error.code || 'ADD_OUTCOME_UNKNOWN');
      return { deferred: 'confirmation' };
    } finally {
      admission.end(operation);
    }
    try { await this.ntf.addTorrent(this._rss, client, torrent); } catch (_) { logger.warn(this.alias, '添加通知发送失败'); }
    return { accepted: true };
  }

  async _pushTorrent (torrent, _client) {
    if (this.autoReseed && torrent.hash.indexOf('fakehash') === -1) {
      for (const key of this.reseedClients) {
        const client = global.runningClient[key];
        if (!client) {
          logger.error('Rss', this.alias, '下载器', key, '不存在');
          continue;
        }
        for (const _torrent of client.maindata.torrents) {
          if (+_torrent.size === +torrent.size && +_torrent.completed === +_torrent.size) {
            const bencodeInfo = await rss.getTorrentNameByBencode(torrent.url);
            if (_torrent.name === bencodeInfo.name && _torrent.hash !== bencodeInfo.hash) {
              return this._addTracked(torrent, client, this.category, true, async (operation, state) => {
                state.trueHash = bencodeInfo.hash;
                await admission.mark(operation, 'submitting', state.trueHash);
                state.requestStarted = true;
                await client.addTorrent(torrent.url, torrent.hash, true, this.uploadLimit, this.downloadLimit, _torrent.savePath, this.category, undefined, false, true);
              });
            }
          }
        }
      }
    }
    if (!this.onlyReseed) {
      let speed;
      if (_client.sameServerClients) {
        speed = {
          uploadSpeed: this._sum(_client.sameServerClients.map(index => global.runningClient[index]?.maindata?.uploadSpeed || 0)),
          downloadSpeed: this._sum(_client.sameServerClients.map(index => global.runningClient[index]?.maindata?.downloadSpeed || 0))
        };
      } else {
        speed = {
          uploadSpeed: _client.avgUploadSpeed,
          downloadSpeed: _client.avgDownloadSpeed
        };
      }
      if (_client.maxUploadSpeed && speed.uploadSpeed > _client.maxUploadSpeed) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 超过下载器最大上传速度 ${util.formatSize(speed.uploadSpeed)}/s`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 超过下载器最大上传速度 ${util.formatSize(speed.uploadSpeed)}/s`);
        return;
      }
      if (_client.maxDownloadSpeed && speed.downloadSpeed > _client.maxDownloadSpeed) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 超过下载器最大下载速度 ${util.formatSize(speed.downloadSpeed)}/s`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 超过下载器最大下载速度 ${util.formatSize(speed.downloadSpeed)}/s`);
        return;
      }
      const leechNum = _client.maindata.leechingCount;
      if (_client.maxLeechNum && leechNum >= _client.maxLeechNum) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 超过下载器最大下载数量 ${leechNum}`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 超过下载器最大下载数量 ${leechNum}`);
        return;
      }
      if (_client.minFreeSpace && _client.maindata.freeSpaceOnDisk <= _client.minFreeSpace) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 低于下载器最小剩余空间 ${util.formatSize(_client.maindata.freeSpaceOnDisk)}`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 低于下载器最小剩余空间 ${util.formatSize(_client.maindata.freeSpaceOnDisk)}`);
        return;
      }
      const fitRules = this.acceptRules.filter(item => this._fitRule(item, torrent));
      if (fitRules.length === 0 && this.acceptRules.length !== 0) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 不符合所有规则']);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: 不符合所有规则');
        return;
      }
      if (this.scrapeFree && providers.metadata(torrent) && torrent.downloadFactor !== 0) return;
      if (this.scrapeHr && providers.metadata(torrent) && torrent.hrState !== 'exempt') return;
      if (this.scrapeFree && !providers.metadata(torrent)) {
        try {
          if (!await util.scrapeFree(torrent.link, this.cookie)) {
            const isScraped = await redis.get(`vertex:scrape:free:${torrent.hash}`);
            if (this.sleepTime && (moment().unix() - +this.sleepTime) < torrent.pubTime && !isScraped) {
              logger.info(this.alias, '已设置等待时间', this.sleepTime, ', ', torrent.name, '发布时间为', moment(torrent.pubTime * 1000).format('YYYY-MM-DD HH:mm:ss'), ', 跳过');
              await redis.setWithExpire(`vertex:scrape:free:${torrent.hash}`, '7777', 3600 * 4);
            } else {
              await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
                [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 非免费种']);
            }
            await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: 非免费种');
            return;
          }
        } catch (e) {
          logger.error(this.alias, '抓取免费种子失败: ', e.message);
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 抓取免费种子失败 ${e.message}`]);
          await this.ntf.scrapeError(this._rss, torrent);
          return;
        }
      }
      if (this.scrapeHr && !providers.metadata(torrent)) {
        try {
          if (await util.scrapeHr(torrent.link, this.cookie)) {
            await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
              [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: HR']);
            await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: HR');
            return;
          }
        } catch (e) {
          logger.error(this.alias, '抓取 HR 种子失败: ', e.message);
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 抓取 HR 种子失败 ${e.message}`]);
          await this.ntf.scrapeError(this._rss, torrent);
          return;
        }
      }
      if (this.skipSameTorrent) {
        for (const key of Object.keys(global.runningClient)) {
          const client = global.runningClient[key];
          if (!client || !client.maindata || client._client.type !== 'qBittorrent') {
            continue;
          }
          for (const _torrent of client.maindata.torrents) {
            if (+_torrent.size === +torrent.size) {
              await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
                [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 跳过同大小种子']);
              await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: 跳过同大小种子');
              return;
            }
          }
        }
        const sameTorrent = await util.getRecord('select * from torrents where size = ? and add_time > ?', [torrent.size, moment().unix() - 1200]);
        if (sameTorrent && sameTorrent.id) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 跳过同大小种子']);
          await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: 跳过同大小种子');
          return;
        }
      }
      const fitRule = fitRules[0] || {};
      let savePath = fitRule.savePath || this.savePath;
      if (savePath) {
        savePath = savePath.replace('{RANDOM}', util.uuid.v4().replace(/-/g, ''));
      }
      const category = fitRule.category || this.category;
      const client = fitRule.client ? global.runningClient[fitRule.client] : _client;
      await providers.finalCheck(this, torrent, client);
      return this._addTracked(torrent, client, category, false, async (operation, state) => {
        await providers.finalCheck(this, torrent, client);
        let url = torrent.url;
        if (this.useCustomRegex) {
          const match = this.regexStr.match(/^\/(.*)\/([gimuy]*)$/);
          if (!match) throw Object.assign(new Error('RSS_REGEX_INVALID'), { code: 'RSS_REGEX_INVALID' });
          const [, pattern, flags] = match;
          url = url.replace(new RegExp(pattern, flags), this.replaceStr);
        }
        // A GUID can look like a hash without being the torrent infohash.
        // Resolve qB's real identity before submitting, including URL-mode RSS.
        if (client._client.type === 'qBittorrent' || this.pushTorrentFile || !admission.isHash(torrent.hash)) {
          const { filepath, hash } = providers.metadata(torrent) || await this._downloadTorrent(url, !this.useCustomRegex && admission.isHash(torrent.hash) ? torrent.hash : undefined);
          state.trueHash = hash;
          await admission.mark(operation, 'submitting', hash);
          state.requestStarted = true;
          await client.addTorrentByTorrentFile(filepath, hash, false, this.uploadLimit, this.downloadLimit, savePath, category, this.autoTMM, this.paused, true);
        } else {
          await admission.mark(operation, 'submitting');
          state.requestStarted = true;
          await client.addTorrent(url, torrent.hash, false, this.uploadLimit, this.downloadLimit, savePath, category, this.autoTMM, this.paused, true);
        }
      });
    }
  }

  async rss (_torrents) {
    if (this.rssBusy) return { skipped: 'overlap' };
    this.rssBusy = true;
    try {
      this._updateHourCount();
      this.pendingAdmission = await admission.reconcile(this);
      return await this._rssCycle(_torrents);
    } finally {
      this.rssBusy = false;
    }
  }

  async _rssCycle (_torrents) {
    let torrents = [];
    const source = await providers.begin(this, _torrents);
    if (source) {
      torrents = source.candidates;
    } else if (_torrents) {
      torrents = _torrents;
    } else {
      torrents = (await Promise.all(this.urls.map(url => rss.getTorrents(url)))).flat();
    }
    let databaseFailures = 0;
    for (const torrent of torrents) {
      try {
        const availableClients = this.clientArr
          .map(item => global.runningClient[item])
          .filter(item => {
            return !!item && !!item.status && !!item.maindata &&
            (!this.maxClientUploadSpeed || this.maxClientUploadSpeed > item.avgUploadSpeed) &&
            (!this.maxClientDownloadSpeed || this.maxClientDownloadSpeed > item.avgDownloadSpeed) &&
            (!this.maxClientDownloadCount || this.maxClientDownloadCount > item.maindata.leechingCount);
          });
        const firstClient = availableClients
          .filter(item => {
            return (!item.maxDownloadSpeed || item.maxDownloadSpeed > item.avgDownloadSpeed) &&
            (!item.maxUploadSpeed || item.maxUploadSpeed > item.avgUploadSpeed) &&
            (!item.maxLeechNum || item.maxLeechNum > item.maindata.leechingCount) &&
            (!item.minFreeSpace || item.minFreeSpace < item.maindata.freeSpaceOnDisk);
          })
          .sort((a, b) => (this.clientSortBy === 'freeSpaceOnDisk' ? -1 : 1) *
          (a.maindata[this.clientSortBy] - b.maindata[this.clientSortBy])
          )[0] || availableClients[0];
        const sqlRes = await util.getRecord('SELECT * FROM torrents WHERE hash = ? AND rss_id = ? ORDER BY id DESC LIMIT 1', [torrent.hash, this.id]);
        if (!admission.retryableHistory(sqlRes, moment().unix())) continue;
        if (torrent.name.indexOf('[FROZEN]') !== -1) continue;
        if (this.addCountPerHour > 0 && this.addCount >= this.addCountPerHour) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 达到单小时推送上限: ${this.addCount} / ${this.addCountPerHour}`]);
          await this.ntf.rejectTorrent(this._rss, undefined, torrent, `拒绝原因: 达到单小时推送上限: ${this.addCount} / ${this.addCountPerHour}`);
          return;
        }
        if (moment().unix() - this.lastRssTime > +this.maxSleepTime) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 最长休眠时间']);
          await this.ntf.rejectTorrent(this._rss, undefined, torrent, '拒绝原因: 最长休眠时间');
          continue;
        }
        if (!firstClient) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 无可用下载器']);
          await this.ntf.rejectTorrent(this._rss, undefined, torrent, '拒绝原因: 无可用下载器');
          logger.error(this.alias, '无可用下载器');
          continue;
        }
        // List sizes are rounded. Resolve exact metadata BEFORE final rules,
        // native reservations and submission; preview never enters this path.
        if (source && !await providers.prepare(this, torrent, firstClient)) continue;
        let reject = false;
        for (const rejectRule of this.rejectRules) {
          if (this._fitRule(rejectRule, torrent)) {
            await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
              [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝规则: ${rejectRule.alias}`]);
            await this.ntf.rejectTorrent(this._rss, undefined, torrent, `拒绝规则: ${rejectRule.alias}`);
            reject = true;
            break;
          }
        }
        if (!reject) {
          await this._pushTorrent(torrent, firstClient);
        }
      } catch (error) {
        if (source && error.code === 'PROVIDER_METADATA_DEFERRED') {
          logger.info(this.alias, '元数据预算已用尽，本轮剩余候选延后重新评估');
          break;
        }
        logger.error(this.alias, 'RSS候选处理失败', error.code || 'RSS_ITEM_FAILED');
        if (/^(?:DB_|SQLITE_)/.test(error.code || '') && ++databaseFailures >= 3) break;
      }
    }
    this.lastRssTime = moment().unix();
  }

  async dryrun () {
    const torrents = (await Promise.all(this.urls.map(url => rss.getTorrents(url)))).flat();
    for (const torrent of torrents) {
      let reject = false;
      for (const rejectRule of this.rejectRules) {
        if (this._fitRule(rejectRule, torrent)) {
          torrent.status = '匹配到拒绝规则: ' + rejectRule.alias;
          reject = true;
          break;
        }
      }
      if (reject) {
        continue;
      }
      const fitRules = this.acceptRules.filter(item => this._fitRule(item, torrent));
      if (this.acceptRules.length === 0) {
        torrent.status = '无选择规则, 默认选中该种子';
        continue;
      } else if (fitRules.length === 0) {
        torrent.status = '未匹配到规则';
        continue;
      } else {
        torrent.status = '匹配到选择规则: ' + fitRules[0].alias;
        continue;
      }
    }
    return torrents;
  }

  async mikanSearch (name) {
    const torrents = await util.mikanSearch(name);
    for (const torrent of torrents) {
      let reject = false;
      for (const rejectRule of this.rejectRules) {
        if (this._fitRule(rejectRule, torrent)) {
          torrent.status = '匹配到拒绝规则: ' + rejectRule.alias;
          reject = true;
          break;
        }
      }
      if (reject) {
        continue;
      }
      const fitRules = this.acceptRules.filter(item => this._fitRule(item, torrent));
      if (this.acceptRules.length === 0) {
        torrent.status = '无选择规则, 默认选中该种子';
        continue;
      } else if (fitRules.length === 0) {
        torrent.status = '未匹配到规则';
        continue;
      } else {
        torrent.status = '匹配到选择规则: ' + fitRules[0].alias;
        continue;
      }
    }
    return torrents;
  }
}
module.exports = Rss;
