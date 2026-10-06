import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  appendAlarm,
  closeAlarmsFor,
  listAlarms,
  listRows,
  resetRows,
  saveRows,
} from '@/data/local-store'
import type { ActionResult, AlarmRecord, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 主变温度口径：油温 85℃、绕组温度 105℃ 越限；告警时写入越限值，复位后回到正常值。
const OIL_TEMP_LIMIT = 85
const WINDING_TEMP_LIMIT = 105
const ALARM_OIL_TEMP = '96'
const ALARM_WINDING_TEMP = '112'
const NORMAL_OIL_TEMP = '62'
const NORMAL_WINDING_TEMP = '78'

// 缺陷等级沿用缺陷处置模块在册的划分（一般/严重/危急），主变温度越限告警固定落「严重」，
// 已经在册的缺陷结论一概不改写。
const ALARM_DEFECT_LEVEL = '严重'
const ALARM_DEFECT_TAG = '温度越限告警'

function todayStr(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

function plusDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00`)
  date.setDate(date.getDate() + days)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${mm}-${dd}`
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// ---------------------------------------------------------------------------
// 主变压器：告警发布 / 告警复位 / 复役都要把温度越限标记、告警台数、缺陷清单一起
// 回到正常口径，列表、详情面板、概览与导出清单读到的都是同一份。
// ---------------------------------------------------------------------------

/** 这台主变身上还有没有没清干净的告警痕迹。 */
function hasAlarmTrace(row: EntryRow): boolean {
  return row.status === '告警' || row['油温越限'] === true || row['绕组温度越限'] === true
}

/** 该设备未闭环的温度越限缺陷：开单与销单都按它判重，不重复开、不漏销。 */
function openAlarmDefects(transformerCode: string): EntryRow[] {
  return listRows('defect').filter(
    (row) =>
      String(row['设备名称']) === transformerCode &&
      String(row['缺陷描述'] ?? '').includes(ALARM_DEFECT_TAG) &&
      row.status !== '已消除' &&
      row.status !== '已挂账',
  )
}

/** 发布告警时落一张缺陷单；同设备已有未闭环的越限缺陷就直接复用，不重复开单。 */
function ensureAlarmDefect(transformerCode: string, operator: string): string {
  const existing = openAlarmDefects(transformerCode)
  if (existing.length > 0) {
    return String(existing[0]['缺陷编号'])
  }
  const defects = [...listRows('defect')]
  const maxNo = defects.reduce((max, row) => {
    const matched = /^DEFE-(\d+)$/.exec(String(row['缺陷编号'] ?? ''))
    return matched ? Math.max(max, Number(matched[1])) : max
  }, 0)
  const defectNo = `DEFE-${String(maxNo + 1).padStart(4, '0')}`
  const id = defects.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const today = todayStr()
  defects.push({
    id,
    status: '待处理',
    pending: true,
    abnormal: true,
    缺陷编号: defectNo,
    设备名称: transformerCode,
    缺陷描述: `主变${ALARM_DEFECT_TAG}：油温${ALARM_OIL_TEMP}℃（限值${OIL_TEMP_LIMIT}℃）、绕组温度${ALARM_WINDING_TEMP}℃（限值${WINDING_TEMP_LIMIT}℃）`,
    缺陷等级: ALARM_DEFECT_LEVEL,
    发现日期: today,
    处理期限: plusDays(today, 7),
    处理人员: operator,
    缺陷状态: '待处理',
  })
  saveRows('defect', defects)
  return defectNo
}

/** 复位/复役时把该主变未闭环的越限缺陷翻成「已消除」：留痕，不删除。 */
function resolveAlarmDefects(transformerCode: string, operator: string): void {
  const defects = [...listRows('defect')]
  let changed = false
  for (const row of defects) {
    if (
      String(row['设备名称']) === transformerCode &&
      String(row['缺陷描述'] ?? '').includes(ALARM_DEFECT_TAG) &&
      row.status !== '已消除' &&
      row.status !== '已挂账'
    ) {
      row.status = '已消除'
      row['缺陷状态'] = '已消除'
      row['处理人员'] = operator
      row.pending = false
      row.abnormal = false
      changed = true
    }
  }
  if (changed) {
    saveRows('defect', defects)
  }
}

function publishTransformerAlarm(row: EntryRow, operator: string): EntryRow {
  const code = String(row['变压器编号'])
  const defectNo = ensureAlarmDefect(code, operator)
  appendAlarm({
    变压器编号: code,
    告警时间: todayStr(),
    复位时间: '',
    处理人: operator,
    缺陷编号: defectNo,
    结论: '告警中',
  })
  return {
    ...row,
    status: '告警',
    pending: true,
    abnormal: true,
    油温越限: true,
    绕组温度越限: true,
    // 告警前的温度留底，复位时照它回落，不拿旧值顶替
    告警前油温: String(row['告警前油温'] ?? '') || String(row['油温'] ?? ''),
    告警前绕组温度: String(row['告警前绕组温度'] ?? '') || String(row['绕组温度'] ?? ''),
    油温: ALARM_OIL_TEMP,
    绕组温度: ALARM_WINDING_TEMP,
    运行状态: '告警',
  }
}

function resetTransformerAlarm(row: EntryRow, operator: string): EntryRow {
  const code = String(row['变压器编号'])
  closeAlarmsFor(code, operator, todayStr())
  resolveAlarmDefects(code, operator)
  const oilBefore = String(row['告警前油温'] ?? '')
  const windingBefore = String(row['告警前绕组温度'] ?? '')
  return {
    ...row,
    status: '运行中',
    pending: true,
    abnormal: false,
    油温越限: false,
    绕组温度越限: false,
    // 有留底就照留底回落；越限值没有留底的回到正常口径；没越限过的保持原值
    油温: oilBefore || (row['油温越限'] === true ? NORMAL_OIL_TEMP : String(row['油温'] ?? NORMAL_OIL_TEMP)),
    绕组温度:
      windingBefore ||
      (row['绕组温度越限'] === true ? NORMAL_WINDING_TEMP : String(row['绕组温度'] ?? NORMAL_WINDING_TEMP)),
    告警前油温: '',
    告警前绕组温度: '',
    运行状态: '运行中',
  }
}

function runTransformerAction(id: number, action: string, operator: string): ActionResult {
  const rows = [...listRows('transformer')]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的主变压器` }
  }
  const row = rows[index]
  const trace = hasAlarmTrace(row)
  let updated: EntryRow
  switch (action) {
    case '发布告警':
      if (row.status === '告警' && trace) {
        return { ok: false, message: '该主变已处于告警态，不重复发布' }
      }
      if (row.status === '停运') {
        return { ok: false, message: '停运中的主变请先提交试验复役，再发布告警' }
      }
      updated = publishTransformerAlarm(row, operator)
      break
    case '告警复位':
      // 幂等：同一台重复复位只生效一次，痕迹清干净后再点不再减台数
      if (!trace) {
        return { ok: false, message: '该主变没有未复位的告警痕迹，重复复位不再生效' }
      }
      updated = resetTransformerAlarm(row, operator)
      break
    case '提交试验':
      if (row.status === '运行中' && !trace) {
        return { ok: false, message: '该主变已经是「运行中」，不用重复操作' }
      }
      if (trace) {
        // 停运检修回来还带着旧越限标记的，一并清掉，告警日志与缺陷单同步闭环
        updated = resetTransformerAlarm(row, operator)
      } else {
        updated = { ...row, status: '运行中', pending: true, abnormal: false, 运行状态: '运行中' }
      }
      break
    case '停运检修':
      if (row.status === '停运') {
        return { ok: false, message: '该主变已经是「停运」，不用重复操作' }
      }
      updated = { ...row, status: '停运', pending: false, abnormal: false, 运行状态: '停运' }
      break
    default:
      return { ok: false, message: `主变压器没有登记「${action}」这个动作` }
  }
  rows[index] = updated
  saveRows('transformer', rows)
  return { ok: true, message: `主变压器已${action}，当前状态「${updated.status}」` }
}

export function runAction(key: string, id: number, action: string, operator = '值班管理员'): ActionResult {
  if (key === 'transformer') {
    return runTransformerAction(id, action, operator)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/** 主变告警留痕：详情面板与缺陷清单都从这里读同一份。 */
export function listTransformerAlarms(transformerCode?: string): AlarmRecord[] {
  return listAlarms(transformerCode)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态', '异常标记']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push(
      [
        row.id,
        ...meta.fields.map((field) => row[field] ?? ''),
        row.status,
        row.abnormal ? '异常' : '正常',
      ].join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
