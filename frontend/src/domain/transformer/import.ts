import { CHECKPOINT_KEY, DEDUP_FIELD, evaluateTemperature } from './constants'
import { hashContent, parseCsv, toCsv } from './csv'
import type { ImportCheckpoint, TransformerRow } from './types'

// 导入明细要求的列：缺项的一并报出来，不用旧值顶替。
export const IMPORT_HEADERS = [
  '变压器编号',
  '容量等级',
  '油温',
  '绕组温度',
  '油位',
  '瓦斯保护',
  '试验日期',
  '运行状态',
]

export type ImportOutcome = {
  inserted: number
  updated: number
  skippedRows: number[]
  errors: string[]
  checkpoint?: ImportCheckpoint
  /** 中断时为 false：已经从断掉的那一条之前全部落库，再次调用同文件即续走。 */
  finished: boolean
}

function readCheckpoint(fileHash: string): ImportCheckpoint | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(CHECKPOINT_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as ImportCheckpoint
    return parsed.fileHash === fileHash ? parsed : null
  } catch {
    return null
  }
}

function writeCheckpoint(checkpoint: ImportCheckpoint): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint))
  }
}

function clearCheckpoint(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(CHECKPOINT_KEY)
  }
}

function toNumber(value: string, field: string, rowNo: number, errors: string[]): number {
  const num = Number.parseFloat(value)
  if (!Number.isFinite(num)) {
    errors.push(`第 ${rowNo} 行「${field}」不是有效数值：${value || '（空）'}`)
    return NaN
  }
  return num
}

/**
 * 导入主变明细。去重口径：按「变压器编号」trim 后精确匹配——
 * 编号已存在则更新该编号（并保留其告警历史关联），不存在则新增；文件内重复编号也判重，
 * 同一编号以最后一行为准，前面的计入 skippedRows。
 *
 * 断点续导：按文件内容哈希认检查点，从 processedRows 那条接着走；
 * 换了文件（哈希不同）从头开始。任一行缺项/类型错误即中断，已落库的行不回滚也不重放。
 */
export function importTransformers(
  content: string,
  fileName: string,
  existing: TransformerRow[],
  persist: (rows: TransformerRow[]) => void,
): ImportOutcome {
  const fileHash = hashContent(content)
  const { headers, rows: parsed } = parseCsv(content)

  const missing = IMPORT_HEADERS.filter((header) => !headers.includes(header))
  if (missing.length > 0) {
    return {
      inserted: 0,
      updated: 0,
      skippedRows: [],
      errors: [`导入明细缺少列：${missing.join('、')}`],
      finished: false,
    }
  }

  // 文件内按变压器编号去重：保留每个编号最后一次出现的行。
  const chosen = new Map<string, { index: number; data: Record<string, string> }>()
  parsed.forEach((data, index) => {
    chosen.set(data[DEDUP_FIELD].trim(), { index, data })
  })
  const skippedRows = parsed
    .map((_, index) => index + 2)
    .filter((lineNo, index) => chosen.get(parsed[index][DEDUP_FIELD].trim())?.index !== index)

  const start = readCheckpoint(fileHash)?.processedRows ?? 0
  if (start > parsed.length) {
    clearCheckpoint()
    return importTransformers(content, fileName, existing, persist)
  }

  const outcome: ImportOutcome = {
    inserted: 0,
    updated: 0,
    skippedRows,
    errors: [],
    finished: false,
  }

  let next = [...existing]
  let nextId = next.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)

  for (let index = start; index < parsed.length; index += 1) {
    const data = parsed[index]
    const lineNo = index + 2
    const code = data[DEDUP_FIELD].trim()
    if (chosen.get(code)?.index !== index) {
      // 文件内重复编号的非末行：跳过并落检查点，不算错误。
      checkpoint(index + 1)
      continue
    }
    if (!code) {
      outcome.errors.push(`第 ${lineNo} 行「变压器编号」为空，取数中断`)
      break
    }

    const errors: string[] = []
    const oilTemp = toNumber(data.油温, '油温', lineNo, errors)
    const windingTemp = toNumber(data.绕组温度, '绕组温度', lineNo, errors)
    if (errors.length > 0) {
      outcome.errors.push(...errors)
      break
    }

    const status = data.运行状态 || '运行中'
    const { kinds } = evaluateTemperature(oilTemp, windingTemp)
    // 明细与台账一致性：标了「告警」的行温度必须确有越限，反过来越限行必须挂告警/待试验口径。
    if (status === '告警' && kinds.length === 0) {
      outcome.errors.push(
        `第 ${lineNo} 行状态为告警但油温/绕组温度均未越限，明细与台账口径不一致，取数中断`,
      )
      break
    }
    if (kinds.length > 0 && status === '运行中') {
      outcome.errors.push(
        `第 ${lineNo} 行温度已越限却仍为运行中（应挂告警），明细与台账口径不一致，取数中断`,
      )
      break
    }

    const matchIndex = next.findIndex((row) => String(row.变压器编号).trim() === code)
    const flags: Record<string, boolean> = {}
    kinds.forEach((kind) => {
      flags[kind === '油温越限' ? '油温越限' : '绕组温度越限'] = status === '告警'
    })
    if (matchIndex >= 0) {
      const prev = next[matchIndex]
      const updated: TransformerRow = {
        ...prev,
        容量等级: data.容量等级 || String(prev.容量等级 ?? ''),
        油温: oilTemp,
        绕组温度: windingTemp,
        油位: data.油位 || String(prev.油位 ?? ''),
        瓦斯保护: data.瓦斯保护 || String(prev.瓦斯保护 ?? ''),
        试验日期: data.试验日期 || String(prev.试验日期 ?? ''),
        运行状态: status,
        status,
        pending: status !== '停运',
        abnormal: status === '告警',
      }
      // 更新时先清旧越限标记再按本次温度重打，避免导入把老红标带进来。
      delete (updated as Record<string, unknown>).油温越限
      delete (updated as Record<string, unknown>).绕组温度越限
      Object.assign(updated, flags)
      next[matchIndex] = updated
      outcome.updated += 1
    } else {
      nextId += 1
      next.push({
        id: nextId,
        status,
        pending: status !== '停运',
        abnormal: status === '告警',
        变压器编号: code,
        容量等级: data.容量等级,
        油温: oilTemp,
        绕组温度: windingTemp,
        油位: data.油位,
        瓦斯保护: data.瓦斯保护,
        试验日期: data.试验日期,
        基准油温: Math.min(oilTemp, 80),
        基准绕组温度: Math.min(windingTemp, 100),
        运行状态: status,
        ...flags,
      })
      outcome.inserted += 1
    }

    // 每行落库后更新检查点：中断后从断掉的那一条接着走，不拿旧值顶替。
    persist(next)
    checkpoint(index + 1)
  }

  if (outcome.errors.length === 0) {
    outcome.finished = true
    clearCheckpoint()
  } else {
    persist(next)
  }
  return outcome

  function checkpoint(processedRowsValue: number) {
    const point: ImportCheckpoint = {
      fileHash,
      fileName,
      processedRows: processedRowsValue,
      totalRows: parsed.length,
      updatedAt: new Date().toISOString(),
    }
    writeCheckpoint(point)
    outcome.checkpoint = point
  }
}

export function transformerTemplate(): string {
  return toCsv(IMPORT_HEADERS, [
    ['TRAN-1001', '180MVA', 58, 66, '正常', '投运', '2026-09-30', '运行中'],
  ])
}

export function getImportCheckpoint(): ImportCheckpoint | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(CHECKPOINT_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as ImportCheckpoint
  } catch {
    return null
  }
}
