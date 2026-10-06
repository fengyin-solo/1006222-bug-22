import { MODULES } from './modules'
import { SEED_ROWS, SEED_TRANSFORMER_ALARMS } from './seed'
import type { AlarmRecord, EntryRow, MigrationMeta } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'
const ALARM_KEY = 'hydropower-plant-om:transformer-alarms'
const META_KEY = 'hydropower-plant-om:meta'

// 数据结构版本：老数据没有版本号，一律按 1 处理，迁到 CURRENT_DATA_VERSION 为止。
const CURRENT_DATA_VERSION = 2

// 早期历史告警只有告警时间、没有处理人：补录口径统一为「系统补录」，不虚构具体人名。
export const LEGACY_HANDLER = '系统补录'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function todayStr(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

function persist(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 迁移：老数据按原有编号（id 不动）升级到新结构。
// 游标逐条落盘，取数中断后从断掉的那一条接着走；只补缺项，不拿旧值顶替已有值。
// ---------------------------------------------------------------------------

function readMeta(): MigrationMeta {
  const stored = readJson<Partial<MigrationMeta>>(META_KEY)
  if (stored && typeof stored.version === 'number') {
    return {
      version: stored.version,
      cursor: stored.cursor ?? {},
      alarmCursor: stored.alarmCursor ?? 0,
      done: stored.done ?? false,
    }
  }
  return { version: 1, cursor: {}, alarmCursor: 0, done: false }
}

function saveMeta(meta: MigrationMeta): void {
  persist(META_KEY, meta)
}

/** 单条记录迁移：缺的字段补默认值，已经在册的值一个不改。 */
function migrateRow(key: string, row: EntryRow): EntryRow {
  const next: EntryRow = { ...row }
  if (next.pending === undefined) next.pending = false
  if (next.abnormal === undefined) next.abnormal = false
  if (key === 'transformer') {
    if (next['油温越限'] === undefined) next['油温越限'] = false
    if (next['绕组温度越限'] === undefined) next['绕组温度越限'] = false
    if (next['告警前油温'] === undefined) next['告警前油温'] = ''
    if (next['告警前绕组温度'] === undefined) next['告警前绕组温度'] = ''
    if (next.status === '告警') {
      // 告警态必须带越限痕迹与异常标记，列表与概览才数得成同一个数
      next['油温越限'] = true
      next['绕组温度越限'] = true
      next.abnormal = true
    } else {
      // 非告警态（含停运检修回来的）不保留越限红标，残留一并清掉
      next['油温越限'] = false
      next['绕组温度越限'] = false
      next.abnormal = false
    }
  }
  return next
}

/**
 * 去重口径（定死）：按模块第一个字段（业务编号，如「变压器编号」「缺陷编号」）判重，
 * 编号去空格后相同即视为同一条；保留 id 最小（最先登记）的那条，其余丢弃。
 */
function dedupeRows(key: string, rows: EntryRow[]): EntryRow[] {
  const meta = MODULES.find((item) => item.key === key)
  const codeField = meta?.fields[0]
  if (!codeField) {
    return rows
  }
  const seen = new Set<string>()
  const kept: EntryRow[] = []
  const sorted = [...rows].sort((a, b) => Number(a.id) - Number(b.id))
  for (const row of sorted) {
    const code = String(row[codeField] ?? '').trim()
    if (code !== '' && seen.has(code)) {
      continue
    }
    seen.add(code)
    kept.push(row)
  }
  return kept
}

function migrateEntries(data: Record<string, EntryRow[]>, meta: MigrationMeta): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = { ...data }
  for (const mod of MODULES) {
    const rows = [...(next[mod.key] ?? [])]
    for (let i = 0; i < rows.length; i += 1) {
      const id = Number(rows[i].id)
      if (id <= (meta.cursor[mod.key] ?? 0)) {
        continue // 这条上一轮已经迁过，跳过——中断后从断掉的那条接着走
      }
      rows[i] = migrateRow(mod.key, rows[i])
      meta.cursor[mod.key] = id
      saveMeta(meta)
    }
    next[mod.key] = dedupeRows(mod.key, rows)
  }
  return next
}

// ---------------------------------------------------------------------------
// 告警留痕：撤掉的告警不丢，单独存一份日志，列表/详情/缺陷清单都从这里读。
// ---------------------------------------------------------------------------

function readAlarms(): AlarmRecord[] {
  const stored = readJson<AlarmRecord[]>(ALARM_KEY)
  return Array.isArray(stored) ? stored : []
}

function writeAlarms(alarms: AlarmRecord[]): void {
  persist(ALARM_KEY, alarms)
}

export function listAlarms(transformerCode?: string): AlarmRecord[] {
  const alarms = readAlarms()
  if (!transformerCode) {
    return alarms
  }
  return alarms.filter((item) => item['变压器编号'] === transformerCode)
}

/** 追加一条「告警中」日志；同编号已有未复位日志时复用，不重复开。 */
export function appendAlarm(record: Omit<AlarmRecord, 'id'>): AlarmRecord {
  const alarms = readAlarms()
  const open = alarms.find(
    (item) => item['变压器编号'] === record['变压器编号'] && item['结论'] === '告警中',
  )
  if (open) {
    return open
  }
  const id = alarms.reduce((max, item) => Math.max(max, item.id), 0) + 1
  const created: AlarmRecord = { ...record, id }
  alarms.push(created)
  writeAlarms(alarms)
  return created
}

/** 复位闭环：该主变所有「告警中」的日志补上复位时间与处理人，结论改「已复位」。 */
export function closeAlarmsFor(transformerCode: string, operator: string, date: string): void {
  const alarms = readAlarms()
  let changed = false
  for (const alarm of alarms) {
    if (alarm['变压器编号'] === transformerCode && alarm['结论'] === '告警中') {
      alarm['复位时间'] = date
      alarm['处理人'] = operator
      alarm['结论'] = '已复位'
      changed = true
    }
  }
  if (changed) {
    writeAlarms(alarms)
  }
}

export function resetAlarms(): void {
  writeAlarms(clone(SEED_TRANSFORMER_ALARMS))
}

/**
 * 历史告警回填：告警时间按该主变的试验日期落；缺处理人的补「系统补录」。
 * 同「变压器编号 + 告警时间」判重，已经导入过的不再导；游标记录导到哪条，中断续传。
 */
function migrateAlarms(meta: MigrationMeta, transformerRows: EntryRow[]): void {
  const alarms = readAlarms()
  const testDateOf = (code: string): string => {
    const row = transformerRows.find((item) => String(item['变压器编号']) === code)
    return String(row?.['试验日期'] ?? '')
  }
  for (const seed of SEED_TRANSFORMER_ALARMS) {
    if (seed.id <= meta.alarmCursor) {
      continue
    }
    const record: AlarmRecord = { ...seed }
    if (!record['告警时间']) {
      record['告警时间'] = testDateOf(record['变压器编号']) || todayStr()
    }
    if (!record['处理人']) {
      record['处理人'] = LEGACY_HANDLER
    }
    const duplicated = alarms.some(
      (item) => item['变压器编号'] === record['变压器编号'] && item['告警时间'] === record['告警时间'],
    )
    if (!duplicated) {
      alarms.push(record)
    }
    meta.alarmCursor = seed.id
    saveMeta(meta)
  }
  // 明细同台账对齐：台账还在告警态的，日志里必须有一条「告警中」；反之闭环
  let nextId = alarms.reduce((max, item) => Math.max(max, item.id), 0) + 1
  for (const row of transformerRows) {
    const code = String(row['变压器编号'] ?? '')
    if (!code) {
      continue
    }
    const open = alarms.find((item) => item['变压器编号'] === code && item['结论'] === '告警中')
    if (row.status === '告警' && !open) {
      alarms.push({
        id: nextId,
        变压器编号: code,
        告警时间: String(row['试验日期'] ?? '') || todayStr(),
        复位时间: '',
        处理人: LEGACY_HANDLER,
        缺陷编号: '',
        结论: '告警中',
      })
      nextId += 1
    }
    if (row.status !== '告警' && open) {
      open['结论'] = '已复位'
      if (!open['复位时间']) {
        open['复位时间'] = todayStr()
      }
      if (!open['处理人']) {
        open['处理人'] = LEGACY_HANDLER
      }
    }
  }
  writeAlarms(alarms)
}

// ---------------------------------------------------------------------------
// 台账存取
// ---------------------------------------------------------------------------

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  let data = fallback
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    } else {
      try {
        const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
        data = { ...fallback, ...parsed }
      } catch {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
        data = fallback
      }
    }
  }
  const meta = readMeta()
  if (meta.done && meta.version >= CURRENT_DATA_VERSION) {
    return data
  }
  // 迁移中断也没关系：游标已经逐条落盘，下次从断掉的那条接着走
  const migrated = migrateEntries(data, meta)
  migrateAlarms(meta, migrated['transformer'] ?? [])
  meta.version = CURRENT_DATA_VERSION
  meta.done = true
  saveMeta(meta)
  persist(STORAGE_KEY, migrated)
  return migrated
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(STORAGE_KEY, next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  if (key === 'transformer') {
    resetAlarms()
  }
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
