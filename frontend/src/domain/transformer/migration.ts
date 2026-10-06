import { readRawRecord, writeRawRecord } from '@/data/local-store'

import {
  ALARM_CODE_PREFIX,
  DATA_VERSION_KEY,
  DEFECT_CODE_PREFIX,
  DEFECT_LEVELS,
  OIL_BASELINE,
  WINDING_BASELINE,
  evaluateTemperature,
  gradeDefect,
  padCode,
} from './constants'
import { saveAlarms } from './history'
import type { DefectRow, OverLimitKind, TransformerAlarm, TransformerRow } from './types'

/**
 * 老数据迁移（v1 -> v2），只执行一次：
 * - 变压器编号、缺陷编号沿用原有编号，新增项在最大序号后续编，不改写已经在册的结论；
 * - 温度等缺项补成数值基线；残留的越限/异常标记按当前状态重算清干净；
 * - 历史告警记录按试验日期回填：早期只有告警时间、没有处理人的，处理人留空（待补录），
 *   不伪造实名；告警过的主变同步补一条设备缺陷，活动告警补「待处理」，已复位补「已消除」。
 */
const CURRENT_VERSION = '2'

function numberOrDefault(value: unknown, fallback: number): number {
  const num = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(num) ? num : fallback
}

function datePlusDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00`)
  if (Number.isNaN(base.getTime())) {
    return ''
  }
  base.setDate(base.getDate() + days)
  return base.toISOString().slice(0, 10)
}

export function currentDataVersion(): string {
  if (typeof window === 'undefined' || !window.localStorage) {
    return CURRENT_VERSION
  }
  return window.localStorage.getItem(DATA_VERSION_KEY) ?? '1'
}

function markVersion() {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(DATA_VERSION_KEY, CURRENT_VERSION)
  }
}

export function ensureDataV2(): void {
  if (currentDataVersion() === CURRENT_VERSION) {
    return
  }

  const record = readRawRecord()
  const legacyTransformers = (record.transformer ?? []) as TransformerRow[]
  const legacyDefects = (record.defect ?? []) as DefectRow[]

  const migratedAlarms: TransformerAlarm[] = []
  const linkedDefects: DefectRow[] = []

  // 老缺陷编号沿用，新补缺陷在最大序号后续编。
  let defectSeq = legacyDefects.reduce((max, row) => {
    const code = String(row.缺陷编号 ?? '')
    const matched = code.startsWith(DEFECT_CODE_PREFIX)
      ? Number.parseInt(code.slice(DEFECT_CODE_PREFIX.length), 10)
      : NaN
    return Number.isFinite(matched) ? Math.max(max, matched) : max
  }, 0)
  let defectId = legacyDefects.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)

  const nextTransformers: TransformerRow[] = legacyTransformers.map((row, index) => {
    const status = String(row.status ?? '')
    const testDate = String(row.试验日期 ?? '').slice(0, 10)

    const legacyOil = numberOrDefault(row.油温, NaN)
    const legacyWinding = numberOrDefault(row.绕组温度, NaN)

    // 活动告警：温度缺项补成越限值（按现场告警事实补口径），其余状态缺项回落到正常基线。
    const isActiveAlarm = status === '告警'
    const oilTemp = Number.isFinite(legacyOil)
      ? legacyOil
      : isActiveAlarm
        ? OIL_BASELINE + 37
        : OIL_BASELINE
    const windingTemp = Number.isFinite(legacyWinding)
      ? legacyWinding
      : isActiveAlarm
        ? WINDING_BASELINE + 43
        : WINDING_BASELINE

    const { oilOver, windingOver, kinds } = evaluateTemperature(oilTemp, windingTemp)
    // 复位后/停运检修回来的旧标记一律清掉：是否越限只由当前温度与状态说了算。
    // 复位残留记录的温度已回落到基线，算不出当时的越限项；既然它确实发过告警，
    // 按油温+绕组双越限补全留痕口径（与缺陷描述一致）。
    const historicalKinds: OverLimitKind[] =
      isActiveAlarm ? kinds : ['油温越限', '绕组温度越限']

    const next: TransformerRow = {
      ...row,
      油温: oilTemp,
      绕组温度: windingTemp,
      基准油温: isActiveAlarm ? OIL_BASELINE : oilTemp,
      基准绕组温度: isActiveAlarm ? WINDING_BASELINE : windingTemp,
      运行状态: status,
      pending: status !== '停运',
      abnormal: isActiveAlarm,
    }
    // 清掉可能残留在行上的旧越限字段，再按当前口径写回。
    delete (next as Record<string, unknown>).油温越限
    delete (next as Record<string, unknown>).绕组温度越限
    if (oilOver) {
      ;(next as Record<string, unknown>).油温越限 = isActiveAlarm
    }
    if (windingOver) {
      ;(next as Record<string, unknown>).绕组温度越限 = isActiveAlarm
    }

    // 只对「告警中」与「复位后仍挂异常标记」的回填历史；停运且没有活动告警的不硬造。
    const needHistory = isActiveAlarm || (status === '运行中' && row.abnormal === true)
    if (needHistory) {
      defectSeq += 1
      defectId += 1
      const alarmSeq = migratedAlarms.length + 1
      const defectCode = padCode(DEFECT_CODE_PREFIX, defectSeq)
      // 留痕快照：活动告警用当前实测温度；复位残留记录温度已回落，按告警时的越限补值描述。
      const snapshotOil = isActiveAlarm ? oilTemp : OIL_BASELINE + 37
      const snapshotWinding = isActiveAlarm ? windingTemp : WINDING_BASELINE + 43
      // 复位残留记录的温度已回落，按「告警当时双越限」的口径定级，避免算成一般缺陷。
      const level = gradeDefect(historicalKinds, snapshotOil, snapshotWinding)
      linkedDefects.push({
        id: defectId,
        status: isActiveAlarm ? '待处理' : '已消除',
        pending: isActiveAlarm,
        abnormal: isActiveAlarm,
        缺陷编号: defectCode,
        设备名称: `主变压器 ${String(row.变压器编号 ?? `TRAN-${index + 1}`)}`,
        缺陷描述: `油温${snapshotOil}℃、绕组温度${snapshotWinding}℃越限（历史告警回填）`,
        缺陷等级: level === DEFECT_LEVELS.normal ? DEFECT_LEVELS.serious : level,
        发现日期: testDate,
        处理期限: isActiveAlarm ? datePlusDays(testDate, 30) : '',
        处理人员: '',
        缺陷状态: isActiveAlarm ? '待处理' : '已消除',
        来源告警: padCode(ALARM_CODE_PREFIX, alarmSeq),
      })
      migratedAlarms.push({
        id: alarmSeq,
        transformerId: Number(row.id),
        transformerCode: String(row.变压器编号 ?? ''),
        alarmTime: testDate ? `${testDate}T08:00:00` : '',
        oilTemp: snapshotOil,
        windingTemp: snapshotWinding,
        kinds: historicalKinds,
        publisher: '',
        defectCode,
        state: isActiveAlarm ? '活动' : '已复位',
        // 早期只有告警时间、没有处理人：按试验日期回填复位时间，处理人留空待补录。
        resetTime: isActiveAlarm ? '' : testDate ? `${testDate}T18:00:00` : '',
        handler: '',
        source: '历史回填',
      })
    }
    return next
  })

  record.transformer = nextTransformers
  record.defect = [...legacyDefects, ...linkedDefects]
  writeRawRecord(record)
  saveAlarms(migratedAlarms)
  markVersion()
}
