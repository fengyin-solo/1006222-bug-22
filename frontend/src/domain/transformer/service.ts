import { listRows, saveRows } from '@/data/local-store'

import { toCsv } from './csv'
import {
  ALARM_CODE_PREFIX,
  DEFECT_CODE_PREFIX,
  DEFECT_LEVELS,
  OIL_BASELINE,
  WINDING_BASELINE,
  evaluateTemperature,
  gradeDefect,
  padCode,
} from './constants'
import { appendAlarm, findActiveAlarm, listAlarms, nextAlarmId, saveAlarms } from './history'
import type {
  DefectRow,
  OverLimitKind,
  TransformerAlarm,
  TransformerRow,
} from './types'

/**
 * 主变压器领域服务：所有写操作的唯一入口。
 * 关键约束：
 * - 告警复位时温度越限标记、告警台数口径、停运回来的旧标记一起回到正常口径，
 *   列表 / 详情面板 / 概览 / 导出清单读的是同一份台账；
 * - 撤掉的告警只改状态、不删除，历史告警留痕；
 * - 同一台主变重复复位只生效一次（活动告警已不存在即拒绝），告警台数不会减两次。
 */

export function listTransformers(): TransformerRow[] {
  return listRows('transformer') as TransformerRow[]
}

/** 整批写回主变台账：导入器逐行落库时调用，保证中断后从断掉的那一条接着走。 */
export function saveTransformers(rows: TransformerRow[]): void {
  persistTransformers(rows)
}

function persistTransformers(rows: TransformerRow[]): void {
  saveRows('transformer', rows)
}

export function listDefects(): DefectRow[] {
  return listRows('defect') as DefectRow[]
}

function persistDefects(rows: DefectRow[]): void {
  saveRows('defect', rows)
}

function nowText(): string {
  return new Date().toISOString()
}

function today(): string {
  return nowText().slice(0, 10)
}

function deadlineFor(level: string): string {
  const date = new Date()
  date.setDate(date.getDate() + (level === DEFECT_LEVELS.critical ? 7 : 30))
  return date.toISOString().slice(0, 10)
}

function findTransformer(rows: TransformerRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

/** 把一台主变的温度与标记写回正常口径：温度回落基线，越限标记全部清除。 */
function normalizeTemperature(row: TransformerRow): TransformerRow {
  const oilBase = Number.isFinite(Number(row.基准油温)) ? Number(row.基准油温) : OIL_BASELINE
  const windingBase = Number.isFinite(Number(row.基准绕组温度))
    ? Number(row.基准绕组温度)
    : WINDING_BASELINE
  const next: TransformerRow = {
    ...row,
    油温: oilBase,
    绕组温度: windingBase,
    abnormal: false,
  }
  delete (next as Record<string, unknown>).油温越限
  delete (next as Record<string, unknown>).绕组温度越限
  return next
}

function nextDefectCode(): { id: number; code: string } {
  const rows = listDefects()
  let seq = 0
  let id = 0
  for (const row of rows) {
    id = Math.max(id, Number(row.id) || 0)
    const code = String(row.缺陷编号 ?? '')
    if (code.startsWith(DEFECT_CODE_PREFIX)) {
      const num = Number.parseInt(code.slice(DEFECT_CODE_PREFIX.length), 10)
      if (Number.isFinite(num)) {
        seq = Math.max(seq, num)
      }
    }
  }
  return { id: id + 1, code: padCode(DEFECT_CODE_PREFIX, seq + 1) }
}

export type ActionOutcome = {
  ok: boolean
  message: string
}

/** 提交试验：待试验 → 运行中，温度取当前实测值并落基准，标记清干净。 */
export function submitTest(id: number, oilTemp?: number, windingTemp?: number): ActionOutcome {
  const rows = listTransformers()
  const index = findTransformer(rows, id)
  if (index < 0) {
    return { ok: false, message: '没有找到这台主变压器' }
  }
  const current = rows[index]
  const oil = Number.isFinite(Number(oilTemp)) ? Number(oilTemp) : OIL_BASELINE
  const winding = Number.isFinite(Number(windingTemp))
    ? Number(windingTemp)
    : WINDING_BASELINE
  const { kinds } = evaluateTemperature(oil, winding)
  if (kinds.length > 0) {
    return {
      ok: false,
      message: `实测温度已越限（${kinds.join('、')}），请直接发布告警，不能按正常试验提交`,
    }
  }
  rows[index] = {
    ...normalizeTemperature(current),
    油温: oil,
    绕组温度: winding,
    基准油温: oil,
    基准绕组温度: winding,
    status: '运行中',
    运行状态: '运行中',
    pending: true,
  }
  persistTransformers(rows)
  return { ok: true, message: '试验数据已提交，主变运行中' }
}

/**
 * 录入实测温度：只更新温度与越限标记，不改状态。
 * 温度达到限值立即在列表/详情打红标，是否发布告警由「发布告警」动作落状态与留痕。
 */
export function recordReading(id: number, oilTemp: number, windingTemp: number): ActionOutcome {
  if (!Number.isFinite(oilTemp) || !Number.isFinite(windingTemp)) {
    return { ok: false, message: '油温与绕组温度必须是有效数值' }
  }
  const rows = listTransformers()
  const index = findTransformer(rows, id)
  if (index < 0) {
    return { ok: false, message: '没有找到这台主变压器' }
  }
  const current = rows[index]
  if (String(current.status) === '停运') {
    return { ok: false, message: '停运检修中的主变不录入运行温度，请先检修回来' }
  }
  const { oilOver, windingOver } = evaluateTemperature(oilTemp, windingTemp)
  const next: TransformerRow = {
    ...current,
    油温: oilTemp,
    绕组温度: windingTemp,
  }
  delete (next as Record<string, unknown>).油温越限
  delete (next as Record<string, unknown>).绕组温度越限
  if (oilOver) {
    ;(next as Record<string, unknown>).油温越限 = true
  }
  if (windingOver) {
    ;(next as Record<string, unknown>).绕组温度越限 = true
  }
  persistTransformers(rows.map((row, i) => (i === index ? next : row)))
  const marks: string[] = []
  if (oilOver) {
    marks.push('油温越限')
  }
  if (windingOver) {
    marks.push('绕组温度越限')
  }
  return {
    ok: true,
    message: marks.length ? `实测温度已越限（${marks.join('、')}），请发布告警` : '实测温度正常，已更新',
  }
}

/** 发布告警：记录越限标记、留一条告警历史、联动生成一条「待处理」设备缺陷。 */
export function publishAlarm(id: number, publisher: string): ActionOutcome {
  const rows = listTransformers()
  const index = findTransformer(rows, id)
  if (index < 0) {
    return { ok: false, message: '没有找到这台主变压器' }
  }
  const current = rows[index]
  if (String(current.status) === '停运') {
    return { ok: false, message: '停运检修中的主变不发布告警，请先检修回来' }
  }
  const oilTemp = Number(current.油温)
  const windingTemp = Number(current.绕组温度)
  const { oilOver, windingOver, kinds } = evaluateTemperature(oilTemp, windingTemp)
  if (kinds.length === 0) {
    return { ok: false, message: '油温、绕组温度均在限值内，没有可发布的越限告警' }
  }
  if (findActiveAlarm(id)) {
    return { ok: false, message: '这台主变已有一条活动告警，不能重复发布' }
  }

  const alarms = listAlarms()
  const alarmId = nextAlarmId()
  const alarmCode = padCode(ALARM_CODE_PREFIX, alarmId)
  const { id: defectId, code: defectCode } = nextDefectCode()
  const level = gradeDefect(kinds, oilTemp, windingTemp)

  const flags: Record<string, boolean> = {
    油温越限: oilOver,
    绕组温度越限: windingOver,
  }
  rows[index] = {
    ...current,
    ...flags,
    status: '告警',
    运行状态: '告警',
    pending: true,
    abnormal: true,
  }
  persistTransformers(rows)

  const defect: DefectRow = {
    id: defectId,
    status: '待处理',
    pending: true,
    abnormal: true,
    缺陷编号: defectCode,
    设备名称: `主变压器 ${current.变压器编号}`,
    缺陷描述: `油温${oilTemp}℃、绕组温度${windingTemp}℃越限（${kinds.join('、')}）`,
    缺陷等级: level,
    发现日期: today(),
    处理期限: deadlineFor(level),
    处理人员: '',
    缺陷状态: '待处理',
    来源告警: alarmCode,
  }
  persistDefects([...listDefects(), defect])

  const alarm: TransformerAlarm = {
    id: alarmId,
    transformerId: id,
    transformerCode: String(current.变压器编号 ?? ''),
    alarmTime: nowText(),
    oilTemp,
    windingTemp,
    kinds: [...kinds],
    publisher: publisher.trim(),
    defectCode,
    state: '活动',
    resetTime: '',
    handler: '',
    source: '操作',
  }
  appendAlarm(alarm)
  return { ok: true, message: `已发布告警（${alarmCode}），联动缺陷 ${defectCode} 已进入待处理` }
}

/**
 * 告警复位：唯一能撤掉活动告警的动作。
 * 一次性把四件事办齐：活动告警置「已复位」、温度回落基线并清越限标记、
 * 关联缺陷置「已消除」、主变回到运行中（停运中复位则保持停运口径，检修回来再恢复）。
 * 重复复位：活动告警已不存在即拒绝，台数不会减两次。
 */
export function resetAlarm(id: number, handler: string): ActionOutcome {
  const active = findActiveAlarm(id)
  if (!active) {
    return { ok: false, message: '这台主变没有活动告警，无需复位（重复复位不生效）' }
  }
  const operator = handler.trim()
  if (!operator) {
    return { ok: false, message: '请填写复位处理人' }
  }

  const rows = listTransformers()
  const index = findTransformer(rows, id)
  if (index < 0) {
    return { ok: false, message: '没有找到这台主变压器' }
  }
  const keepStopped = String(rows[index].status) === '停运'
  const normalized = normalizeTemperature(rows[index])
  rows[index] = {
    ...normalized,
    status: keepStopped ? '停运' : '运行中',
    运行状态: keepStopped ? '停运' : '运行中',
    pending: !keepStopped,
  }
  persistTransformers(rows)

  const resetAt = nowText()
  saveAlarms(
    listAlarms().map((item) =>
      item.id === active.id ? { ...item, state: '已复位', resetTime: resetAt, handler: operator } : item,
    ),
  )

  // 动作结果落到设备缺陷清单上：缺陷处置页面（另一个入口）同样看得到。
  const defects = listDefects()
  let linked = false
  const nextDefects = defects.map((row) => {
    if (row.缺陷编号 !== active.defectCode) {
      return row
    }
    linked = true
    return {
      ...row,
      status: '已消除',
      缺陷状态: '已消除',
      pending: false,
      abnormal: false,
      处理人员: operator,
    }
  })
  if (!linked) {
    // 缺陷清单缺项（老数据迁移遗漏）时一并补进来，保持两处一致。
    const { id: newId, code } = nextDefectCode()
    nextDefects.push({
      id: newId,
      status: '已消除',
      pending: false,
      abnormal: false,
      缺陷编号: active.defectCode || code,
      设备名称: `主变压器 ${active.transformerCode}`,
      缺陷描述: `历史告警复位消缺（${active.kinds.join('、')}）`,
      缺陷等级: gradeDefect(active.kinds, active.oilTemp, active.windingTemp),
      发现日期: (active.alarmTime || '').slice(0, 10),
      处理期限: '',
      处理人员: operator,
      缺陷状态: '已消除',
      来源告警: padCode(ALARM_CODE_PREFIX, active.id),
    })
  }
  persistDefects(nextDefects)

  return {
    ok: true,
    message: keepStopped
      ? `告警已复位（${padCode(ALARM_CODE_PREFIX, active.id)}），温度标记已清除；设备仍在停运检修中`
      : `告警已复位（${padCode(ALARM_CODE_PREFIX, active.id)}），温度回落正常，缺陷已消除`,
  }
}

/** 停运检修：带着活动告警去检修的，先按检修口径复位留痕；旧越限标记一并清掉。 */
export function stopService(id: number, handler: string): ActionOutcome {
  const rows = listTransformers()
  const index = findTransformer(rows, id)
  if (index < 0) {
    return { ok: false, message: '没有找到这台主变压器' }
  }
  const current = rows[index]
  if (String(current.status) === '停运') {
    return { ok: false, message: '这台主变已经在停运检修中' }
  }

  // 带着活动告警停运：告警随停运一并复位留痕，避免检修回来还挂旧标记。
  if (findActiveAlarm(id)) {
    const result = resetAlarm(id, handler || '检修停运')
    if (!result.ok) {
      return result
    }
  }

  const latest = listTransformers()
  const latestIndex = findTransformer(latest, id)
  const normalized = normalizeTemperature(latest[latestIndex])
  latest[latestIndex] = {
    ...normalized,
    status: '停运',
    运行状态: '停运',
    pending: false,
    abnormal: false,
  }
  persistTransformers(latest)
  return { ok: true, message: '已停运检修，越限旧标记已随停运清除' }
}

/** 检修回来：恢复运行，温度按基线回落，不允许带着活动告警/旧标记回来。 */
export function resumeFromOverhaul(id: number): ActionOutcome {
  const rows = listTransformers()
  const index = findTransformer(rows, id)
  if (index < 0) {
    return { ok: false, message: '没有找到这台主变压器' }
  }
  if (String(rows[index].status) !== '停运') {
    return { ok: false, message: '只有停运检修中的主变才能检修回来' }
  }
  if (findActiveAlarm(id)) {
    return { ok: false, message: '该主变仍有活动告警，请先复位告警再恢复运行' }
  }
  rows[index] = {
    ...normalizeTemperature(rows[index]),
    status: '运行中',
    运行状态: '运行中',
    pending: true,
  }
  persistTransformers(rows)
  return { ok: true, message: '检修完成，主变已恢复运行，温度回到正常口径' }
}

/**
 * 补录早期历史告警的处理人：只有「已复位但处理人为空」的记录可补，补一次即锁定口径。
 * 早期只有告警时间、没有处理人的记录统一走这里，不伪造实名。
 */
export function supplementHandler(alarmId: number, handler: string): ActionOutcome {
  const operator = handler.trim()
  if (!operator) {
    return { ok: false, message: '请填写要补录的处理人姓名' }
  }
  const alarms = listAlarms()
  const index = alarms.findIndex((item) => item.id === alarmId)
  if (index < 0) {
    return { ok: false, message: '没有找到这条告警记录' }
  }
  const alarm = alarms[index]
  if (alarm.state !== '已复位') {
    return { ok: false, message: '活动告警请直接在复位操作里填写处理人' }
  }
  if (alarm.handler.trim()) {
    return { ok: false, message: '该记录已有处理人，补录不改写在册结论' }
  }
  alarms[index] = { ...alarm, handler: operator }
  saveAlarms(alarms)

  // 同步到缺陷清单的处理人员（缺陷本身已消除，仅补处理人口径）。
  const defects = listDefects().map((row) =>
    row.缺陷编号 === alarm.defectCode && !String(row.处理人员 ?? '').trim()
      ? { ...row, 处理人员: operator }
      : row,
  )
  persistDefects(defects)
  return { ok: true, message: `告警 ${padCode(ALARM_CODE_PREFIX, alarmId)} 处理人已补录` }
}

/** 导出明细：从同一份台账生成，温度列带越限标记后缀，状态列与列表完全一致。 */
export function exportTransformerCsv(): string {
  const rows = listTransformers()
  const header = [
    '变压器编号',
    '容量等级',
    '油温',
    '绕组温度',
    '油位',
    '瓦斯保护',
    '试验日期',
    '运行状态',
    '当前告警',
  ]
  const lines = rows.map((row) => {
    const flags: OverLimitKind[] = []
    if (row.油温越限 === true) {
      flags.push('油温越限')
    }
    if (row.绕组温度越限 === true) {
      flags.push('绕组温度越限')
    }
    return [
      row.变压器编号 ?? '',
      row.容量等级 ?? '',
      `${row.油温}℃${flags.includes('油温越限') ? '（越限）' : ''}`,
      `${row.绕组温度}℃${flags.includes('绕组温度越限') ? '（越限）' : ''}`,
      row.油位 ?? '',
      row.瓦斯保护 ?? '',
      row.试验日期 ?? '',
      row.status,
      flags.join('、'),
    ]
  })
  return toCsv(header, lines)
}
