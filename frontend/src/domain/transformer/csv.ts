/**
 * 极简 CSV 解析/序列化：支持引号包裹与转义（""），首行为表头。
 * 导入的明细要同台账一致，解析后按表头对字段，缺列直接报缺项，不拿旧值顶替。
 */

export type ParsedSheet = {
  headers: string[]
  rows: Record<string, string>[]
}

export function parseCsv(text: string): ParsedSheet {
  const content = text.replace(/^﻿/, '')
  const records = splitRecords(content)
  if (records.length === 0) {
    return { headers: [], rows: [] }
  }
  const headers = records[0].map((cell) => cell.trim())
  const rows = records.slice(1).map((cells) => {
    const row: Record<string, string> = {}
    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? '').trim()
    })
    return row
  })
  return { headers, rows }
}

function splitRecords(content: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i]
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && content[i + 1] === '\n') {
        i += 1
      }
      record.push(field)
      field = ''
      if (record.some((cell) => cell.trim() !== '')) {
        records.push(record)
      }
      record = []
    } else {
      field += char
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    if (record.some((cell) => cell.trim() !== '')) {
      records.push(record)
    }
  }
  return records
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const escape = (value: string | number) => {
    const text = String(value ?? '')
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [headers.map(escape).join(',')]
  for (const row of rows) {
    lines.push(row.map(escape).join(','))
  }
  return `﻿${lines.join('\n')}`
}

/** 简易内容哈希（djb2）：只用于检查点匹配「是否同一份文件」，不做安全用途。 */
export function hashContent(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i += 1) {
    hash = (hash * 33 + content.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
