<template>
  <section class="page" data-module="transformer">
    <header class="page-head">
      <div>
        <h2>主变压器管理</h2>
        <p class="page-desc">维护主变压器，围绕变压器编号、容量等级、油温、绕组温度做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记主变压器</button>
        <button class="btn" type="button" @click="exportRows">导出主变压器清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <span :class="{ 'over-limit': isOverLimit(row, column) }">{{ row[column] ?? '—' }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无主变压器数据，可先登记主变压器</td>
        </tr>
      </tbody>
    </table>

    <aside v-if="detail" class="detail-panel">
      <header class="detail-head">
        <h3>主变详情：{{ detail['变压器编号'] }}</h3>
        <button class="btn ghost" type="button" @click="detail = null">关闭</button>
      </header>
      <dl class="detail-grid">
        <template v-for="column in columns" :key="column">
          <dt>{{ column }}</dt>
          <dd :class="{ 'over-limit': isOverLimit(detail, column) }">{{ detail[column] ?? '—' }}</dd>
        </template>
        <dt>当前状态</dt>
        <dd>{{ detail.status }}</dd>
        <dt>越限标记</dt>
        <dd>{{ overLimitText(detail) }}</dd>
      </dl>

      <h4>告警历史（撤掉的告警留痕，不删除）</h4>
      <table class="data-table">
        <thead>
          <tr><th>告警时间</th><th>复位时间</th><th>处理人</th><th>缺陷编号</th><th>结论</th></tr>
        </thead>
        <tbody>
          <tr v-for="alarm in detailAlarms" :key="alarm.id">
            <td>{{ alarm['告警时间'] || '—' }}</td>
            <td>{{ alarm['复位时间'] || '—' }}</td>
            <td>{{ alarm['处理人'] || '—' }}</td>
            <td>{{ alarm['缺陷编号'] || '—' }}</td>
            <td>{{ alarm['结论'] }}</td>
          </tr>
          <tr v-if="!detailAlarms.length">
            <td colspan="5" class="empty-state">暂无告警记录</td>
          </tr>
        </tbody>
      </table>

      <h4>关联缺陷（缺陷处置清单同一份数据）</h4>
      <table class="data-table">
        <thead>
          <tr><th>缺陷编号</th><th>缺陷描述</th><th>缺陷等级</th><th>处理人员</th><th>缺陷状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="defect in detailDefects" :key="String(defect.id)">
            <td>{{ defect['缺陷编号'] }}</td>
            <td>{{ defect['缺陷描述'] }}</td>
            <td>{{ defect['缺陷等级'] }}</td>
            <td>{{ defect['处理人员'] }}</td>
            <td>{{ defect.status }}</td>
          </tr>
          <tr v-if="!detailDefects.length">
            <td colspan="5" class="empty-state">暂无关联缺陷</td>
          </tr>
        </tbody>
      </table>
    </aside>

    <footer class="page-foot">
      <span>共 {{ total }} 条主变压器记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listTransformerAlarms,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('transformer')
const store = useSessionStore()
const columns = ["变压器编号", "容量等级", "油温", "绕组温度", "油位", "瓦斯保护", "试验日期", "运行状态"]
const statuses = ["待试验", "运行中", "告警", "停运"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const detail = ref<EntryRow | null>(null)

// 统计与概览同口径：告警台数 = 带着未复位告警痕迹（abnormal）的台数，两处不再对不上
const stats = computed(() => [
  { label: '运行变压器', value: rows.value.filter((row) => row.status === '运行中').length },
  { label: '告警变压器', value: rows.value.filter((row) => row.abnormal).length },
  { label: '待试验变压器', value: rows.value.filter((row) => row.status === '待试验').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const detailAlarms = computed(() =>
  detail.value ? listTransformerAlarms(String(detail.value['变压器编号'])) : [],
)
const detailDefects = computed(() => {
  if (!detail.value) {
    return []
  }
  const code = String(detail.value['变压器编号'])
  return listEntries('defect').items.filter((row) => String(row['设备名称']) === code)
})

function hasTrace(row: EntryRow): boolean {
  return row.status === '告警' || row['油温越限'] === true || row['绕组温度越限'] === true
}

function isOverLimit(row: EntryRow, column: string): boolean {
  if (column === '油温') {
    return row['油温越限'] === true
  }
  if (column === '绕组温度') {
    return row['绕组温度越限'] === true
  }
  return false
}

function overLimitText(row: EntryRow): string {
  const marks: string[] = []
  if (row['油温越限'] === true) marks.push('油温越限')
  if (row['绕组温度越限'] === true) marks.push('绕组温度越限')
  return marks.length ? marks.join('、') : '无'
}

// 按当前状态给出能点的动作，点下去必有反应；无效动作不再出现在列表里
function availableActions(row: EntryRow): string[] {
  const status = String(row.status)
  const trace = hasTrace(row)
  const list: string[] = []
  if (status === '待试验' || status === '停运') {
    list.push('提交试验')
  }
  if ((status === '运行中' || status === '待试验') && !trace) {
    list.push('发布告警')
  }
  if (trace) {
    list.push('告警复位')
  }
  if (status === '运行中' || status === '告警') {
    list.push('停运检修')
  }
  return list
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '主变压器登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  detail.value = row
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (detail.value) {
      detail.value = payload.items.find((row) => Number(row.id) === Number(detail.value?.id)) ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '主变压器列表读取失败'
  }
}

onMounted(reload)
</script>
