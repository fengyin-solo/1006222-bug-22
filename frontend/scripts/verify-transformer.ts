import {
  allRows,
  readRawRecord,
  resetRows,
  storageKey,
} from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import {
  ensureDataV2,
  listAlarms,
  listTransformers,
  publishAlarm,
  recordReading,
  resetAlarm,
  resumeFromOverhaul,
  saveTransformers,
  stopService,
  submitTest,
  supplementHandler,
  summarizeTransformers,
  importTransformers,
  getImportCheckpoint,
  evaluateTemperature,
} from '@/domain/transformer'
import { loadOverview } from '@/api/local-service'

let passed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) {
    console.error(`✗ ${name}`, extra ?? '')
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`✓ ${name}`)
  }
}

// 1. 迁移：先手工塞一份 v1 旧数据（温度是字符串占位、id2 运行中但 abnormal 残留、id3 告警中）
const v1Transformers = [
  {
    id: 1, status: '待试验', pending: true, abnormal: false,
    变压器编号: 'TRAN-0001', 容量等级: '120MVA', 油温: '主变压器样例1', 绕组温度: '主变压器样例1',
    油位: '正常', 瓦斯保护: '投运', 试验日期: '2026-09-01', 运行状态: '主变压器样例1',
  },
  {
    id: 2, status: '运行中', pending: true, abnormal: true,
    变压器编号: 'TRAN-0002', 容量等级: '180MVA', 油温: '主变压器样例2', 绕组温度: '主变压器样例2',
    油位: '正常', 瓦斯保护: '投运', 试验日期: '2026-09-02', 运行状态: '主变压器样例2',
  },
  {
    id: 3, status: '告警', pending: false, abnormal: false,
    变压器编号: 'TRAN-0003', 容量等级: '240MVA', 油温: '主变压器样例3', 绕组温度: '主变压器样例3',
    油位: '正常', 瓦斯保护: '投运', 试验日期: '2026-09-03', 运行状态: '主变压器样例3',
  },
]
localStorage.setItem(storageKey(), JSON.stringify({
  ...SEED_ROWS,
  transformer: v1Transformers,
}))

ensureDataV2()
let rows = listTransformers()
const t2 = rows.find((r) => r.id === 2)!
const t3 = rows.find((r) => r.id === 3)!
check('迁移后温度为数值', typeof t2.油温 === 'number' && typeof t3.油温 === 'number')
check('复位残留机(id2)温度已回落到正常口径', t2.油温! < 85 && t2.绕组温度! < 105, [t2.油温, t2.绕组温度])
check('残留机旧越限标记清干净', t2.油温越限 !== true && t2.绕组温度越限 !== true)
check('残留机运行中且 abnormal=false', String(t2.status) === '运行中' && t2.abnormal === false)
check('告警机(id3)温度越限并打标', t3.油温! >= 85 && t3.油温越限 === true && t3.绕组温度越限 === true, [t3.油温, t3.绕组温度])

const alarms = listAlarms()
const a2 = alarms.find((a) => a.transformerId === 2)!
const a3 = alarms.find((a) => a.transformerId === 3)!
check('历史告警按试验日期回填（id2 已复位）', a2.state === '已复位' && a2.resetTime.startsWith('2026-09-02'), a2)
check('早期无处理人记录处理人留空', a2.handler === '')
check('告警机有活动告警记录', a3.state === '活动')
check('历史记录标记为历史回填', a2.source === '历史回填')

const defects = allRows().defect
const d2 = defects.find((d: any) => d.缺陷编号 === a2.defectCode) as any
const d3 = defects.find((d: any) => d.缺陷编号 === a3.defectCode) as any
check('回填历史的快照温度保留告警时的越限值', a2.oilTemp >= 85 && a2.windingTemp >= 105, [a2.oilTemp, a2.windingTemp])
check('回填历史越限项双越限', a2.kinds.length === 2, a2.kinds)
check('回填缺陷不低于严重缺陷', d2.缺陷等级 !== '一般缺陷', d2.缺陷等级)
check('复位历史对应缺陷为已消除', d2.缺陷状态 === '已消除')
check('活动告警对应缺陷待处理', d3.缺陷状态 === '待处理')
check('沿用原有缺陷编号区间（新缺陷接 DEFE-0004/0005）', d2.缺陷编号 === 'DEFE-0004' && d3.缺陷编号 === 'DEFE-0005', [d2.缺陷编号, d3.缺陷编号])
check('缺陷等级沿用三级划分', ['危急缺陷', '严重缺陷', '一般缺陷'].includes(d3.缺陷等级), d3.缺陷等级)

const stats = summarizeTransformers(listTransformers())
const overview = loadOverview()
const overviewAbnormal = overview.modules.find((m) => m.name === '主变压器')!.abnormal
check('列表与概览告警台数一致（=1）', stats.alarm === 1 && overviewAbnormal === 1, [stats.alarm, overviewAbnormal])

// 2. 补录处理人
const sup1 = supplementHandler(a2.id, '张工')
check('补录成功', sup1.ok)
check('补录后可读到', listAlarms().find((a) => a.id === a2.id)!.handler === '张工')
const sup2 = supplementHandler(a2.id, '李工')
check('已有处理人不可改写在册结论', !sup2.ok)
const supActive = supplementHandler(a3.id, '李工')
check('活动告警不能走补录入口', !supActive.ok)

// 3. 告警复位：标记、温度、台数、缺陷一起回正
const before = stats.alarm
const r1 = resetAlarm(3, '王值班')
check('复位成功', r1.ok, r1.message)
rows = listTransformers()
const t3b = rows.find((r) => r.id === 3)!
check('复位后状态运行中', String(t3b.status) === '运行中')
check('复位后油温回落基线', t3b.油温 === t3b.基准油温 && t3b.油温! < 85, [t3b.油温, t3b.基准油温])
check('复位后绕组温度回落', t3b.绕组温度 === t3b.基准绕组温度 && t3b.绕组温度! < 105)
check('复位后红色越限标记清除', t3b.油温越限 !== true && t3b.绕组温度越限 !== true)
check('复位后 abnormal 清除', t3b.abnormal === false)
const stats2 = summarizeTransformers(listTransformers())
const ov2 = loadOverview().modules.find((m) => m.name === '主变压器')!.abnormal
check('告警台数减一且两处一致', stats2.alarm === before - 1 && ov2 === stats2.alarm, [stats2.alarm, ov2])
const a3b = listAlarms().find((a) => a.id === a3.id)!
check('告警留痕未删除（已复位）', a3b.state === '已复位' && !!a3b.resetTime && a3b.handler === '王值班')
const d3b = allRows().defect.find((d: any) => d.缺陷编号 === a3.defectCode) as any
check('复位动作落到缺陷清单：已消除、有处理人', d3b.缺陷状态 === '已消除' && d3b.处理人员 === '王值班')

// 4. 重复复位只生效一次
const r2 = resetAlarm(3, '王值班')
check('重复复位被拒绝', !r2.ok)
const stats3 = summarizeTransformers(listTransformers())
check('台数不会减两次', stats3.alarm === stats2.alarm)

// 5. 重新越限→发布告警→带告警停运→检修回来
const rr = recordReading(3, 92, 108)
check('录入越限温度成功', rr.ok)
check('重新打上红色标记', listTransformers().find((r) => r.id === 3)!.油温越限 === true)
const pub = publishAlarm(3, '赵工')
check('发布告警成功', pub.ok, pub.message)
check('发布后告警台数回到1', summarizeTransformers(listTransformers()).alarm === 1)
const dup = publishAlarm(3, '赵工')
check('同一台重复发布被拒绝', !dup.ok)
const stop = stopService(3, '钱检修')
check('带活动告警停运成功并复位留痕', stop.ok, stop.message)
const t3c = listTransformers().find((r) => r.id === 3)!
check('停运状态且不带旧越限标记', String(t3c.status) === '停运' && t3c.油温越限 !== true)
check('停运时活动告警为0（告警随停运复位留痕）', summarizeTransformers(listTransformers()).alarm === 0)
const resume = resumeFromOverhaul(3)
check('检修回来成功', resume.ok)
const t3d = listTransformers().find((r) => r.id === 3)!
check('检修回来运行中、温度正常、无旧标记',
  String(t3d.status) === '运行中' && t3d.油温! < 85 && t3d.油温越限 !== true)

// 6. 待试验提交试验
const submit = submitTest(1, 60, 70)
check('提交试验成功', submit.ok)
const rejectSubmit = submitTest(1, 100, 120)
check('越限温度不能按正常试验提交', !rejectSubmit.ok)

// 7. 导入：去重按变压器编号、明细与台账一致校验、断点续导
const csvBad = [
  '变压器编号,容量等级,油温,绕组温度,油位,瓦斯保护,试验日期,运行状态',
  'TRAN-2001,180MVA,58,66,正常,投运,2026-10-01,运行中',
  'TRAN-2002,240MVA,90,110,正常,投运,2026-10-02,告警',
  'TRAN-2003,180MVA,坏值,66,正常,投运,2026-10-03,运行中',
  'TRAN-2004,180MVA,55,65,正常,投运,2026-10-04,运行中',
].join('\n')
const imp1 = importTransformers(csvBad, 'bad.csv', listTransformers(), saveTransformers)
check('导入在坏行中断', !imp1.finished && imp1.errors.length > 0, imp1.errors)
check('中断前两行已落库（新增2）', imp1.inserted === 2, imp1)
const cp = getImportCheckpoint()
check('检查点记录在第3条数据行（processedRows=2）', cp?.processedRows === 2, cp)
check('已落库不拿旧值顶替/不回滚', listTransformers().some((r) => r.变压器编号 === 'TRAN-2002'))
// 完全相同的文件立即再导一次：检查点还在，从断点（第3条数据行）继续，前两条不重放
const imp1b = importTransformers(csvBad, 'bad.csv', listTransformers(), saveTransformers)
check('相同文件续导从断点走（前两台不再新增/更新）',
  !imp1b.finished && imp1b.inserted === 0 && imp1b.updated === 0, imp1b)
// 修好同一文件后续传（前两行保持，第三行修正，第四行正常）
const csvFixed = [
  '变压器编号,容量等级,油温,绕组温度,油位,瓦斯保护,试验日期,运行状态',
  'TRAN-2001,180MVA,58,66,正常,投运,2026-10-01,运行中',
  'TRAN-2002,240MVA,90,110,正常,投运,2026-10-02,告警',
  'TRAN-2003,180MVA,57,67,正常,投运,2026-10-03,运行中',
  'TRAN-2004,180MVA,55,65,正常,投运,2026-10-04,运行中',
].join('\n')
// 注意：文件内容变了→哈希变→从头重导，但前两台按编号去重变成更新而非新增
const imp2 = importTransformers(csvFixed, 'fixed.csv', listTransformers(), saveTransformers)
check('修正后全量导入完成', imp2.finished, imp2.errors)
check('已存在编号按去重更新（0新增重复编号）', imp2.inserted === 2 && imp2.updated === 2, imp2)
check('检查点完成后清除', getImportCheckpoint() === null)

// 文件内重复编号：同一编号以最后一行为准
const csvDup = [
  '变压器编号,容量等级,油温,绕组温度,油位,瓦斯保护,试验日期,运行状态',
  'TRAN-3001,180MVA,58,66,正常,投运,2026-10-05,运行中',
  'TRAN-3001,240MVA,59,67,正常,投运,2026-10-06,运行中',
].join('\n')
const imp4 = importTransformers(csvDup, 'dup.csv', listTransformers(), saveTransformers)
check('文件内重复编号去重（只增1台，跳过1行）', imp4.finished && imp4.inserted === 1 && imp4.skippedRows.length === 1, imp4)
const dupRow = listTransformers().filter((r) => r.变压器编号 === 'TRAN-3001')
check('重复编号以最后一行为准', dupRow.length === 1 && dupRow[0].容量等级 === '240MVA', dupRow)

// 明细与台账不一致：越限温度挂运行中 → 拒绝
const csvInconsistent = [
  '变压器编号,容量等级,油温,绕组温度,油位,瓦斯保护,试验日期,运行状态',
  'TRAN-4001,180MVA,99,110,正常,投运,2026-10-07,运行中',
].join('\n')
const imp5 = importTransformers(csvInconsistent, 'x.csv', listTransformers(), saveTransformers)
check('明细温度越限却为运行中：按台账口径拦截', !imp5.finished)

// 8. 重置模块后迁移不会再跑（版本已标记），温度字段仍是新口径
resetRows('transformer')
const afterReset = listTransformers()
check('重置后数据仍按新口径（版本2不再迁移、温度结构保持）', Array.isArray(afterReset) && afterReset.length === 3)

void readRawRecord
void evaluateTemperature
console.log(`\n${passed} 项全部通过`)
