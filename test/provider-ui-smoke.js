'use strict';
// ONLY a disposable, network-none container with a fresh /vertex tmpfs.
const assert = require('assert').strict;
const fs = require('fs');
const http = require('http');
const puppeteer = require('puppeteer');
const { ProviderStore } = require('../app/libs/provider-store');
const { digest } = require('../app/libs/provider-schema');
let phase = 'login';
function request (method, path, body, cookie, header = true) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
    if (header) headers['X-Vertex-Config'] = '1';
    if (cookie) headers.cookie = cookie;
    const req = http.request({ hostname: '127.0.0.1', port: 3000, method, path, headers, timeout: 10000 }, res => {
      let text = '';
      res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, cookie: (res.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; '), text }));
    });
    req.on('timeout', () => req.destroy(Error('TEST_TIMEOUT'))); req.on('error', reject); req.end(payload);
  });
}
async function main () {
  if (fs.readdirSync('/vertex/data/rss').length || fs.readdirSync('/vertex/data/client').length) throw Error('TEST_REQUIRES_EMPTY_FIXTURE');
  const setting = JSON.parse(fs.readFileSync('/vertex/data/setting.json'));
  const login = await request('POST', '/api/user/login', { username: setting.username, password: setting.password });
  assert(JSON.parse(login.text).success);
  const cookie = login.cookie;
  phase = 'protected-api';
  const unauth = await request('GET', '/api/provider/list'); assert(!JSON.parse(unauth.text).success);
  const data = JSON.parse((await request('GET', '/api/provider/list', null, cookie)).text).data;
  assert.equal(data.profiles.length, Object.keys(require('../app/libs/provider-profiles').profiles).length); assert.equal(data.records.length, 0);
  const cfg = JSON.parse((await request('GET', '/api/provider/defaults?profile=NANYANG&rssId=1234abcd', null, cookie)).text).data;
  assert(!Object.hasOwnProperty.call(cfg.budgets, 'metadataPerHour'));
  assert(data.profiles.every(p => !Object.hasOwnProperty.call(p.budgetCaps, 'metadataPerHour')));
  const bad = await request('POST', '/api/provider/apply', { config: cfg, expectedRevision: 0 }, cookie, false); assert.equal(bad.status, 400);
  const noProof = await request('POST', '/api/provider/apply', { config: cfg, expectedRevision: 0, token: 'UI-ONLY-NOT-A-REAL-PROOF' }, cookie);
  assert.equal(noProof.status, 400); assert.equal(JSON.parse(noProof.text).message, 'PROVIDER_PREVIEW_REQUIRED');
  const valid = await request('POST', '/api/provider/validate', { config: cfg }, cookie); assert(JSON.parse(valid.text).success);
  // The fixture contains no authentication information and is disabled.
  fs.writeFileSync('/vertex/data/rss/1234abcd.json', JSON.stringify({ id: '1234abcd', alias: '隔离采集示例', category: 'NANYANG', enable: false, rssUrls: [], clientArr: [] }));
  phase = 'browser';
  const browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  let page;
  try {
    page = await browser.newPage(); const failures = [];
    page.on('pageerror', () => failures.push('pageerror'));
    page.on('console', msg => { if (msg.type() === 'warning' && /Failed to resolve component/.test(msg.text())) failures.push('unresolved-component'); });
    for (const entry of cookie.split('; ')) { const i = entry.indexOf('='); await page.setCookie({ name: entry.slice(0, i), value: entry.slice(i + 1), url: 'http://127.0.0.1:3000', httpOnly: true }); }
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto('http://127.0.0.1:3000/task/provider', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.provider-page');
    const clickText = async text => { const buttons = await page.$$('button'); const visible = []; for (const b of buttons) { if (await b.boundingBox() && await b.evaluate((el, needle) => el.textContent.replace(/\s/g, '').includes(needle), text.replace(/\s/g, ''))) visible.push(b); } assert(visible.length, 'button missing: ' + text); await visible[visible.length - 1].click(); };
    const tab = async text => { const [el] = await page.$x('//*[@role="tab" and contains(., "' + text + '")]'); assert(el, 'tab missing'); await el.click(); };
    const setIntervalField = async value => { await page.click('#provider-interval', { clickCount: 3 }); await page.keyboard.press('Backspace'); if (value) await page.keyboard.type(value); await page.keyboard.press('Tab'); };
    const applyDisabled = () => page.$eval('.provider-actions [aria-describedby="provider-apply-help"]', e => e.disabled);
    const confirmChoice = async text => { await page.waitForSelector('.ant-modal-confirm'); await page.waitForTimeout(350); await clickText(text); await page.waitForFunction(() => !document.querySelector('.ant-modal-confirm')); };
    const loadTemplate = async () => {
      await page.click('#provider-rss'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      await page.click('#provider-profile'); await page.keyboard.type('NANYANG'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      await clickText('载入模板'); await page.waitForFunction(() => document.body.textContent.includes('模板已载入'));
    };
    await loadTemplate();
    assert.equal(await page.$eval('#provider-connectSeconds', e => e.value), '15');
    assert.equal(await page.$eval('#provider-readSeconds', e => e.value), '30');
    assert.equal(await page.$eval('#provider-requestSeconds', e => e.value), '60');
    assert.equal(await page.$eval('#provider-cycleSeconds', e => e.value), '120');
    assert.equal(JSON.parse((await request('GET', '/api/provider/list', null, cookie)).text).data.records.length, 0);
    assert(await applyDisabled());
    assert(!await page.$eval('.provider-page', e => /版本记录|保存草稿|编辑 v\d/.test(e.textContent)));
    assert(await page.$eval('.provider-page', e => e.textContent.includes('不设小时配额')));
    assert(!await page.$$eval('.ant-form-item-label', labels => labels.some(e => e.textContent.includes('元数据预算'))));
    phase = 'personal-rule-editor';
    await tab('解析规则');
    assert.equal(await page.$eval('#personal-selector-0', e => e.value), 'td[title="Seeding"]');
    assert(await page.$eval('.ant-tabs-tabpane-active', e => e.textContent.includes('不会永久拒绝')));
    await clickText('新增个人状态规则');
    assert.equal(await page.$eval('#personal-selector-2', e => e.value), '[title]');
    await page.click('[aria-label="移除个人状态 3"]');
    assert.equal(await page.$('#personal-selector-2'), null);
    await tab('基础设置');
    phase = 'unsaved-guards';
    await setIntervalField('600');
    await clickText('结束编辑');
    await confirmChoice('继续编辑');
    phase = 'unsaved-cancel-modal';
    await page.waitForFunction(() => !document.querySelector('.ant-modal-confirm'));
    assert.equal(await page.$eval('#provider-interval', e => e.value), '600');
    const [rssMenu] = await page.$x('//*[@role="menuitem" and contains(., "RSS 任务")]'); assert(rssMenu); await rssMenu.click();
    phase = 'unsaved-route-modal';
    await confirmChoice('继续编辑');
    phase = 'unsaved-route-cancel';
    await page.waitForFunction(() => !document.querySelector('.ant-modal-confirm'));
    assert(page.url().endsWith('/task/provider'), 'route guard must preserve editor');
    await clickText('结束编辑'); await confirmChoice('放弃修改');
    phase = 'unsaved-discard-modal';
    await page.waitForSelector('#provider-rss');
    await loadTemplate();
    assert.equal(await page.$eval('#provider-interval', e => e.value), String(cfg.intervalSeconds));
    phase = 'inline-validation';
    await setIntervalField(''); await clickText('预览');
    await page.waitForSelector('.ant-form-item-has-error');
    assert.equal(JSON.parse((await request('GET', '/api/provider/list', null, cookie)).text).data.records.length, 0);
    await setIntervalField(String(cfg.intervalSeconds)); await clickText('校验配置');
    await page.waitForFunction(() => document.body.textContent.includes('结构与选择器校验通过'));
    phase = 'timeout-validation';
    const setTimeoutField = async (key, value) => { await page.click('#provider-' + key, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.keyboard.type(value); await page.keyboard.press('Tab'); };
    await setTimeoutField('requestSeconds', '10'); await clickText('校验配置');
    await page.waitForFunction(() => document.body.textContent.includes('单页须覆盖连接和读取'));
    await setTimeoutField('requestSeconds', '60'); await clickText('校验配置');
    await page.waitForFunction(() => document.body.textContent.includes('结构与选择器校验通过'));
    phase = 'preview-presentation-fixtures';
    // Presentation fixtures only. Apply writes synthetic tmpfs via the real
    // store but deliberately does NOT create a production/backend preview proof.
    // Service-level proof/compatibility/ownership gates are tested in providers.js.
    let previewMode = 'ok'; let applyMode = 'ok'; let listFailure = false; let previewCalls = 0; let applyCalls = 0; let fixtureProof = null;
    const fixtureStore = new ProviderStore('/vertex/data/providers');
    await page.setRequestInterception(true);
    page.on('request', async req => {
      if (req.url().endsWith('/api/provider/preview')) {
        previewCalls++;
        fixtureProof = { digest: digest(JSON.parse(req.postData()).config), expires: Date.now() + (previewMode === 'expiring' ? 1600 : 600000) };
        const body = previewMode === 'error'
          ? { success: false, message: 'PROVIDER_AUTH' }
          : {
            success: true,
            data: {
              token: 'UI-ONLY-NOT-A-REAL-PROOF',
              expiresAt: Date.now() + (previewMode === 'expiring' ? 1600 : 600000),
              eligible: 1,
              candidates: [
                { candidateKey: 'NANYANG:1', name: '隔离预览 · 已确认免费 / 双倍上传', size: 64 * 1024 ** 3, seeders: 8, leechers: 24, downloadFactor: 0, uploadFactor: 2, hrState: 'unknown', reasons: [] },
                { candidateKey: 'NANYANG:2', name: '隔离预览 · 站内已在做种', size: null, seeders: null, leechers: 0, downloadFactor: null, uploadFactor: null, hrState: 'unknown', personalState: 'seeding', reasons: ['missing-fields', 'personal-active'] }
              ]
            }
          };
        setTimeout(() => req.respond({ status: previewMode === 'error' ? 400 : 200, contentType: 'application/json', body: JSON.stringify(body) }), 150);
      } else if (req.url().endsWith('/api/provider/apply')) {
        applyCalls++;
        if (applyMode === 'network') { await req.abort('failed'); return; }
        try {
          if (applyMode === 'reject') throw Object.assign(Error(), { code: 'PROVIDER_RSS_INCOMPATIBLE_OR_BUSY' });
          const args = JSON.parse(req.postData());
          const record = await fixtureStore.apply(args.config, args.expectedRevision, async version => {
            assert.equal(args.token, 'UI-ONLY-NOT-A-REAL-PROOF'); assert.equal(version.digest, fixtureProof.digest); assert(fixtureProof.expires > Date.now());
          });
          if (applyMode === 'lost-reply') await req.abort('failed');
          else await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: record }) });
        } catch (e) { await req.respond({ status: e.code === 'PROVIDER_REVISION_CONFLICT' ? 409 : 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: e.code || 'PROVIDER_UNAVAILABLE' }) }); }
      } else if (listFailure && req.url().endsWith('/api/provider/list')) req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false }) });
      else req.continue();
    });
    await clickText('请求一页预览').catch(async () => { await clickText('预览'); });
    await page.waitForSelector('.provider-preview-summary'); assert(!await applyDisabled());
    assert(await page.$eval('.ant-tabs-tabpane-active', e => e.textContent.includes('未知') && e.textContent.includes('来源筛选通过 1 条')));
    assert(await page.$eval('.ant-tabs-tabpane-active', e => e.textContent.includes('正在做种') && e.textContent.includes('站内当前账号正在下载／做种')));
    previewMode = 'error'; await clickText('重新预览');
    await page.waitForFunction(() => document.body.textContent.includes('登录验证失败'));
    assert(await applyDisabled()); assert.equal(await page.$('.provider-preview-summary'), null);
    previewMode = 'expiring'; await clickText('请求一页预览'); await page.waitForSelector('.provider-preview-summary');
    await page.waitForFunction(() => document.querySelector('#provider-apply-help').textContent.includes('已过期'));
    assert(await applyDisabled());
    previewMode = 'ok'; await clickText('重新预览'); await page.waitForFunction(() => !document.querySelector('.provider-actions [aria-describedby]').disabled);
    await tab('基础设置'); await setTimeoutField('readSeconds', '40'); assert(await applyDisabled());
    assert.equal(await page.$('.provider-preview-summary'), null);
    await setTimeoutField('readSeconds', '30'); await setIntervalField('700'); assert(await applyDisabled());
    assert.equal(await page.$('.provider-preview-summary'), null);
    listFailure = true; await clickText('刷新'); await page.waitForFunction(() => document.body.textContent.includes('操作失败，请检查服务连接'));
    assert.equal(await page.$eval('#provider-interval', e => e.value), '700');
    listFailure = false; await clickText('刷新'); await page.waitForFunction(() => !document.body.textContent.includes('操作失败，请检查服务连接'));
    phase = 'single-apply-fixtures';
    const submit = async () => { await clickText('保存并生效'); await page.waitForSelector('.ant-popover'); await clickText('确认保存'); };
    await clickText('预览'); await page.waitForFunction(() => !document.querySelector('.provider-actions [aria-describedby]').disabled);
    await submit(); await page.waitForFunction(() => document.body.textContent.includes('配置已保存并生效，等待'));
    let saved = await fixtureStore.read(cfg.rssId); assert.equal(saved.revisions.length, 1); assert.equal(saved.active, 1);
    assert(await applyDisabled());
    await tab('基础设置'); await setIntervalField('800'); await clickText('预览');
    await page.waitForFunction(() => !document.querySelector('.provider-actions [aria-describedby]').disabled);
    applyMode = 'reject'; await submit(); await page.waitForFunction(() => document.body.textContent.includes('原 RSS 任务正忙'));
    assert.equal((await fixtureStore.read(cfg.rssId)).revisions[0].config.intervalSeconds, 700);
    await tab('基础设置'); assert.equal(await page.$eval('#provider-interval', e => e.value), '800');
    phase = 'concurrent-edit-conflict';
    await fixtureStore.apply({ ...saved.revisions[0].config, intervalSeconds: 900 }, saved.revision, async () => {});
    applyMode = 'ok'; await submit(); await page.waitForFunction(() => document.body.textContent.includes('配置已被其他操作修改'));
    assert(await applyDisabled()); assert.equal(await page.$eval('#provider-interval', e => e.value), '800');
    assert.equal((await fixtureStore.read(cfg.rssId)).revisions[0].config.intervalSeconds, 900);
    await clickText('重新载入'); await confirmChoice('放弃修改'); await page.waitForSelector('#provider-interval');
    assert.equal(await page.$eval('#provider-interval', e => e.value), '900');
    phase = 'lost-apply-reply';
    await setIntervalField('1000'); await clickText('预览'); await page.waitForFunction(() => !document.querySelector('.provider-actions [aria-describedby]').disabled);
    const callsBefore = applyCalls; applyMode = 'lost-reply'; await submit();
    await page.waitForFunction(() => document.body.textContent.includes('这份配置已生效，但上次保存响应未正常完成'));
    assert.equal(applyCalls, callsBefore + 1); assert(await applyDisabled());
    assert.equal((await fixtureStore.read(cfg.rssId)).revisions.length, 1);
    phase = 'unknown-apply-outcome';
    await tab('基础设置'); await setIntervalField('1100'); await clickText('预览'); await page.waitForFunction(() => !document.querySelector('.provider-actions [aria-describedby]').disabled);
    applyMode = 'network'; listFailure = true; await submit();
    await page.waitForFunction(() => document.querySelector('#provider-apply-help').textContent.includes('上次保存结果未确认')); assert(await applyDisabled());
    listFailure = false; await clickText('刷新'); await page.waitForFunction(() => document.body.textContent.includes('已刷新生效状态'));
    await tab('基础设置'); assert.equal(await page.$eval('#provider-interval', e => e.value), '1100');
    assert(await applyDisabled());
    await clickText('结束编辑'); await confirmChoice('放弃修改'); await page.waitForSelector('#provider-rss');
    await page.click('button[aria-label="编辑 隔离采集示例"]'); await page.waitForSelector('#provider-interval');
    phase = 'suspend-and-resume';
    await clickText('停止采集'); await page.waitForSelector('.ant-popover'); await clickText('停止采集');
    await page.waitForFunction(() => document.querySelector('.provider-summary').textContent.includes('已停用'));
    assert(await applyDisabled());
    applyMode = 'ok'; await clickText('预览'); await page.waitForFunction(() => !document.querySelector('.provider-actions [aria-describedby]').disabled);
    await submit(); await page.waitForFunction(() => document.body.textContent.includes('配置已保存并生效，等待'));
    saved = await fixtureStore.read(cfg.rssId); assert.equal(saved.suspended, false); assert.equal(saved.revisions.length, 1);
    phase = 'legacy-active-config-editor';
    await fixtureStore.save({ ...saved.revisions[0].config, intervalSeconds: 1200 }, saved.revision);
    await clickText('刷新'); await clickText('结束编辑'); await page.waitForSelector('#provider-rss');
    await page.click('button[aria-label="编辑 隔离采集示例"]'); await page.waitForSelector('#provider-interval');
    assert.equal(await page.$eval('#provider-interval', e => e.value), '1000', 'legacy draft must not replace the effective editor config');
    saved = await fixtureStore.read(cfg.rssId);
    const widths = [];
    for (const width of [1440, 1024, 768, 375]) {
      phase = 'browser-width-' + width;
      await page.setViewport({ width, height: 1000 });
      if (width === 375) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
      await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.provider-page');
      await page.click('button[aria-label="编辑 隔离采集示例"]'); await page.waitForSelector('#provider-interval');
      for (const text of ['基础设置', '筛选条件', '解析规则', '预览结果']) {
        await tab(text);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
        assert.equal(overflow, false, 'page viewport overflow ' + width + ' ' + text);
        if (text === '基础设置' && (width === 1440 || width === 375)) {
          await page.$eval('#provider-readSeconds', e => e.scrollIntoView({ block: 'center' }));
          await page.screenshot({ path: '/tmp/provider-timeouts-' + width + '.png', fullPage: true });
        }
      }
      widths.push(width);
      await tab('筛选条件');
      if (width === 1440 || width === 375) {
        await page.waitForFunction(() => !document.querySelector('.ant-message-notice'));
        await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.ant-layout-content').scrollTop = 0; });
        await page.screenshot({ path: '/tmp/provider-ui-' + width + '.png', fullPage: true });
        await tab('解析规则'); await page.waitForTimeout(300); await page.screenshot({ path: '/tmp/provider-mapping-' + width + '.png', fullPage: true });
      }
    }
    phase = 'existing-page-consistency';
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/110.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1440, height: 1200 });
    await page.goto('http://127.0.0.1:3000/task/rss', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.rss .ant-input');
    const baseline = await page.evaluate(() => { const title = getComputedStyle(document.querySelector('.ant-layout-content').firstElementChild); return { title: [title.fontSize, title.fontWeight, title.lineHeight], maxWidth: getComputedStyle(document.querySelector('.rss')).maxWidth, inputHeight: getComputedStyle(document.querySelector('.rss .ant-input')).height }; });
    await page.screenshot({ path: '/tmp/provider-reference-rss.png', fullPage: true });
    await page.goto('http://127.0.0.1:3000/task/provider', { waitUntil: 'networkidle0' });
    await page.click('button[aria-label="编辑 隔离采集示例"]'); await page.waitForSelector('#provider-interval');
    const actual = await page.evaluate(() => { const title = getComputedStyle(document.querySelector('.provider-title')); return { title: [title.fontSize, title.fontWeight, title.lineHeight], maxWidth: getComputedStyle(document.querySelector('.provider-container')).maxWidth, inputHeight: getComputedStyle(document.querySelector('#provider-interval').closest('.ant-input-number')).height }; });
    assert.deepEqual(actual.title, baseline.title); assert.equal(actual.maxWidth, baseline.maxWidth); assert.equal(actual.inputHeight, baseline.inputHeight);
    await tab('筛选条件'); await page.waitForFunction(() => !document.querySelector('.ant-message-notice')); await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.ant-layout-content').scrollTop = 0; });
    await page.screenshot({ path: '/tmp/provider-ui-1440.png', fullPage: true });
    // Use the product's theme setting: its default explicit light theme correctly
    // overrides OS dark preference. This changes only the isolated tmpfs fixture.
    phase = 'dark-theme-setting';
    const theme = await request('POST', '/api/setting/modify', { theme: 'dark' }, cookie);
    assert(JSON.parse(theme.text).success);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setCacheEnabled(false);
    phase = 'dark-theme-reload';
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('button[aria-label="编辑 隔离采集示例"]');
    phase = 'dark-theme-editor';
    await page.click('button[aria-label="编辑 隔离采集示例"]'); await page.waitForSelector('#provider-interval');
    await tab('筛选条件');
    phase = 'dark-theme-colors';
    await page.waitForFunction(() => /255/.test(getComputedStyle(document.querySelector('.provider-container')).color));
    await page.waitForFunction(() => !document.querySelector('.ant-message-notice'));
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.ant-layout-content').scrollTop = 0; });
    await page.screenshot({ path: '/tmp/provider-ui-dark.png', fullPage: true });
    const dark = await page.$eval('.provider-container', e => ({ color: getComputedStyle(e).color, transition: getComputedStyle(e.querySelector('.provider-form')).transitionDuration }));
    assert(/255/.test(dark.color), 'dark theme text must inherit light foreground'); assert.equal(dark.transition, '0s');
    assert.equal(failures.length, 0);
    phase = 'persisted-api';
    const stale = await request('POST', '/api/provider/apply', { config: cfg, expectedRevision: 0 }, cookie); assert.equal(stale.status, 409);
    const activation = await request('POST', '/api/provider/apply', { config: cfg, expectedRevision: saved.revision, token: 'not-real' }, cookie);
    assert.equal(activation.status, 400); assert.equal(JSON.parse(activation.text).message, 'PROVIDER_PREVIEW_REQUIRED');
    assert(!await page.$eval('.provider-page', e => /版本记录|保存草稿|编辑 v\d/.test(e.textContent)));
    phase = 'legacy-timeouts-not-injected';
    const oldConfig = JSON.parse(JSON.stringify(cfg)); delete oldConfig.listTimeouts; delete oldConfig.personalStateRules;
    oldConfig.budgets.metadataPerHour = 24; // Readable but never shown as an active limit.
    await fixtureStore.apply(oldConfig, (await fixtureStore.read(cfg.rssId)).revision, async () => {});
    const oldBytes = fs.readFileSync('/vertex/data/providers/' + cfg.rssId + '.json', 'utf8');
    await clickText('刷新'); await page.waitForFunction(() => document.body.textContent.includes('配置已被其他操作修改'));
    await clickText('结束编辑'); await page.waitForSelector('#provider-rss');
    await page.click('button[aria-label="编辑 隔离采集示例"]'); await page.waitForSelector('#provider-interval');
    assert.equal(await page.$('#provider-readSeconds'), null);
    assert.equal(await page.$('#personal-selector-0'), null);
    assert(!await page.$eval('.provider-summary', e => e.textContent.includes('有未保存修改')));
    assert.equal(fs.readFileSync('/vertex/data/providers/' + cfg.rssId + '.json', 'utf8'), oldBytes);
    assert(await applyDisabled());
    process.stdout.write(JSON.stringify({ timeoutDefaults: true, timeoutRelationsValidated: true, timeoutEditInvalidatesPreview: true, legacyTimeoutConfigUnchanged: true }) + '\n');
    assert.equal(fs.readdirSync('/vertex/torrents').length, 0);
    process.stdout.write(JSON.stringify({ ok: true, auth: true, csrfHeader: true, serverBlocksFakeProof: true, noVersionUi: true, noDraftWrite: true, singleConfigApplyFixtures: true, conflictPreservesInput: true, lostReplyReconciledWithoutRetry: true, unknownOutcomeBlocksRetry: true, suspendAndResume: true, unsavedGuards: true, inlineValidation: true, previewFailureExpiryAndInvalidation: true, previewFixtureCalls: previewCalls, applyFixtureCalls: applyCalls, refreshFailurePreservesInput: true, existingPageTypographyAndControls: true, darkMode: true, reducedMotion: true, responsiveWidths: widths, javascriptErrors: 0, torrentFiles: 0, production: false }) + '\n');
  } catch (e) { if (page) await page.screenshot({ path: '/tmp/provider-ui-failure.png', fullPage: true }).catch(() => {}); throw e; } finally { await browser.close(); }
}
main().catch(e => { process.stderr.write('PROVIDER_UI_SMOKE_FAILED: ' + phase + ' ' + e.name + ' ' + e.message.slice(0, 150) + '\n'); process.exitCode = 1; });
