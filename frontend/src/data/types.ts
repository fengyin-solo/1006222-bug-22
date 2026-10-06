/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 主变告警留痕：撤掉的告警不删除，结论从「告警中」翻成「已复位」。 */
export type AlarmRecord = {
  id: number
  变压器编号: string
  告警时间: string
  复位时间: string
  处理人: string
  缺陷编号: string
  结论: string
}

/** 迁移游标：逐条落盘，取数中断后从断掉的那一条接着走。 */
export type MigrationMeta = {
  version: number
  cursor: Record<string, number>
  alarmCursor: number
  done: boolean
}
