<template>
  <section class="provider-page">
    <h1 class="provider-title">站点采集</h1>
    <a-divider />
    <div class="provider-container">
      <a-alert v-if="listError" type="error" show-icon :message="listError" class="provider-message" role="alert" />
      <a-table class="provider-list" :columns="sourceColumns" :data-source="data.records" :loading="operation === 'refresh'" row-key="id" size="small" :pagination="false" :scroll="{ x: 760 }" :locale="{ emptyText: '暂无采集配置，请在下方选择 RSS 任务和站点模板。原有 RSS 不受影响。' }">
        <template #title>
          <div class="provider-table-title">
            <span class="provider-section-title">采集配置列表</span>
            <a-space><a-button size="small" :loading="operation === 'refresh'" :disabled="busy" @click="refresh">刷新</a-button><a-button size="small" :disabled="busy || !availableRss.length" @click="newConfig">新增配置</a-button></a-space>
          </div>
        </template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'source'"><div>{{ rssName(record.id) }}</div><small class="provider-secondary">{{ profileName(editableConfig(record)?.profile) }} · {{ record.id }}</small></template>
          <template v-else-if="column.key === 'state'">
            <a-tag :color="record.suspended ? 'warning' : record.active === null ? 'default' : 'success'">{{ runtimeLabel(record) }}</a-tag>
            <small v-if="rssDisabled(record.id)" class="provider-secondary provider-block">原 RSS 任务未启用</small>
          </template>
          <template v-else-if="column.key === 'time'"><span>{{ timestamp(record.status?.lastSuccess) }}</span><div v-if="record.status?.error" class="provider-status-error">{{ explain(record.status.error) }}</div><small v-if="record.status?.admission" class="provider-secondary provider-block">本轮：站内活动跳过 {{ record.status.admission.siteActiveSkips || 0 }} · 缓存确认重复 {{ record.status.admission.duplicateSkips || 0 }} · 元数据请求 {{ record.status.admission.metadataRequests || 0 }}</small><small v-if="record.status?.coverage?.personal?.outcome === 'fallback'" class="provider-secondary provider-block">个人状态查询不可用或额度已用完，本轮使用本地去重。</small></template>
          <template v-else-if="column.key === 'actions'"><a-button type="link" size="small" :disabled="busy" :aria-label="'编辑 ' + rssName(record.id)" @click="edit(record)">编辑</a-button></template>
        </template>
      </a-table>
      <p class="provider-secondary provider-list-note">列表成功仅表示获取到候选，不代表已添加下载或产生上传。</p>
      <a-divider />
      <section ref="editor" class="provider-editor" aria-labelledby="provider-editor-title" tabindex="-1">
        <div class="provider-editor-heading"><h2 id="provider-editor-title" class="provider-section-title">{{ config ? '编辑采集配置' : '新增采集配置' }}</h2><a-button v-if="config" type="link" size="small" :disabled="busy" @click="newConfig">结束编辑</a-button></div>
        <a-form v-if="!config" class="provider-form" :class="formClass" :model="createForm" :label-col="labelCol" :wrapper-col="wrapperCol" label-align="right" :label-wrap="true" size="small" autocomplete="off" @finish="create">
          <a-form-item label="RSS 任务" name="rssId" :rules="[{ required: true, message: '请选择已有 RSS 任务' }]" extra="复用原任务 ID 与历史；已创建配置的任务请在列表中编辑。">
            <a-select size="small" id="provider-rss" v-model:value="createForm.rssId" :disabled="busy" placeholder="选择已有任务" show-search option-filter-prop="label" :options="availableRss.map(r => ({ value: r.id, label: r.alias + (r.category ? ' · ' + r.category : '') }))" />
          </a-form-item>
          <a-form-item label="站点模板" name="profile" :rules="[{ required: true, message: '请选择站点模板' }]" extra="模板只提供初始配置，载入后仍需核对筛选条件和解析结果。">
            <a-select size="small" id="provider-profile" v-model:value="createForm.profile" :disabled="busy" placeholder="选择站点" show-search option-filter-prop="label" :options="data.profiles.map(p => ({ value: p.id, label: p.label + (p.adapter === 'mteam-api' ? ' · API' : ' · 列表页') }))" />
          </a-form-item>
          <a-form-item :wrapper-col="actionCol"><a-button type="primary" html-type="submit" :loading="operation === 'create'" :disabled="busy">载入模板</a-button><p class="provider-secondary provider-help">仅载入编辑，不保存、不启用，也不添加下载。</p></a-form-item>
        </a-form>
        <template v-else>
          <div class="provider-summary"><span>{{ rssName(config.rssId) }} · {{ profileName(config.profile) }}</span><a-tag v-if="dirty" color="warning">有未保存修改</a-tag><a-tag v-if="selectedRecord" :color="selectedRecord.suspended ? 'warning' : selectedRecord.active === null ? 'default' : 'success'">{{ runtimeLabel(selectedRecord) }}</a-tag></div>
          <p class="provider-secondary provider-editor-note">编辑 → 预览检查 → 保存并生效。编辑和预览不改变正在使用的配置，已有下载、保种和回收不变。</p>
          <a-alert v-if="revisionConflict" type="warning" show-icon message="配置已被其他操作修改。当前输入已保留，请重新载入后编辑。" class="provider-message"><template #description><a-button size="small" :disabled="busy" @click="edit(selectedRecord)">重新载入</a-button></template></a-alert>
          <a-alert v-if="error" type="error" show-icon :message="error" class="provider-message" role="alert" />
          <a-form ref="configForm" :model="config" class="provider-form" :class="formClass" :label-col="labelCol" :wrapper-col="wrapperCol" label-align="right" :label-wrap="true" size="small" autocomplete="off">
            <a-tabs v-model:activeKey="tab" :animated="false" class="provider-tabs">
              <a-tab-pane key="source" tab="基础设置" :force-render="true">
                <a-form-item label="采集方式"><span>{{ jsonMode ? 'MT 原生 API' : '站点列表页' }} · {{ selectedProfile.origin }}</span></a-form-item>
                <a-form-item label="认证来源" name="credentialRef" :rules="[{ required: true, message: '请选择认证来源' }]" extra="只保存引用，不显示 Cookie 或 API Key。"><a-select size="small" v-model:value="config.credentialRef" :disabled="busy" :options="credentialOptions" /></a-form-item>
                <a-form-item label="轮询间隔（秒）" name="intervalSeconds" :rules="numberRules(300, 86400, true)" extra="最短请求间隔，实际仍由原 RSS 定时器触发。"><a-input-number size="small" id="provider-interval" v-model:value="config.intervalSeconds" :min="300" :max="86400" :precision="0" :disabled="busy" /></a-form-item>
                <a-form-item label="每轮页数" name="pages" :rules="numberRules(1, 3, true)" :extra="jsonMode ? 'MT 每个分类分区固定一页。' : '只跟随实际分页，预览仅请求一页。'"><a-input-number size="small" v-model:value="config.pages" :min="1" :max="3" :precision="0" :disabled="busy || jsonMode" /></a-form-item>
                <a-form-item v-if="jsonMode" label="每页数量" name="pageSize" :rules="numberRules(1, 100, true)"><a-input-number size="small" v-model:value="config.pageSize" :min="1" :max="100" :precision="0" :disabled="busy" /></a-form-item>
                <a-form-item v-if="!jsonMode" label="请求参数" :extra="'已有 ' + Object.keys(config.params).length + ' 项参数继续生效；折叠不会清空。'"><a-checkbox v-model:checked="showParams" :disabled="busy">显示站内分类、排序等高级参数</a-checkbox></a-form-item>
                <template v-if="showParams || jsonMode"><a-form-item v-for="key in selectedProfile.queryKeys" :key="key" :label="parameterLabel(key)" :name="['params', key]" :extra="'请求参数：' + key + '；留空则不发送。'"><a-input size="small" :value="config.params[key]" :disabled="busy" @update:value="parameter(key, $event)" /></a-form-item></template>
                <a-form-item v-for="(label, key) in budgetLabels" :key="key" :label="label" :name="['budgets', key]" :rules="numberRules(1, selectedProfile.budgetCaps[key], true)" :extra="budgetHelp(key)"><a-input-number size="small" v-model:value="config.budgets[key]" :min="1" :max="selectedProfile.budgetCaps[key]" :precision="0" :disabled="busy || (key === 'detailPerHour' && !jsonMode)" /></a-form-item>
                <a-form-item label="种子文件请求"><span class="provider-secondary">不设小时配额（旧元数据额度不再生效）。先去重、同站不重叠请求，失败退避；站点限流仍会等待。</span></a-form-item>
                <template v-if="!jsonMode">
                  <a-form-item label="列表请求超时" extra="仅影响列表页请求，不增加请求预算、不自动重试，也不改变种子文件下载超时。"><a-checkbox :checked="!!config.listTimeouts" :disabled="busy" @update:checked="setTimeouts">分别配置连接、读取和总时长</a-checkbox></a-form-item>
                  <template v-if="config.listTimeouts"><a-form-item v-for="(item, key) in timeoutFields" :key="key" :label="item.label" :name="['listTimeouts', key]" :rules="timeoutRules(key)" :extra="item.help"><a-input-number :id="'provider-' + key" size="small" v-model:value="config.listTimeouts[key]" :min="1" :max="item.max" :precision="0" :disabled="busy" /></a-form-item></template>
                  <a-form-item v-else :wrapper-col="actionCol"><span class="provider-secondary">未单独配置：单页最多 20 秒、读取空闲 15 秒、整轮最多 25 秒。载入旧配置不会自动改写。</span></a-form-item>
                </template>
              </a-tab-pane>
              <a-tab-pane key="selection" tab="筛选条件" :force-render="true">
                <a-alert class="provider-message" type="info" show-icon message="这里只做来源预筛选，不能放宽原有空间、保种及去重保护。" />
                <a-form-item label="免费下载" :name="['selection', 'freeOnly']"><a-checkbox v-model:checked="config.selection.freeOnly" :disabled="busy">仅选择已确认免费</a-checkbox></a-form-item>
                <a-form-item label="H&R 入场" :name="['selection', 'hrPolicy']" extra="无标记默认未知；仅在站规已确认且配置了完整性检查时，才能判为无 H&R。此处不修改保种或删种规则。"><a-select size="small" v-model:value="config.selection.hrPolicy" :disabled="busy" :options="[{value:'protect', label:'允许入场，保留现有保种保护'}, {value:'exclude', label:'仅选择已确认无 H&R'}]" /></a-form-item>
                <a-form-item v-for="(label, key) in selectionLabels" :key="key" :label="label" :name="['selection', key]" :rules="selectionRules(key)"><a-input-number size="small" v-model:value="config.selection[key]" :min="0" :max="100000" :disabled="busy" /></a-form-item>
                <a-form-item label="多倍上传" :name="['selection', 'preferUploadFactor']" extra="上传倍率与免费分别识别。私有迁移策略仍可能执行更严格的排序。"><a-checkbox v-model:checked="config.selection.preferUploadFactor" :disabled="busy">优先已确认且未过期的上传倍率</a-checkbox></a-form-item>
                <a-form-item label="基础排序" :name="['selection', 'sort']"><a-select size="small" v-model:value="config.selection.sort" :disabled="busy" :options="[{value:'publishedAt', label:'新发布优先'}, {value:'demand', label:'需求优先（下载人数 / √做种人数 × 有效倍率）'}]" /></a-form-item>
              </a-tab-pane>
              <a-tab-pane key="mapping" tab="解析规则" :force-render="true">
                <a-alert class="provider-message" type="warning" show-icon message="高级设置：仅在页面结构变化或预览识别不正确时修改。关键字段未知时不会放行。" />
                <a-form-item :label="jsonMode ? '候选数组路径' : '种子行选择器'" :name="['mapping', 'rows']" :rules="[{ required: true, message: '请填写候选行规则' }]"><a-input size="small" v-model:value="config.mapping.rows" :disabled="busy" /></a-form-item>
                <a-form-item v-if="!jsonMode" label="登录成功特征" :name="['mapping', 'authenticated']" extra="使用 CSS 选择器验证当前页面已登录。"><a-input size="small" v-model:value="config.mapping.authenticated" :disabled="busy" /></a-form-item>
                <a-form-item label="时区偏移（分钟）" :name="['mapping', 'timezoneOffset']" :rules="numberRules(-720, 840, true)" extra="仅用于无时区时间。例如 UTC+8 为 480。"><a-input-number size="small" v-model:value="config.mapping.timezoneOffset" :min="-720" :max="840" :precision="0" :disabled="busy" /></a-form-item>
                <h3 class="provider-subtitle">字段映射</h3><p class="provider-secondary">{{ jsonMode ? '使用相对候选对象的 JSON 路径。' : '选择器相对当前种子行；表头特征为可选的备用 CSS 选择器。' }}</p>
                <a-table class="provider-mapping-table" :columns="mappingColumns" :data-source="fieldRows" row-key="key" size="small" :pagination="false" :scroll="{ x: jsonMode ? 480 : 840 }">
                  <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'field'">{{ fieldLabels[record.key] || record.key }}</template>
                    <template v-else-if="column.key === 'selector'"><a-input size="small" :aria-label="fieldLabels[record.key] + (jsonMode ? ' JSON 路径' : ' CSS 选择器')" v-model:value="record.value[jsonMode ? 'path' : 'selector']" :disabled="busy" /></template>
                    <template v-else-if="column.key === 'header'"><a-input size="small" :aria-label="fieldLabels[record.key] + ' 表头特征'" v-model:value="record.value.header" :disabled="busy" /></template>
                    <template v-else-if="column.key === 'attribute'"><a-select size="small" :aria-label="fieldLabels[record.key] + ' 读取属性'" v-model:value="record.value.attribute" :disabled="busy" :options="attributeOptions" /></template>
                    <template v-else-if="column.key === 'query'"><a-input v-if="record.key === 'id'" size="small" aria-label="种子 ID 查询参数" v-model:value="record.value.query" :disabled="busy" /><span v-else class="provider-secondary">—</span></template>
                  </template>
                </a-table>
                <h3 class="provider-subtitle">促销标记</h3><p class="provider-secondary">下载倍率 0 表示免费，上传倍率 2 表示双倍；留空表示未知。矛盾标记会阻断候选。</p>
                <div v-for="(r, i) in config.promotionRules" :key="i" class="provider-marker">
                  <div class="provider-marker-heading"><span>促销 {{ i + 1 }}</span><a-button type="link" danger size="small" :aria-label="'移除促销 ' + (i + 1)" :disabled="busy" @click="config.promotionRules.splice(i, 1)">移除</a-button></div>
                  <div class="provider-marker-fields">
                    <div class="provider-marker-selector"><label :for="'promotion-selector-' + i">{{ jsonMode ? 'JSON 路径' : 'CSS 选择器' }}</label><a-input :id="'promotion-selector-' + i" size="small" v-model:value="r[jsonMode ? 'path' : 'selector']" :disabled="busy" /></div>
                    <div v-if="jsonMode"><label :for="'promotion-value-' + i">匹配值</label><a-input :id="'promotion-value-' + i" size="small" :value="enumText(r.equals)" :disabled="busy" @update:value="setEnum(r, $event)" /></div>
                    <div><label :for="'promotion-download-' + i">下载倍率</label><a-input-number :id="'promotion-download-' + i" size="small" v-model:value="r.downloadFactor" :min="0" :max="100" placeholder="未知" :disabled="busy" /></div>
                    <div><label :for="'promotion-upload-' + i">上传倍率</label><a-input-number :id="'promotion-upload-' + i" size="small" v-model:value="r.uploadFactor" :min="0" :max="100" placeholder="未知" :disabled="busy" /></div>
                  </div>
                </div>
                <a-button size="small" :disabled="busy || config.promotionRules.length >= 40" @click="addPromotion">新增促销标记</a-button>
                <h3 class="provider-subtitle">H&R 明确信号</h3><p class="provider-secondary">仅识别入场要求，不作为已完成保种的证明。默认没有匹配标记时保留“未知”。</p>
                <p v-if="!config.hrRules.length" class="provider-secondary">尚未配置明确信号。</p>
                <div v-for="(r, i) in config.hrRules" :key="i" class="provider-marker">
                  <div class="provider-marker-heading"><span>H&R {{ i + 1 }}</span><a-button type="link" danger size="small" :aria-label="'移除 H&R ' + (i + 1)" :disabled="busy" @click="config.hrRules.splice(i, 1)">移除</a-button></div>
                  <div class="provider-marker-fields">
                    <div class="provider-marker-selector"><label :for="'hr-selector-' + i">{{ jsonMode ? 'JSON 路径' : 'CSS 选择器' }}</label><a-input :id="'hr-selector-' + i" size="small" v-model:value="r[jsonMode ? 'path' : 'selector']" :disabled="busy" /></div>
                    <div v-if="jsonMode"><label :for="'hr-value-' + i">匹配值</label><a-input :id="'hr-value-' + i" size="small" :value="enumText(r.equals)" :disabled="busy" @update:value="setEnum(r, $event)" /></div>
                    <div v-else><label :for="'hr-text-' + i">标记文字（可选）</label><a-input :id="'hr-text-' + i" size="small" :value="r.text || ''" :disabled="busy" @update:value="setHrText(r, $event)" placeholder="留空只检查选择器" /></div>
                    <div><label :for="'hr-state-' + i">识别结果</label><a-select :id="'hr-state-' + i" size="small" v-model:value="r.state" :disabled="busy" :options="[{value:'required', label:'明确有 H&R'}, {value:'exempt', label:'明确免 H&R'}]" /></div>
                  </div>
                </div>
                <a-button size="small" :disabled="busy || config.hrRules.length >= 12" @click="addHr">新增 H&R 标记</a-button>
                <h3 class="provider-subtitle">个人下载／做种状态</h3>
                <p class="provider-secondary">仅明确“正在下载／做种”时本轮提前跳过。不活跃、历史完成、缺标记或冲突仍走本地去重；不会永久拒绝，也不作为 H&R 达标证明。</p>
                <p v-if="jsonMode" class="provider-secondary">MT 使用批量个人状态查询，最多每批 200 个；单独使用个人状态预算，不占用列表或详情预算。查询失败回退本地去重。</p>
                <p v-if="!config.personalStateRules?.length" class="provider-secondary">未配置个人状态规则，使用本地去重。</p>
                <div v-for="(r, i) in config.personalStateRules || []" :key="i" class="provider-marker">
                  <div class="provider-marker-heading"><span>个人状态 {{ i + 1 }}</span><a-button type="link" danger size="small" :aria-label="'移除个人状态 ' + (i + 1)" :disabled="busy" @click="config.personalStateRules.splice(i, 1)">移除</a-button></div>
                  <div class="provider-marker-fields">
                    <div class="provider-marker-selector"><label :for="'personal-selector-' + i">{{ jsonMode ? 'JSON 路径' : '行内 CSS 选择器' }}</label><a-input :id="'personal-selector-' + i" size="small" v-model:value="r[jsonMode ? 'path' : 'selector']" :disabled="busy" /></div>
                    <div v-if="jsonMode"><label :for="'personal-value-' + i">匹配值</label><a-input :id="'personal-value-' + i" size="small" :value="enumText(r.equals)" :disabled="busy" @update:value="setEnum(r, $event)" /></div>
                    <div><label :for="'personal-state-' + i">识别方式／结果</label><a-select :id="'personal-state-' + i" size="small" :value="r.format || r.state" :disabled="busy" :options="personalOptions" @update:value="setPersonalState(r, $event)" /></div>
                  </div>
                </div>
                <a-button size="small" :disabled="busy || (config.personalStateRules || []).length >= 12" @click="addPersonal">新增个人状态规则</a-button>
                <a-form-item v-if="jsonMode" label="个人状态批量预算" extra="每小时请求次数；一批最多 200 个，不是新增下载数量限制。留空则不查询。"><a-input-number size="small" :value="config.budgets.personalPerHour" :min="1" :max="selectedProfile.budgetCaps.personalPerHour" :precision="0" :disabled="busy" @update:value="setPersonalBudget" /></a-form-item>
                <template v-if="!jsonMode">
                  <a-form-item label="按站规识别无标签种子" extra="仅适用于已确认“有 H&R 必显示标签”的站点。有 H&R 标记或证据冲突时不放行；页面/种子行未闭合、结构或关键字段缺失时仍为未知。不代表站内 H&R 已达标。"><a-switch size="small" :checked="!!config.hrAbsence" :disabled="busy" @change="setHrAbsence" /></a-form-item>
                  <a-form-item v-if="config.hrAbsence" label="种子行完整性选择器" extra="每行一个，全部必须在当前种子行内匹配；最多 8 个。"><a-textarea size="small" :value="config.hrAbsence.rowSelectors.join('\n')" :disabled="busy" :auto-size="{minRows:2,maxRows:8}" @update:value="config.hrAbsence.rowSelectors = $event.split('\n')" /></a-form-item>
                </template>
              </a-tab-pane>
              <a-tab-pane key="preview" tab="预览结果">
                <p>请求一页预览会消耗共享列表预算；不下载 .torrent、不调用下载器。HTML 暂不自动请求详情补齐。</p>
                <a-button :loading="operation === 'preview'" :disabled="busy" @click="preview">{{ previewResult ? '重新预览' : '请求一页预览' }}</a-button>
                <template v-if="previewResult">
                  <div class="provider-preview-summary" aria-live="polite"><a-tag>返回 {{ previewResult.candidates.length }} 条</a-tag><a-tag color="success">来源筛选通过 {{ previewResult.eligible }} 条</a-tag><span class="provider-secondary">{{ previewValid ? '本次预览有效至 ' + timestamp(previewResult.expiresAt) : '预览已过期，请重新请求' }}</span></div>
                  <a-table :columns="candidateColumns" :data-source="previewResult.candidates" row-key="candidateKey" :scroll="{ x: 1235 }" :pagination="{ pageSize: 10, showSizeChanger: false }" size="small">
                    <template #bodyCell="{column, record}">
                      <template v-if="column.key === 'size'">{{ record.size == null ? '未知' : (record.size / 1024 ** 3).toFixed(2) + ' GiB' }}</template>
                      <template v-else-if="column.key === 'seeders'">{{ record.seeders ?? '未知' }}</template>
                      <template v-else-if="column.key === 'leechers'">{{ record.leechers ?? '未知' }}</template>
                      <template v-else-if="column.key === 'promotion'">下载 {{ factor(record.downloadFactor) }}<br>上传 {{ factor(record.uploadFactor) }}</template>
                      <template v-else-if="column.key === 'hr'">{{ {required:'有 H&R', exempt:'无 H&R 要求', unknown:'未知'}[record.hrState] || '未知' }}</template>
                      <template v-else-if="column.key === 'personal'">{{ {seeding:'正在做种', downloading:'正在下载', inactive:'不活跃／历史', unknown:'未知（本地核对）'}[record.personalState] || '未知（本地核对）' }}</template>
                      <template v-else-if="column.key === 'reason'"><a-tag v-if="!record.reasons.length" color="success">通过来源筛选</a-tag><span v-else>{{ record.reasons.map(reason).join('；') }}</span></template>
                    </template>
                  </a-table>
                </template>
                <p v-else class="provider-secondary provider-help">尚无当前配置的预览结果。修改配置后需要重新预览。</p>
              </a-tab-pane>
            </a-tabs>
            <a-divider />
            <a-form-item :wrapper-col="actionCol" class="provider-footer">
              <div class="provider-actions">
                <a-button :type="!previewValid && !alreadyActive ? 'primary' : 'default'" :loading="operation === 'preview'" :disabled="busy" @click="preview">预览</a-button>
                <a-popconfirm title="保存当前配置并生效？后续采集使用此配置，已有任务不变。" ok-text="确认保存" cancel-text="取消" @confirm="apply"><a-button :type="canApply ? 'primary' : 'default'" :loading="operation === 'apply'" :disabled="!canApply" aria-describedby="provider-apply-help">保存并生效</a-button></a-popconfirm>
                <a-button :loading="operation === 'validate'" :disabled="busy" @click="validate">校验配置</a-button>
                <a-popconfirm v-if="selectedRecord?.active !== null && selectedRecord?.active !== undefined && !selectedRecord.suspended" title="只停止新候选采集，不暂停 qB，也不恢复旧 RSS。" ok-text="停止采集" cancel-text="取消" @confirm="suspend"><a-button danger :loading="operation === 'suspend'" :disabled="busy || dirty || revisionConflict || applyUncertain">停止采集</a-button></a-popconfirm>
              </div>
              <p id="provider-apply-help" class="provider-secondary provider-help">{{ applyHint }}</p>
              <p v-if="notice" class="provider-notice" role="status" aria-live="polite">{{ notice }}</p>
            </a-form-item>
          </a-form>
        </template>
        <a-alert v-if="!config && error" type="error" show-icon :message="error" class="provider-message" role="alert" />
      </section>
    </div>
  </section>
</template>

<script>
import { Modal } from 'ant-design-vue';
import api from '../../api/provider';
const clone = x => JSON.parse(JSON.stringify(x));
const errors = {
  PROVIDER_PREVIEW_REQUIRED: '预览已失效，请重新预览当前配置后再保存。',
  PROVIDER_REVISION_CONFLICT: '配置已被其他操作修改。当前输入已保留，请刷新列表并重新载入。',
  PROVIDER_COMMIT_UNCERTAIN: '配置写入结果尚未完全确认，请刷新核对。当前输入已保留，不会自动重试保存。',
  PROVIDER_GOVERNANCE_MIGRATION_REQUIRED: '旧采集策略尚未完成迁移验收，暂不能启用新来源。',
  PROVIDER_DRIVER_REQUIRED: 'MT 驱动尚未就绪，暂不能预览或启用。',
  PROVIDER_AUTH: '登录验证失败，请检查认证有效期及登录特征规则。',
  PROVIDER_EMPTY_OR_CHANGED: '未解析出候选，请检查页面结构与选择器；不能据此判断站点没有种子。',
  PROVIDER_BUDGET_EXHAUSTED: '本小时共享请求预算已用完，请稍后重试。',
  PROVIDER_BUSY: '该站已有请求或采集服务正忙，请稍后重试。',
  PROVIDER_RSS_INCOMPATIBLE_OR_BUSY: '原 RSS 任务正忙或配置不兼容，请检查下载器、暂停添加及自动辅种设置。',
  PROVIDER_CREDENTIAL_ORIGIN: '认证来源与站点不匹配，已阻止发送凭据。',
  PROVIDER_HHAN_PROOF_MIGRATION_REQUIRED: '憨憨的 H&R 与免费到期保护尚未完成迁移验收，暂不能启用。',
  PROVIDER_LEGACY_REFRESH_BUSY: '旧采集仍在运行，请等待本轮结束后重试。',
  PROVIDER_SELECTOR_INVALID: 'CSS 选择器语法不正确，请检查“解析规则”。',
  PROVIDER_HTTP: '站点请求失败，已保留当前配置，请稍后重试。',
  PROVIDER_TIMEOUT_DNS: '解析站点域名超时；尚未获取页面。',
  PROVIDER_TIMEOUT_TCP: '连接站点超时；尚未获取页面。',
  PROVIDER_TIMEOUT_TLS: '站点 TLS 握手超时；尚未获取页面。',
  PROVIDER_TIMEOUT_HEADERS: '等待站点响应超时；尚未收到完整响应头。',
  PROVIDER_TIMEOUT_BODY: '页面传输超时；已拒绝使用不完整页面。',
  PROVIDER_CYCLE_DEADLINE: '本轮列表采集已达到总时长上限，未使用部分结果。',
  PROVIDER_TIMEOUT_CONFIG: '超时配置无效：单页总时长须覆盖连接和读取，整轮须覆盖单页。',
  PROVIDER_POLL_LIMIT: '轮询间隔或页数超出允许范围，请检查“基础设置”。',
  PROVIDER_THRESHOLD: '筛选阈值无效，请检查体积范围、人数与种龄。',
  PROVIDER_BUDGET: '请求预算超出站点模板允许范围。',
  PROVIDER_MARKER: '促销、H&R 或个人状态标记不能为空，请检查“解析规则”。',
  PROVIDER_PERSONAL_RULES: '个人状态规则无效，请检查“解析规则”的识别方式与选择器。'
};
export default {
  data () {
    return {
      data: { profiles: [], records: [], rss: [], credentials: [] }, createForm: { rssId: undefined, profile: undefined },
      config: null, operation: '', listError: '', error: '', notice: '', tab: 'source', showParams: false, discardPromise: null, savedJson: '', expectedRevision: 0, applyUncertain: false, previewResult: null, previewJson: '', viewportWidth: window.innerWidth, now: Date.now(), clockTimer: null,
      sourceColumns: [{ title: '任务 / 站点', key: 'source', width: 230 }, { title: '运行状态', key: 'state', width: 190 }, { title: '最近列表成功', key: 'time', width: 260 }, { title: '操作', key: 'actions', width: 80 }],
      candidateColumns: [{ title: '候选', dataIndex: 'name', ellipsis: true, width: 270 }, { title: '体积（展示值）', key: 'size', width: 145 }, { title: '做种', key: 'seeders', width: 70 }, { title: '下载', key: 'leechers', width: 70 }, { title: '促销识别', key: 'promotion', width: 140 }, { title: 'H&R', key: 'hr', width: 110 }, { title: '个人状态', key: 'personal', width: 170 }, { title: '来源筛选原因', key: 'reason', width: 260 }],
      budgetLabels: { listPerHour: '列表请求预算', detailPerHour: '详情请求预算' },
      timeoutFields: {
        connectSeconds: { label: '连接上限（秒）', max: 30, help: '包含域名解析、TCP 连接及 TLS 握手。' },
        readSeconds: { label: '读取空闲（秒）', max: 60, help: '连接建立后等待响应及相邻数据之间的最长等待，不是整页耗时。' },
        requestSeconds: { label: '单页总时长（秒）', max: 120, help: '从域名解析到完整页面的总时长上限，持续慢速传输也不能无限等待。' },
        cycleSeconds: { label: '整轮总时长（秒）', max: 180, help: '所有页面共用；后续页面只使用剩余时长。超时不回退 RSS。' }
      },
      selectionLabels: { minGiB: '最小体积（GiB）', maxGiB: '最大体积（GiB）', minSeeders: '最少做种人数', minLeechers: '最少下载人数', maxAgeHours: '最大种龄（小时）', minFreeSeconds: '免费剩余时间（秒）' },
      fieldLabels: { id: '种子 ID', title: '标题', size: '体积', seeders: '做种人数', leechers: '下载人数', publishedAt: '发布时间', detail: '详情链接', download: '下载链接', downloadUntil: '下载优惠截止', uploadUntil: '上传优惠截止', downloadUnlimited: '长期下载优惠', uploadUnlimited: '长期上传优惠' },
      attributeOptions: ['', 'href', 'title', 'datetime', 'data-timestamp', 'value'].map(value => ({ value, label: value || '文本' }))
    };
  },
  computed: {
    busy () { return !!this.operation; },
    mobile () { return this.viewportWidth < 768; },
    formClass () { return this.mobile ? 'container-form-mobile' : 'container-form-pc'; },
    labelCol () { return this.mobile ? { span: 24 } : { span: 3 }; },
    wrapperCol () { return this.mobile ? { span: 24 } : { span: 21 }; },
    actionCol () { return this.mobile ? { span: 24 } : { span: 21, offset: 3 }; },
    dirty () { return !!this.config && JSON.stringify(this.config) !== this.savedJson; },
    selectedRecord () { return this.config && this.data.records.find(r => r.id === this.config.rssId); },
    selectedProfile () { return this.data.profiles.find(p => p.id === this.config?.profile) || { queryKeys: [], budgetCaps: {} }; },
    jsonMode () { return this.selectedProfile.adapter === 'mteam-api'; },
    personalOptions () { return [...(this.jsonMode ? [] : [{ value: 'nexus-progress', label: 'Nexus 标准 title 状态＋进度' }]), { value: 'seeding', label: '正在做种' }, { value: 'downloading', label: '正在下载' }, { value: 'inactive', label: '不活跃／历史' }]; },
    availableRss () { return this.data.rss.filter(r => !this.data.records.some(record => record.id === r.id)); },
    fieldRows () { return Object.entries(this.config.mapping.fields).map(([key, value]) => ({ key, value })); },
    mappingColumns () { return [{ title: '字段', key: 'field', width: 145 }, { title: this.jsonMode ? 'JSON 路径' : '行内 CSS 选择器', key: 'selector', width: 290 }, ...(this.jsonMode ? [] : [{ title: '备用表头特征', key: 'header', width: 190 }, { title: '读取属性', key: 'attribute', width: 120 }, { title: 'ID 查询参数', key: 'query', width: 100 }])]; },
    credentialOptions () { return [...(this.jsonMode ? [] : [{ value: 'rss:' + this.config.rssId, label: '关联 RSS 的 Cookie' }]), { value: 'driver', label: '已有私有驱动' }, ...this.data.credentials.map(r => ({ value: r.ref, label: '站点认证 · ' + r.label }))]; },
    revisionConflict () { return !!this.selectedRecord && this.expectedRevision !== this.selectedRecord.revision; },
    previewValid () { return !!this.previewResult && this.previewResult.expiresAt > this.now && this.previewJson === JSON.stringify(this.config); },
    alreadyActive () { return !!this.selectedRecord && !this.selectedRecord.suspended && this.selectedRecord.active !== null && JSON.stringify(this.editableConfig(this.selectedRecord)) === JSON.stringify(this.config); },
    driverMissing () { return this.jsonMode && !this.data.rss.find(r => r.id === this.config?.rssId)?.driverRegistered; },
    canApply () { return !this.busy && this.previewValid && !this.alreadyActive && !this.revisionConflict && !this.driverMissing && !this.applyUncertain; },
    applyHint () {
      if (this.applyUncertain) return '上次保存结果未确认，请先刷新核对，不会自动重复保存。';
      if (this.revisionConflict) return '配置已被其他操作修改，请重新载入后编辑。';
      if (this.alreadyActive) return '当前配置已生效，无需重复保存。';
      if (this.driverMissing) return 'MT 驱动尚未就绪，暂不能保存并生效。';
      if (!this.previewValid) return this.previewResult ? '预览已过期，请重新预览后保存。' : '请先预览并核对识别结果，再保存并生效。';
      return '预览已就绪。保存后仍须通过原生准入与保护检查，不保证新增下载。';
    }
  },
  watch: { config: { deep: true, handler () { if (this.previewResult && this.previewJson !== JSON.stringify(this.config)) { this.previewResult = null; this.previewJson = ''; } } } },
  methods: {
    explain (code) { return errors[code] || (/^PROVIDER_/.test(code || '') ? '配置或采集校验失败（' + code + '），请核对当前设置。' : '操作失败，请检查服务连接后重试。当前输入已保留。'); },
    reason (key) { return ({ 'personal-active': '站内当前账号正在下载／做种', 'conflicting-evidence': '证据冲突', stale: '数据过期', 'missing-fields': '关键字段未知', size: '体积范围', 'supply-demand': '供需不达标', age: '种龄/时间异常', 'hr-not-exempt': '未明确免 H&R', 'not-confirmed-free': '未确认免费', 'free-expiry-unverified': '免费期限未知或不足' })[key] || key; },
    factor (v) { return v == null ? '未知' : v + '×'; },
    timestamp (v) { return v ? this.$moment(v).format('YYYY-MM-DD HH:mm:ss') : '暂无记录'; },
    rssName (id) { return this.data.rss.find(r => r.id === id)?.alias || id; },
    rssDisabled (id) { return this.data.rss.find(r => r.id === id)?.enable === false; },
    profileName (id) { return this.data.profiles.find(p => p.id === id)?.label || id; },
    editableConfig (record) { return (record.revisions.find(r => r.revision === record.active) || record.revisions[record.revisions.length - 1])?.config; },
    runtimeLabel (record) { return record.suspended ? '已停用' : record.active === null ? '未生效' : '已生效'; },
    parameterLabel (key) { return ({ mode: '分类分区', categories: '分类 ID', cat: '分类 ID', sort: '站内排序', type: '列表类型', incldead: '存活状态', inclbookmarked: '收藏范围', spstate: '促销状态' })[key] || '参数 ' + key; },
    budgetHelp (key) { return key === 'detailPerHour' && !this.jsonMode ? 'HTML 自动详情补齐尚未实现，此项仅保留配置，不参与请求。' : '单位：次/小时。模板上限 ' + this.selectedProfile.budgetCaps[key] + '，仍受原驱动更严格的预算约束。'; },
    numberRules (min, max, integer = false) { return [{ required: true, type: integer ? 'integer' : 'number', min, max, message: '请输入 ' + min + '–' + max + (integer ? ' 之间的整数' : ' 之间的数值') }]; },
    setTimeouts (enabled) { if (enabled) this.config.listTimeouts = { connectSeconds: 15, readSeconds: 30, requestSeconds: 60, cycleSeconds: 120 }; else delete this.config.listTimeouts; },
    timeoutRules (key) {
      return [...this.numberRules(1, this.timeoutFields[key].max, true), { validator: () => {
        const t = this.config.listTimeouts;
        return t && t.requestSeconds >= Math.max(t.connectSeconds, t.readSeconds) && t.cycleSeconds >= t.requestSeconds ? Promise.resolve() : Promise.reject(new Error('单页须覆盖连接和读取，整轮须覆盖单页'));
      } }];
    },
    selectionRules (key) {
      const rules = this.numberRules(0, 100000, ['minSeeders', 'minLeechers'].includes(key));
      if (key === 'maxGiB') rules.push({ validator: (_, v) => v > this.config.selection.minGiB ? Promise.resolve() : Promise.reject(new Error('最大体积必须大于最小体积')) });
      if (key === 'maxAgeHours') rules.push({ validator: (_, v) => v > 0 ? Promise.resolve() : Promise.reject(new Error('最大种龄必须大于 0')) });
      return rules;
    },
    enumText (v) { return typeof v === 'string' ? v : JSON.stringify(v); },
    setEnum (rule, text) { rule.equals = typeof rule.equals === 'boolean' && /^(true|false)$/.test(text) ? text === 'true' : typeof rule.equals === 'number' && text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : text; },
    parameter (key, value) { if (value === '') delete this.config.params[key]; else this.config.params[key] = value; },
    async run (action, fn) {
      if (this.busy) return;
      this.operation = action; this.error = ''; this.notice = '';
      try { await fn(); } catch (e) {
        if (e.errorFields?.length) {
          const field = e.errorFields[0].name;
          this.tab = ['mapping', 'promotionRules', 'hrRules', 'hrAbsence', 'personalStateRules'].includes(field[0]) ? 'mapping' : field[0] === 'selection' ? 'selection' : 'source';
          await this.$nextTick(); this.$refs.configForm?.scrollToField(field, { block: 'center' }); this.error = '请先修正表单中标出的字段。';
        } else if (action === 'refresh') this.listError = this.explain(e.message);
        else this.error = this.explain(e.message);
      } finally { this.operation = ''; }
    },
    syncApplied () {
      if (!this.alreadyActive) return false;
      this.savedJson = JSON.stringify(this.config); this.expectedRevision = this.selectedRecord.revision; this.applyUncertain = false;
      return true;
    },
    async refresh () { await this.run('refresh', async () => { this.data = await api.call('list'); this.listError = ''; if (this.applyUncertain) { if (this.syncApplied()) this.notice = '已核对：当前配置已生效。'; else { this.applyUncertain = false; this.previewResult = null; this.previewJson = ''; this.notice = '已刷新生效状态，当前输入仍保留；请核对后重新预览。'; } } }); },
    confirmDiscard () {
      if (!this.dirty) return Promise.resolve(true);
      if (this.discardPromise) return this.discardPromise;
      this.discardPromise = new Promise(resolve => Modal.confirm({ title: '放弃未保存的修改？', content: '离开当前编辑内容后，这些修改将丢失。正在使用的配置不受影响。', okText: '放弃修改', cancelText: '继续编辑', okButtonProps: { danger: true }, onOk: () => { this.discardPromise = null; resolve(true); }, onCancel: () => { this.discardPromise = null; resolve(false); } }));
      return this.discardPromise;
    },
    async focusEditor () {
      await this.$nextTick();
      const editor = this.$refs.editor; const content = editor?.closest('.ant-layout-content');
      if (content) content.scrollTop += editor.getBoundingClientRect().top - content.getBoundingClientRect().top - 16;
      const list = this.$el.querySelector('.provider-list .ant-table-content');
      if (list) list.scrollLeft = 0;
      editor?.focus({ preventScroll: true });
    },
    async newConfig () { if (this.busy || !await this.confirmDiscard()) return; this.config = null; this.savedJson = ''; this.applyUncertain = false; this.previewResult = null; this.previewJson = ''; this.notice = ''; this.error = ''; this.createForm = { rssId: undefined, profile: undefined }; await this.focusEditor(); },
    async edit (record) { if (this.busy || !await this.confirmDiscard()) return; this.setConfig(record); await this.focusEditor(); },
    setConfig (record) {
      this.config = clone(this.editableConfig(record)); this.savedJson = JSON.stringify(this.config); this.expectedRevision = record.revision; this.applyUncertain = false;
      this.previewResult = null; this.previewJson = ''; this.error = ''; this.notice = ''; this.tab = 'source'; this.$nextTick(() => this.$refs.configForm?.clearValidate());
    },
    async create () { await this.run('create', async () => { this.config = await api.call('defaults?profile=' + encodeURIComponent(this.createForm.profile) + '&rssId=' + encodeURIComponent(this.createForm.rssId)); this.savedJson = ''; this.expectedRevision = 0; this.applyUncertain = false; this.tab = 'source'; this.previewResult = null; this.previewJson = ''; this.notice = '模板已载入，请核对实际阈值与解析结果。'; await this.focusEditor(); }); },
    addPromotion () { this.config.promotionRules.push({ ...(this.jsonMode ? { path: '', equals: '' } : { selector: '' }), downloadFactor: null, uploadFactor: null }); },
    addHr () { this.config.hrRules.push({ ...(this.jsonMode ? { path: '', equals: '' } : { selector: '' }), state: 'required' }); },
    addPersonal () { if (!this.config.personalStateRules) this.config.personalStateRules = []; this.config.personalStateRules.push(this.jsonMode ? { path: '_vertex.personalState', equals: 'seeding', state: 'seeding' } : { selector: '[title]', format: 'nexus-progress' }); },
    setPersonalState (r, value) { if (value === 'nexus-progress') { r.format = value; delete r.state; } else { r.state = value; delete r.format; } },
    setPersonalBudget (value) { if (value == null) delete this.config.budgets.personalPerHour; else this.config.budgets.personalPerHour = value; },
    setHrText (rule, text) { if (text.trim()) rule.text = text; else delete rule.text; },
    setHrAbsence (enabled) { if (enabled) this.config.hrAbsence = { rowSelectors: [''] }; else delete this.config.hrAbsence; },
    async validateForm () { await this.$refs.configForm.validateFields(); },
    updateRecord (record) { const index = this.data.records.findIndex(r => r.id === record.id); if (index < 0) this.data.records.push(record); else this.data.records.splice(index, 1, { ...this.data.records[index], ...record }); },
    async validate () { await this.run('validate', async () => { await this.validateForm(); await api.call('validate', { config: this.config }); this.notice = '结构与选择器校验通过，尚未验证站点响应。'; this.$message().success('配置校验通过'); }); },
    async preview () { await this.run('preview', async () => { this.previewResult = null; this.previewJson = ''; await this.validateForm(); this.tab = 'preview'; const result = await api.call('preview', { config: this.config }); this.previewJson = JSON.stringify(this.config); this.previewResult = result; this.now = Date.now(); this.notice = '预览完成，未提交下载。'; }); },
    async apply () {
      if (!this.canApply) return;
      await this.run('apply', async () => {
        await this.validateForm();
        try {
          const r = await api.call('apply', { config: this.config, expectedRevision: this.expectedRevision, token: this.previewResult.token });
          this.updateRecord(r); this.syncApplied(); this.notice = '配置已保存并生效，等待原 RSS 调度；不代表已新增下载。'; this.$message().success('配置已保存并生效');
        } catch (e) {
          // A dropped response may hide a committed write. Never automatically
          // resubmit, nor claim that every transport error kept the old config.
          this.applyUncertain = !/^PROVIDER_/.test(e.message) || ['PROVIDER_UNAVAILABLE', 'PROVIDER_COMMIT_UNCERTAIN'].includes(e.message);
          try { this.data = await api.call('list'); } catch (_) { /* Keep input and uncertainty when readback also fails. */ }
          if (this.syncApplied()) {
            this.notice = '已核对：这份配置已生效，但上次保存响应未正常完成。';
            if (e.message === 'PROVIDER_COMMIT_UNCERTAIN') this.error = this.explain(e.message);
            return;
          }
          if (e.message === 'PROVIDER_PREVIEW_REQUIRED') { this.previewResult = null; this.previewJson = ''; }
          throw e;
        }
      });
    },
    async suspend () { await this.run('suspend', async () => { const r = await api.call('suspend', { id: this.config.rssId, expectedRevision: this.expectedRevision }); this.updateRecord(r); this.expectedRevision = r.revision; this.previewResult = null; this.previewJson = ''; this.notice = '已停止新采集；现有下载、做种和回收继续，也不会恢复旧 RSS。'; this.$message().success('已停止新采集'); }); },
    onResize () { this.viewportWidth = window.innerWidth; },
    onBeforeUnload (event) { if (this.dirty || this.busy) { event.preventDefault(); event.returnValue = ''; } }
  },
  async beforeRouteLeave () { if (this.busy) { this.$message().warning('请等待当前操作完成'); return false; } return this.confirmDiscard(); },
  mounted () { this.refresh(); window.addEventListener('resize', this.onResize); window.addEventListener('beforeunload', this.onBeforeUnload); this.clockTimer = window.setInterval(() => { this.now = Date.now(); }, 1000); },
  beforeUnmount () { window.removeEventListener('resize', this.onResize); window.removeEventListener('beforeunload', this.onBeforeUnload); window.clearInterval(this.clockTimer); }
};
</script>

<style scoped>
.provider-title { font-size: 24px; font-weight: bold; line-height: inherit; color: inherit; margin: 0; }
.provider-container { width: 100%; max-width: 1440px; margin: 0 auto; text-align: left; }
.provider-section-title { font-size: 16px; font-weight: bold; line-height: inherit; margin: 0; }
.provider-table-title, .provider-editor-heading, .provider-marker-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.provider-editor-heading { padding-left: 8px; }
.provider-editor { scroll-margin-top: 16px; }
.provider-editor:focus { outline: none; }
.provider-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px 12px 0; }
.provider-summary .ant-tag { margin: 0; }
.provider-secondary { color: inherit; opacity: .75; }
.provider-block { display: block; margin-top: 4px; }
.provider-list-note { margin: 8px 8px 0; font-size: 12px; }
.provider-editor-note { margin: 8px 12px 0; }
.provider-message { margin: 12px 0 20px; }
.provider-tabs :deep(.ant-tabs-tabpane) { padding-top: 8px; }
.provider-form :deep(.ant-input-number), .provider-mapping-table :deep(.ant-select), .provider-marker :deep(.ant-select) { width: 100%; }
.provider-mapping-table { margin-bottom: 20px; }
.provider-subtitle { font-size: 14px; font-weight: bold; margin: 24px 0 8px; }
.provider-marker { padding-bottom: 12px; margin-bottom: 12px; border-bottom: 1px solid rgba(128, 128, 128, .2); }
.provider-marker-fields { display: flex; flex-wrap: wrap; gap: 12px; }
.provider-marker-fields > div { flex: 1 1 120px; min-width: 0; }
.provider-marker-fields > .provider-marker-selector { flex: 2 1 300px; }
.provider-marker-fields label { display: block; margin-bottom: 4px; }
.provider-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 8px; }
.provider-help { margin: 8px 0 0; line-height: 1.6; }
.provider-notice { margin: 8px 0 0; }
.provider-footer { margin-bottom: 32px; }
.provider-preview-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.provider-status-error { margin-top: 4px; overflow-wrap: anywhere; }
.provider-form :deep(.ant-form-item-label) { overflow-wrap: anywhere; }
.provider-page :deep(button:focus-visible), .provider-page :deep(input:focus-visible) { outline: 2px solid currentColor; outline-offset: 2px; }
@media (max-width: 767px) {
  .provider-list { font-size: 12px; }
  .provider-form :deep(.ant-form-item-label) { text-align: left; padding-bottom: 6px; }
  .provider-table-title { flex-wrap: wrap; }
  .provider-marker-fields > div, .provider-marker-fields > .provider-marker-selector { flex-basis: 100%; }
  .provider-form :deep(.ant-input), .provider-form :deep(.ant-input-number-input) { min-height: 36px; font-size: 16px; }
  .provider-form :deep(.ant-select-selector) { min-height: 38px; align-items: center; }
  .provider-page :deep(.ant-btn) { min-height: 44px; }
  .provider-page :deep(.ant-tabs-tab) { min-height: 44px; }
  .provider-actions { gap: 8px; }
}
@media (prefers-reduced-motion: reduce) { .provider-form { transition: none; } }
</style>
