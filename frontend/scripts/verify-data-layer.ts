// 数据层验证脚本：用 esbuild 打包后在 node 里跑，模拟 localStorage。
// 覆盖：迁移补缺/去重/断点续传、告警发布-复位幂等、缺陷联动、两页口径一致、导出台账一致。
import { listEntries, runAction, loadOverview, exportEntries, listTransformerAlarms } from '@/api/local-service'
import { listRows, resetRows, storageKey } from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'

type Dict = Record<string, string>
const store: Dict = {}
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v)
    },
    removeItem: (k: string) => {
      delete store[k]
    },
  },
}

const { localStorage } = (globalThis as Record<string, unknown>).window as {
  localStorage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void }
}

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}`, extra === undefined ? '' : JSON.stringify(extra))
  }
}

const ENTRIES = storageKey()
const META = 'hydropower-plant-om:meta'
const ALARMS = 'hydropower-plant-om:transformer-alarms'

// ---------- 场景一：老数据迁移（缺项补齐、残留清理、去重、断点续传） ----------
console.log('场景一：老数据迁移')
// 构造 v1 老数据：无越限字段；一台状态运行中但 abnormal=true（残留）；一台告警态缺标记；一条编号重复
const legacy = JSON.parse(JSON.stringify(SEED_ROWS)) as Record<string, Record<string, unknown>[]>
for (const rows of Object.values(legacy)) {
  for (const row of rows) {
    delete row['油温越限']
    delete row['绕组温度越限']
    delete row['告警前油温']
    delete row['告警前绕组温度']
  }
}
legacy.transformer[1].abnormal = true // 复位后残留的异常标记
legacy.transformer[2].status = '告警'
legacy.transformer[2].abnormal = false // 告警态但缺异常标记
legacy.transformer.push({ ...legacy.transformer[0], id: 99 }) // 同编号重复登记
localStorage.setItem(ENTRIES, JSON.stringify(legacy))
// 模拟上次迁移中断：游标停在 transformer 第 1 条（第 1 条上一轮已迁完，字段是齐的）
localStorage.setItem(
  META,
  JSON.stringify({ version: 1, cursor: { transformer: 1 }, alarmCursor: 0, done: false }),
)
const stored = JSON.parse(localStorage.getItem(ENTRIES)!) as Record<string, Record<string, unknown>[]>
stored.transformer[0]['油温越限'] = false
stored.transformer[0]['绕组温度越限'] = false
stored.transformer[0]['告警前油温'] = ''
stored.transformer[0]['告警前绕组温度'] = ''
localStorage.setItem(ENTRIES, JSON.stringify(stored))

const tRows = listRows('transformer')
check('迁移后重复编号被去掉（按变压器编号，保留 id 最小）', tRows.length === 3, tRows.map((r) => r['变压器编号']))
const t1 = tRows.find((r) => r['变压器编号'] === 'TRAN-0001')!
const t2 = tRows.find((r) => r['变压器编号'] === 'TRAN-0002')!
const t3 = tRows.find((r) => r['变压器编号'] === 'TRAN-0003')!
check('缺项补齐：越限标记字段存在', t1['油温越限'] === false && t1['绕组温度越限'] === false)
check('运行中残留异常标记被清掉', t2.abnormal === false && t2['油温越限'] === false)
check('告警态补上越限标记与异常标记', t3.abnormal === true && t3['油温越限'] === true)
check('原有编号不变', [t1.id, t2.id, t3.id].join(',') === '1,2,3')
const meta = JSON.parse(localStorage.getItem(META)!)
check('迁移完成并记录版本', meta.done === true && meta.version === 2, meta)

// 历史告警回填
const alarms = listTransformerAlarms()
check('历史告警已回填', alarms.length >= 2, alarms)
const legacyAlarm = alarms.find((a) => a['变压器编号'] === 'TRAN-0001')
check('早期缺处理人的告警补录为「系统补录」', legacyAlarm?.['处理人'] === '系统补录', legacyAlarm)
check('历史告警时间按试验日期落', legacyAlarm?.['告警时间'] === '2026-09-01')
const openAlarm = alarms.find((a) => a['结论'] === '告警中')
check('台账告警态与日志对齐（TRAN-0003 告警中）', openAlarm?.['变压器编号'] === 'TRAN-0003', alarms)

// 再跑一遍迁移不重不漏（幂等）
const before = localStorage.getItem(ALARMS)
listRows('transformer')
check('告警日志重复读取不重复导入', localStorage.getItem(ALARMS) === before)

// ---------- 场景二：告警复位把痕迹清干净，两处口径一致 ----------
console.log('场景二：告警复位')
const defectBefore = listRows('defect').length
let r = runAction('transformer', 3, '告警复位', '张三')
check('复位成功', r.ok, r)
const after = listRows('transformer').find((x) => x.id === 3)!
check('状态回到运行中', after.status === '运行中')
check('油温越限标记清除', after['油温越限'] === false)
check('绕组温度越限标记清除', after['绕组温度越限'] === false)
check('温度回落到正常口径（老数据无留底，不拿旧值顶替）', after['油温'] === '62' && after['绕组温度'] === '78', after)
check('异常标记清除（概览口径）', after.abnormal === false)
const overview = loadOverview()
const tModule = overview.modules.find((m) => m.name === '主变压器')!
const alarmCount = listRows('transformer').filter((x) => x.abnormal).length
check('列表告警台数与概览异常量一致', tModule.abnormal === alarmCount, { tModule, alarmCount })
const closed = listTransformerAlarms('TRAN-0003').find((a) => a['结论'] === '已复位')
check('撤掉的告警留痕（已复位、有处理人）', closed?.['处理人'] === '张三' && !!closed?.['复位时间'], closed)
const defectRows = listRows('defect')
check('缺陷清单没有丢记录（留痕不删除）', defectRows.length >= defectBefore, defectRows.length)

// 重复复位幂等
const countBefore = listRows('transformer').filter((x) => x.abnormal).length
r = runAction('transformer', 3, '告警复位', '张三')
check('重复复位被拒绝', !r.ok, r)
const countAfter = listRows('transformer').filter((x) => x.abnormal).length
check('台数不会被减两次', countBefore === countAfter, { countBefore, countAfter })

// ---------- 场景三：发布告警联动缺陷清单，再复位闭环 ----------
console.log('场景三：发布告警 → 缺陷开单 → 复位销单')
r = runAction('transformer', 2, '发布告警', '李四')
check('发布告警成功', r.ok, r)
const t2Alarmed = listRows('transformer').find((x) => x.id === 2)!
check('越限标记与温度写入', t2Alarmed['油温越限'] === true && t2Alarmed['油温'] === '96', t2Alarmed)
check('告警前温度留底', t2Alarmed['告警前油温'] === '63')
const newDefect = listRows('defect').find(
  (d) => d['设备名称'] === 'TRAN-0002' && String(d['缺陷描述']).includes('温度越限告警'),
)
check('缺陷清单开出告警单（严重/待处理）', newDefect?.status === '待处理' && newDefect?.['缺陷等级'] === '严重', newDefect)
const openLog = listTransformerAlarms('TRAN-0002').find((a) => a['结论'] === '告警中')
check('告警日志记录缺陷编号', openLog?.['缺陷编号'] === newDefect?.['缺陷编号'], openLog)

// 重复发布不重复开单
const defectCount1 = listRows('defect').length
runAction('transformer', 2, '发布告警', '李四')
check('重复发布不重复开缺陷单', listRows('defect').length === defectCount1)

r = runAction('transformer', 2, '告警复位', '李四')
check('复位成功', r.ok, r)
const resolved = listRows('defect').find((d) => d['缺陷编号'] === newDefect!['缺陷编号'])!
check('缺陷单翻成已消除（留痕）', resolved.status === '已消除' && resolved['处理人员'] === '李四', resolved)
check('缺陷记录仍在清单里', listRows('defect').some((d) => d['缺陷编号'] === newDefect!['缺陷编号']))

// ---------- 场景四：停运检修回来的主变不带旧标记 ----------
console.log('场景四：停运复役清残留')
runAction('transformer', 2, '发布告警', '王五')
runAction('transformer', 2, '停运检修', '王五')
const outage = listRows('transformer').find((x) => x.id === 2)!
check('停运态', outage.status === '停运')
r = runAction('transformer', 2, '提交试验', '王五')
check('复役成功', r.ok, r)
const back = listRows('transformer').find((x) => x.id === 2)!
check('复役后越限标记清空', back['油温越限'] === false && back['绕组温度越限'] === false && back.abnormal === false)
check('复役后温度回落', back['油温'] === '63' && back['绕组温度'] === '79', back)
check('复役后无未闭环告警日志', !listTransformerAlarms('TRAN-0002').some((a) => a['结论'] === '告警中'))
check(
  '复役后无未闭环越限缺陷',
  !listRows('defect').some(
    (d) => d['设备名称'] === 'TRAN-0002' && String(d['缺陷描述']).includes('温度越限告警') && d.status !== '已消除',
  ),
)

// ---------- 场景五：导出清单与台账一致 ----------
console.log('场景五：导出与台账一致')
runAction('transformer', 1, '提交试验', '值班管理员') // 待试验 → 运行中
runAction('transformer', 1, '发布告警', '值班管理员')
const csv = exportEntries('transformer')
const lines = csv.content.split('\n')
check('导出带异常标记列', lines[0].endsWith('异常标记'), lines[0])
const row1 = lines.find((l) => l.includes('TRAN-0001'))!
check('告警台导出为异常', row1.endsWith('异常'), row1)
const row2 = lines.find((l) => l.includes('TRAN-0002'))!
check('正常台导出为正常', row2.endsWith('正常'), row2)
const overview2 = loadOverview()
const tModule2 = overview2.modules.find((m) => m.name === '主变压器')!
check('概览异常量与台账一致', tModule2.abnormal === listRows('transformer').filter((x) => x.abnormal).length)

// ---------- 场景六：重置回到种子 ----------
console.log('场景六：重置')
resetRows('transformer')
const seeded = listRows('transformer')
check('重置后回到种子三台', seeded.length === 3)
check('重置后告警日志回到种子', listTransformerAlarms().length === 2, listTransformerAlarms())

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
