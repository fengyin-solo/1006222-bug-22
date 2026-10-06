import { listAlarms } from './history'
import type { TransformerAlarm, TransformerRow } from './types'

/**
 * 主变口径统计：列表页统计卡、状态汇总、概览页全部从这里取数，
 * 「告警台数」只有一个口径——当前状态为告警（=存在活动告警记录）的台数，
 * 不再让列表与概览各算各的。
 */
export type TransformerStats = {
  running: number
  alarm: number
  pendingTest: number
  stopped: number
  /** 发布过告警的台数（含已复位，按台账主变去重），供历史区展示，不当作「告警台数」。 */
  everAlarmed: number
  /** 活动告警记录条数，与告警台数同口径（一台同时只允许一条活动告警）。 */
  activeAlarms: number
}

export function summarizeTransformers(rows: TransformerRow[]): TransformerStats {
  const alarms = listAlarms()
  const activeByTransformer = new Set(
    alarms.filter((item) => item.state === '活动').map((item) => item.transformerId),
  )
  return {
    running: rows.filter((row) => String(row.status) === '运行中').length,
    // 以活动告警记录为准；状态被外部改成告警但没有活动记录的，同样计入（口径仍唯一）。
    alarm: rows.filter(
      (row) => String(row.status) === '告警' || activeByTransformer.has(Number(row.id)),
    ).length,
    pendingTest: rows.filter((row) => String(row.status) === '待试验').length,
    stopped: rows.filter((row) => String(row.status) === '停运').length,
    everAlarmed: new Set(alarms.map((item) => item.transformerId)).size,
    activeAlarms: alarms.filter((item) => item.state === '活动').length,
  }
}

export function alarmsForTransformer(
  rows: TransformerRow[],
  transformerId: number,
): TransformerAlarm[] {
  return listAlarms()
    .filter((item) => item.transformerId === transformerId)
    .sort((a, b) => (a.alarmTime < b.alarmTime ? 1 : -1))
}
