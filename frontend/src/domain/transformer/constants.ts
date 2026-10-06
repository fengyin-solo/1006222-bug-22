import type { OverLimitKind } from './types'

/**
 * 主变压器温度口径（沿用现场常用限值，新的一版不改写已经在册的缺陷结论）：
 * - 油温上限 85℃，达到即「油温越限」；95℃ 为危急线
 * - 绕组温度上限 105℃，达到即「绕组温度越限」；115℃ 为危急线
 */
export const OIL_LIMIT = 85
export const WINDING_LIMIT = 105
export const OIL_CRITICAL = 95
export const WINDING_CRITICAL = 115

/** 复位/检修回来时温度回落的基线（缺基准数据时用）。 */
export const OIL_BASELINE = 55
export const WINDING_BASELINE = 65

/** 缺陷等级沿用缺陷处置模块在册的三级口径，不改写既有结论。 */
export const DEFECT_LEVELS = {
  critical: '危急缺陷',
  serious: '严重缺陷',
  normal: '一般缺陷',
} as const

/** 告警历史与缺陷编号的前缀，沿用老数据编号风格 DEFE-/ALM-。 */
export const ALARM_CODE_PREFIX = 'ALM-'
export const DEFECT_CODE_PREFIX = 'DEFE-'

/** localStorage 附加存储键（告警历史、导入检查点与数据版本）。 */
export const ALARM_HISTORY_KEY = 'hydropower-plant-om:transformer-alarms'
export const CHECKPOINT_KEY = 'hydropower-plant-om:transformer-import-checkpoint'
export const DATA_VERSION_KEY = 'hydropower-plant-om:data-version'

/** 台账去重字段：变压器编号是现场唯一资产编号，导入/迁移一律按它判重。 */
export const DEDUP_FIELD = '变压器编号' as const

export type TemperatureFlags = {
  oilOver: boolean
  windingOver: boolean
  kinds: OverLimitKind[]
}

export function evaluateTemperature(oilTemp: number, windingTemp: number): TemperatureFlags {
  const oilOver = oilTemp >= OIL_LIMIT
  const windingOver = windingTemp >= WINDING_LIMIT
  const kinds: OverLimitKind[] = []
  if (oilOver) {
    kinds.push('油温越限')
  }
  if (windingOver) {
    kinds.push('绕组温度越限')
  }
  return { oilOver, windingOver, kinds }
}

/** 按温度越限程度给缺陷分级：任一温度达危急线即危急缺陷，仅越限为严重缺陷。 */
export function gradeDefect(kinds: OverLimitKind[], oilTemp: number, windingTemp: number): string {
  const critical =
    kinds.length > 0 && (oilTemp >= OIL_CRITICAL || windingTemp >= WINDING_CRITICAL)
  if (critical) {
    return DEFECT_LEVELS.critical
  }
  if (kinds.length > 0) {
    return DEFECT_LEVELS.serious
  }
  return DEFECT_LEVELS.normal
}

export function padCode(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(4, '0')}`
}
