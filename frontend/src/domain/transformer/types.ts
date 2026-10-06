import type { EntryRow } from '@/data/types'

/**
 * 主变压器领域模型。
 *
 * 列表、详情面板、概览、导出清单都从同一份台账（local-store 的 entries.transformer）派生，
 * 任何写操作只允许经 service 落库，页面不自己改字段——避免「状态回了、标记没回」这种残留。
 */

/** 温度越限类型：油温、绕组温度分别打标，复位时一起清除。 */
export type OverLimitKind = '油温越限' | '绕组温度越限'

/** 告警历史的一条记录：发布告警留痕，告警复位只把状态置为「已复位」，记录不删除。 */
export type TransformerAlarm = {
  /** 告警记录编号，告警历史内唯一，迁移老数据时沿用原有编号区间。 */
  id: number
  /** 关联的主变台账记录 id。 */
  transformerId: number
  /** 冗余一份变压器编号，历史记录在台账缺项时仍可辨识。 */
  transformerCode: string
  /** 告警发布时间（ISO 字符串）。历史数据只有告警时间时按试验日期回填到当天。 */
  alarmTime: string
  /** 发布时的油温/绕组温度快照，留痕用，不随后续复位改动。 */
  oilTemp: number
  windingTemp: number
  /** 本次告警命中的越限项。 */
  kinds: OverLimitKind[]
  /** 发布人。早期数据没有发布人时留空。 */
  publisher: string
  /** 告警时生成的设备缺陷编号，便于在缺陷清单里对上同一条。 */
  defectCode: string
  state: '活动' | '已复位'
  /** 复位时间：早期记录按试验日期回填；没有则为空。 */
  resetTime: string
  /**
   * 处理人：早期只有告警时间、没有处理人的记录一律留空，列表与详情统一显示「待补录」，
   * 由值班人员在详情面板里补录，系统不伪造实名。
   */
  handler: string
  /** 记录来源：正常操作 / 老数据迁移回填。 */
  source: '操作' | '历史回填'
}

/** 变压器台账行：在通用 EntryRow 之外补充主变专用字段，全部随同一份存储持久化。 */
export type TransformerRow = EntryRow & {
  变压器编号: string
  容量等级: string
  /** 当前油温（℃，数值存储，展示时带单位）。 */
  油温: number
  绕组温度: number
  油位: string
  瓦斯保护: string
  试验日期: string
  /** 上次正常试验时的油温，复位/检修回来时回落到该值；缺省回落基线。 */
  基准油温: number
  基准绕组温度: number
  /** 兼容旧导出列「运行状态」：与 status 同步。 */
  运行状态: string
}

/** 缺陷行：通用字段之外补充与告警记录的关联。 */
export type DefectRow = EntryRow & {
  缺陷编号: string
  设备名称: string
  缺陷描述: string
  缺陷等级: string
  发现日期: string
  处理期限: string
  处理人员: string
  缺陷状态: string
  /** 由告警联动生成的缺陷才带关联编号；人工登记的缺陷为空，复位不动它们。 */
  来源告警?: string
}

/** 导入检查点：取数中断后从断掉的那一条接着走，不重放已成功行、不拿旧值顶替。 */
export type ImportCheckpoint = {
  /** 导入文件内容的哈希：同内容续传才认这个检查点。 */
  fileHash: string
  fileName: string
  /** 已成功写入的行数（含新增与更新），续传从该行索引继续。 */
  processedRows: number
  totalRows: number
  updatedAt: string
}
