import { ALARM_HISTORY_KEY } from './constants'
import type { TransformerAlarm } from './types'

// 告警历史单独存放：发布告警写一条、复位只改状态，任何操作都不删除记录（撤掉的告警留痕）。
let cache: TransformerAlarm[] | null = null

function readHistory(): TransformerAlarm[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(ALARM_HISTORY_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as TransformerAlarm[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function listAlarms(): TransformerAlarm[] {
  if (cache === null) {
    cache = readHistory()
  }
  return cache
}

export function saveAlarms(alarms: TransformerAlarm[]): void {
  cache = alarms
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ALARM_HISTORY_KEY, JSON.stringify(alarms))
  }
}

export function appendAlarm(alarm: TransformerAlarm): void {
  saveAlarms([...listAlarms(), alarm])
}

export function findActiveAlarm(transformerId: number): TransformerAlarm | undefined {
  return listAlarms().find(
    (item) => item.transformerId === transformerId && item.state === '活动',
  )
}

/**
 * 下一个告警记录编号：迁移老数据时老记录沿用原有编号区间，
 * 新记录一律取「现有最大编号 + 1」，保证不撞号、不复用已撤告警的号。
 */
export function nextAlarmId(): number {
  return listAlarms().reduce((max, item) => Math.max(max, item.id), 0) + 1
}
