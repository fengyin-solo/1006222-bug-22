<template>
  <section class="page" data-module="transformer">
    <header class="page-head">
      <div>
        <h2>主变压器管理</h2>
        <p class="page-desc">围绕变压器编号、容量等级、油温、绕组温度做登记、筛选与状态流转；告警复位时温度标记、告警台数与缺陷清单一起回到正常口径。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="downloadTemplate">下载导入模板</button>
        <button class="btn" type="button" @click="triggerImport">{{ resumeHint ? `继续导入（已导 ${resumeHint.processedRows}/${resumeHint.totalRows} 行）` : '导入台账明细' }}</button>
        <input ref="fileInput" type="file" accept=".csv,text/csv" class="hidden-file" @change="onFilePicked" />
        <button class="btn primary" type="button" @click="exportRows">导出主变压器清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ danger: item.danger }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">发布过告警（含已复位）：{{ stats.everAlarmed }} 台</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>变压器编号</th>
          <th>容量等级</th>
          <th>油温</th>
          <th>绕组温度</th>
          <th>油位</th>
          <th>瓦斯保护</th>
          <th>试验日期</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td><button class="link" type="button" @click="openDetail(row)">{{ row.变压器编号 }}</button></td>
          <td>{{ row.容量等级 }}</td>
          <td :class="{ 'over-limit': row.油温越限 === true }">
            {{ row.油温 }}℃<span v-if="row.油温越限 === true" class="mark">越限</span>
          </td>
          <td :class="{ 'over-limit': row.绕组温度越限 === true }">
            {{ row.绕组温度 }}℃<span v-if="row.绕组温度越限 === true" class="mark">越限</span>
          </td>
          <td>{{ row.油位 ?? '—' }}</td>
          <td>{{ row.瓦斯保护 ?? '—' }}</td>
          <td>{{ row.试验日期 ?? '—' }}</td>
          <td><span class="status-badge" :data-status="row.status">{{ row.status }}</span></td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="9" class="empty-state">暂无主变压器数据，可先导入台账明细</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条主变压器记录</span>
      <span v-if="notice" class="notice-text">{{ notice }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="detail-drawer">
        <header class="drawer-head">
          <h3>主变压器详情 · {{ detail.row.变压器编号 }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <section class="drawer-section">
          <h4>台账信息</h4>
          <dl class="detail-grid">
            <div><dt>容量等级</dt><dd>{{ detail.row.容量等级 }}</dd></div>
            <div><dt>当前状态</dt><dd><span class="status-badge" :data-status="detail.row.status">{{ detail.row.status }}</span></dd></div>
            <div>
              <dt>油温</dt>
              <dd :class="{ 'over-limit': detail.row.油温越限 === true }">
                {{ detail.row.油温 }}℃<span v-if="detail.row.油温越限 === true" class="mark">越限</span>
              </dd>
            </div>
            <div>
              <dt>绕组温度</dt>
              <dd :class="{ 'over-limit': detail.row.绕组温度越限 === true }">
                {{ detail.row.绕组温度 }}℃<span v-if="detail.row.绕组温度越限 === true" class="mark">越限</span>
              </dd>
            </div>
            <div><dt>基准油温</dt><dd>{{ detail.row.基准油温 }}℃</dd></div>
            <div><dt>基准绕组温度</dt><dd>{{ detail.row.基准绕组温度 }}℃</dd></div>
            <div><dt>油位</dt><dd>{{ detail.row.油位 ?? '—' }}</dd></div>
            <div><dt>瓦斯保护</dt><dd>{{ detail.row.瓦斯保护 ?? '—' }}</dd></div>
            <div><dt>试验日期</dt><dd>{{ detail.row.试验日期 ?? '—' }}</dd></div>
          </dl>
        </section>

        <section class="drawer-section">
          <h4>实测温度录入</h4>
          <div class="inline-form">
            <label>油温(℃)<input v-model.number="reading.oil" type="number" step="0.1" /></label>
            <label>绕组温度(℃)<input v-model.number="reading.winding" type="number" step="0.1" /></label>
            <button class="btn primary" type="button" @click="saveReading">更新实测温度</button>
          </div>
          <p class="form-tip">温度达到限值立即打越限红标；发布告警后可在下方告警历史里复位，复位时标记与告警台数一起回落。</p>
        </section>

        <section class="drawer-section">
          <h4>动作</h4>
          <div class="inline-form">
            <input v-model="operator" placeholder="操作/处理人（复位、停运必填）" />
            <button
              v-for="action in availableActions(detail.row)"
              :key="action"
              class="btn"
              :class="{ primary: action === '告警复位' }"
              type="button"
              @click="runAction(action, detail.row)"
            >
              {{ action }}
            </button>
          </div>
        </section>

        <section class="drawer-section">
          <h4>告警历史（撤掉的告警留痕，不删除）</h4>
          <table class="data-table alarm-table">
            <thead>
              <tr>
                <th>告警编号</th>
                <th>告警时间</th>
                <th>油温/绕组</th>
                <th>越限项</th>
                <th>发布人</th>
                <th>状态</th>
                <th>复位时间</th>
                <th>处理人</th>
                <th>关联缺陷</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="alarm in detail.alarms" :key="alarm.id">
                <td>{{ alarmCode(alarm.id) }}</td>
                <td>{{ formatTime(alarm.alarmTime) }}</td>
                <td>{{ alarm.oilTemp }}℃ / {{ alarm.windingTemp }}℃</td>
                <td>{{ alarm.kinds.join('、') }}</td>
                <td>{{ alarm.publisher || '—' }}</td>
                <td><span class="status-badge" :data-status="alarm.state === '活动' ? '告警' : '运行中'">{{ alarm.state }}</span></td>
                <td>{{ formatTime(alarm.resetTime) }}</td>
                <td>
                  <template v-if="alarm.handler">{{ alarm.handler }}</template>
                  <template v-else-if="alarm.state === '已复位'">
                    <span class="muted">待补录</span>
                    <div class="inline-form compact">
                      <input v-model="supplement[alarm.id]" placeholder="补录处理人" />
                      <button class="link" type="button" @click="doSupplement(alarm.id)">补录</button>
                    </div>
                  </template>
                  <span v-else class="muted">—</span>
                </td>
                <td>{{ alarm.defectCode }}</td>
                <td>{{ alarm.source }}</td>
              </tr>
              <tr v-if="!detail.alarms.length">
                <td colspan="10" class="empty-state">该主变暂无告警历史</td>
              </tr>
            </tbody>
          </table>
          <p class="form-tip">早期只有告警时间、没有处理人的历史记录，处理人留空显示「待补录」，按试验日期回填复位时间，由值班人员在此补录，不伪造实名。</p>
        </section>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  ALARM_CODE_PREFIX,
  alarmsForTransformer,
  exportTransformerCsv,
  getImportCheckpoint,
  importTransformers,
  listTransformers,
  padCode,
  publishAlarm,
  recordReading,
  resetAlarm,
  resumeFromOverhaul,
  saveTransformers,
  stopService,
  submitTest,
  supplementHandler,
  summarizeTransformers,
  transformerTemplate,
} from '@/domain/transformer'
import type { ImportCheckpoint, TransformerAlarm, TransformerRow } from '@/domain/transformer'

const rows = ref<TransformerRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const notice = ref('')
const filters = reactive<Record<string, string>>({})
const filterFields = ['变压器编号', '容量等级', '油温']
const operator = ref('')

const stats = ref(summarizeTransformers([]))
const statCards = computed(() => [
  { label: '运行变压器', value: stats.value.running, danger: false },
  { label: '告警变压器', value: stats.value.alarm, danger: stats.value.alarm > 0 },
  { label: '待试验变压器', value: stats.value.pendingTest, danger: false },
  { label: '停运检修', value: stats.value.stopped, danger: false },
])

const statusSummary = computed(() =>
  (['待试验', '运行中', '告警', '停运'] as const).map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const fileInput = ref<HTMLInputElement | null>(null)
const resumeHint = ref<ImportCheckpoint | null>(getImportCheckpoint())

type DetailState = { row: TransformerRow; alarms: TransformerAlarm[] }
const detail = ref<DetailState | null>(null)
const reading = reactive<{ oil: number | ''; winding: number | '' }>({ oil: '', winding: '' })
const supplement = reactive<Record<number, string>>({})

function reload() {
  errorMessage.value = ''
  const all = listTransformers()
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  rows.value = pairs.length
    ? all.filter((row) =>
        pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
      )
    : all
  total.value = rows.value.length
  stats.value = summarizeTransformers(all)
  if (detail.value) {
    const fresh = all.find((row) => row.id === detail.value?.row.id)
    if (fresh) {
      detail.value = { row: fresh, alarms: alarmsForTransformer(all, fresh.id) }
    } else {
      detail.value = null
    }
  }
}

function resetFilters() {
  Object.keys(filters).forEach((key) => {
    filters[key] = ''
  })
  reload()
}

function exportRows() {
  // 用与台账同一份数据的专用导出（带越限标记），而不是通用导出，避免清单与列表口径不一致。
  const blob = new Blob([exportTransformerCsv()], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '主变压器-清单.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function downloadTemplate() {
  const blob = new Blob([transformerTemplate()], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '主变压器-导入模板.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function triggerImport() {
  fileInput.value?.click()
}

function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const content = String(reader.result ?? '')
    const outcome = importTransformers(content, file.name, listTransformers(), (next) => {
      // 每一行成功后都落同一份台账：中断后已落库行不回滚、不重放，再次选择同一文件即续导。
      saveTransformers(next)
    })
    resumeHint.value = getImportCheckpoint()
    reload()
    if (outcome.finished) {
      notice.value = `导入完成：新增 ${outcome.inserted} 台，更新 ${outcome.updated} 台` +
        (outcome.skippedRows.length ? `，文件内重复编号跳过 ${outcome.skippedRows.length} 行` : '')
      errorMessage.value = ''
    } else {
      notice.value = `已从检查点续导：新增 ${outcome.inserted} 台，更新 ${outcome.updated} 台；处理好问题行后重新选择同一文件即从断点继续`
      errorMessage.value = outcome.errors.join('；')
    }
    input.value = ''
  }
  reader.readAsText(file, 'utf-8')
}

function availableActions(row: TransformerRow): string[] {
  const actions: string[] = []
  if (String(row.status) === '待试验') {
    actions.push('提交试验')
  }
  if (String(row.status) !== '停运') {
    actions.push('发布告警')
  }
  if (String(row.status) === '告警') {
    actions.push('告警复位')
  }
  if (String(row.status) !== '停运') {
    actions.push('停运检修')
  } else {
    actions.push('检修回来')
  }
  return actions
}

function apply(result: { ok: boolean; message: string }) {
  if (result.ok) {
    notice.value = result.message
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
    notice.value = ''
  }
  reload()
}

function runAction(action: string, row: TransformerRow) {
  const id = Number(row.id)
  if (action === '提交试验') {
    apply(submitTest(id))
    return
  }
  if (action === '发布告警') {
    apply(publishAlarm(id, operator.value || '值班管理员'))
    return
  }
  if (action === '告警复位') {
    if (!operator.value.trim()) {
      errorMessage.value = '请先在详情面板填写复位处理人，再执行告警复位'
      openDetail(row)
      return
    }
    apply(resetAlarm(id, operator.value))
    return
  }
  if (action === '停运检修') {
    apply(stopService(id, operator.value))
    return
  }
  if (action === '检修回来') {
    apply(resumeFromOverhaul(id))
  }
}

function openDetail(row: TransformerRow) {
  const all = listTransformers()
  const fresh = all.find((item) => item.id === row.id) ?? row
  detail.value = { row: fresh, alarms: alarmsForTransformer(all, fresh.id) }
  reading.oil = Number(fresh.油温)
  reading.winding = Number(fresh.绕组温度)
}

function closeDetail() {
  detail.value = null
}

function saveReading() {
  if (!detail.value) {
    return
  }
  apply(recordReading(Number(detail.value.row.id), Number(reading.oil), Number(reading.winding)))
}

function doSupplement(alarmId: number) {
  apply(supplementHandler(alarmId, supplement[alarmId] ?? ''))
  supplement[alarmId] = ''
}

function alarmCode(id: number): string {
  return padCode(ALARM_CODE_PREFIX, id)
}

function formatTime(value: string): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

onMounted(reload)
</script>

<style scoped>
.over-limit {
  color: #b42318;
  font-weight: 600;
}
.mark {
  display: inline-block;
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 999px;
  background: #fee4e2;
  color: #b42318;
  font-size: 11px;
  font-weight: 600;
}
.stat-value.danger {
  color: #b42318;
}
.notice-text {
  color: #067647;
}
.notice-text + .error-text {
  margin-left: 8px;
}
.status-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  background: #eef2f7;
  color: #475467;
}
.status-badge[data-status='告警'] {
  background: #fee4e2;
  color: #b42318;
}
.status-badge[data-status='运行中'] {
  background: #e7f6ec;
  color: #067647;
}
.status-badge[data-status='停运'] {
  background: #f2f4f7;
  color: #344054;
}
.hidden-file {
  display: none;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}
.detail-drawer {
  width: 760px;
  max-width: 92vw;
  height: 100%;
  overflow-y: auto;
  background: #fff;
  padding: 16px 20px;
  box-shadow: -8px 0 24px rgba(16, 24, 40, 0.18);
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.drawer-head h3 {
  margin: 0;
  font-size: 16px;
}
.drawer-section {
  margin-top: 16px;
}
.drawer-section h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: #344054;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 16px;
  margin: 0;
}
.detail-grid dt {
  font-size: 12px;
  color: var(--muted);
}
.detail-grid dd {
  margin: 2px 0 0;
  font-size: 13px;
}
.inline-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.inline-form.compact {
  margin-top: 4px;
}
.inline-form label {
  font-size: 12px;
  color: var(--muted);
}
.inline-form input {
  margin-left: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.form-tip {
  font-size: 12px;
  color: var(--muted);
  margin: 6px 0 0;
}
.alarm-table {
  font-size: 12px;
}
.muted {
  color: var(--muted);
}
</style>
