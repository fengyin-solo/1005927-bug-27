/* eslint-disable */
// 巡视复核派单领域规则验证（由 verify-patrol.mjs 用 esbuild 打包后运行）。
// localStorage 用内存桩模拟，每组用例从种子重新播种。
import { resetRows, listRows, saveRows, mergeSeed } from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import {
  backfillHistoricalPatrols,
  checkDispatchLedgers,
  ledgerOf,
  parseCount,
  retryDefectLinkage,
  runPatrolAction,
  updateAbnormalCount,
} from '@/api/patrol-review'
import { runAction, setOperator } from '@/api/local-service'

let failed = 0
function assert(cond: boolean, message: string) {
  if (!cond) {
    failed += 1
    console.error('  ✗ ' + message)
    throw new Error(message)
  }
  console.log('  ✓ ' + message)
}

function freshStore() {
  const mem = new Map<string, string>()
  ;(globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => mem.set(k, String(v)),
      removeItem: (k: string) => mem.delete(k),
    },
  }
  // 重新播种前清掉模块级缓存：直接改 storage 模块内部状态不优雅，借 resetRows 隐式重建。
  resetRows('patrol')
  resetRows('defect')
  resetRows('crew')
}

const groups: [string, () => void][] = []
function group(name: string, fn: () => void) {
  groups.push([name, fn])
}
const okResult = (r: { ok: boolean }) => r && r.ok === true

// 1. 正常复核派单：异常项、巡视状态、消缺单同事务派生，且只派生一次
group('复核派单派生且幂等', () => {
  freshStore()
  let r = runPatrolAction(4, '复核派单', '周敏')
  assert(okResult(r), '周敏复核 PATR-0004 派单成功：' + r.message)
  const patrol = listRows('patrol').find((x) => x.id === 4)!
  assert(patrol.status === '已完成', '巡视状态变为已完成')
  assert(patrol['待派异常项数'] === 0, '待派异常项数扣减为 0')
  assert(ledgerOf(patrol).length === 3, '待派台账 3 条')
  const derived = listRows('defect').filter((d) => d['来源巡视单号'] === 'PATR-0004')
  assert(derived.length === 3 && derived.every((d) => d.status === '待派发'), '消缺侧待派台账多出 3 张待派发消缺单')
  assert(derived.every((d) => d['发现方式'] === '巡视检查'), '派生单发现方式为巡视检查')
  r = runPatrolAction(4, '复核派单', '周敏')
  assert(!r.ok && r.message.includes('已派到'), '已派单后不再收复核，并指出已派到哪一张：' + r.message)
  assert(listRows('defect').filter((d) => d['来源巡视单号'] === 'PATR-0004').length === 3, '重复操作不翻倍，仍是 3 张')
  const check = checkDispatchLedgers()
  assert(check.mismatches.length === 0, '对账无差异（派单条数=台账=异常项数）')
})

// 2. 跳级操作拦截
group('跳级拦截', () => {
  freshStore()
  let r = runPatrolAction(1, '复核派单', '王强')
  assert(!r.ok && r.message.includes('跳级'), '待巡视直接复核派单被拦：' + r.message)
  r = runPatrolAction(1, '提交复核', '王强')
  assert(!r.ok && r.message.includes('跳级'), '待巡视直接提交复核被拦：' + r.message)
})

// 3. 本路线巡视人 + 既巡又修
group('权限校验', () => {
  freshStore()
  let r = runPatrolAction(4, '复核派单', '王强')
  assert(!r.ok && r.message.includes('本路线巡视人'), '非本路线巡视人不能复核派单：' + r.message)
  r = updateAbnormalCount(2, 5, '王强')
  assert(!r.ok && r.message.includes('本路线巡视人'), '异常项数只有本路线巡视人能改：' + r.message)
  r = runPatrolAction(3, '提交复核', '赵六')
  assert(!r.ok && r.message.includes('既参与巡视又承担消缺'), '既巡又修的赵六提交复核被拒：' + r.message)
})

// 4. 异常项数派单后锁死；改小后整笔回滚（模拟"有人改小"）
group('扣减不成整笔回滚', () => {
  freshStore()
  assert(okResult(runPatrolAction(4, '复核派单', '周敏')), '先正常派单')
  const r1 = updateAbnormalCount(4, 1, '周敏')
  assert(!r1.ok && r1.message.includes('锁定'), '派过单后异常项数锁定：' + r1.message)
  const tampered = listRows('patrol').map((x) => (x.id === 4 ? { ...x, 异常项数: 1 } : x))
  saveRows('patrol', tampered)
  const defectsBefore = listRows('defect').length
  const r = runPatrolAction(4, '复核派单', '周敏')
  assert(!r.ok && r.message.includes('整笔回滚'), '已派 3 张、项数被改小为 1 时整笔回滚：' + r.message)
  assert(listRows('defect').length === defectsBefore, '回滚后没有新增任何消缺单')
  const p = listRows('patrol').find((x) => x.id === 4)!
  assert(ledgerOf(p).length === 3 && p.status === '已完成', '台账与状态维持派单后的原样')
})

// 5. 中断续派：只补缺的那一项
group('中断重试补齐未派项', () => {
  freshStore()
  const before = listRows('defect').length
  const r = runPatrolAction(5, '复核派单', '孙杰')
  assert(okResult(r), '中断单重试成功，补齐第 3 项：' + r.message)
  const patrol = listRows('patrol').find((x) => x.id === 5)!
  assert(ledgerOf(patrol).length === 3, '台账补齐为 3 条')
  assert(patrol.status === '已完成' && patrol['待派异常项数'] === 0, '巡视单完成、待派清零')
  assert(listRows('defect').length === before + 1, '只新增缺的 1 张，前两张不重复派生')
  const third = listRows('defect').find((d) => d['来源巡视单号'] === 'PATR-0005' && d['来源项次'] === 3)
  assert(!!third && third.status === '待派发', '第 3 项消缺单已补派')
})

// 6. 断流消缺单：取不到巡视单不顶旧数据，巡视单补回后可重试
group('断流单重试关联', () => {
  freshStore()
  let r = retryDefectLinkage(7)
  assert(!r.ok && r.message.includes('不会顶替旧数据'), '取不到 PATR-9999 时拒绝并保留：' + r.message)
  const still = listRows('defect').find((x) => x.id === 7)!
  assert(still['缺陷类别'] === '巡视发现缺陷' && still['来源巡视单号'] === 'PATR-9999', '业务数据未被旧数据顶替')
  assert(still['关联状态'] === '关联失败' && !!still['关联失败原因'], '写明取不到的原因')
  saveRows('patrol', [...listRows('patrol'), {
    id: 9999, status: '待复核', pending: true, abnormal: false,
    巡视单号: 'PATR-9999', 巡视路线: '补录路线', 巡视人员: '系统', 巡视日期: '2026-09-29',
    检查项数: 10, 异常项数: 1, 待派异常项数: 1, 巡视时长: '', 巡视状态: '待复核',
  }])
  r = retryDefectLinkage(7)
  assert(okResult(r), '巡视单补回后重试关联成功：' + r.message)
  const linked = listRows('defect').find((x) => x.id === 7)!
  assert(linked['关联状态'] === '已关联' && linked.abnormal === false, '关联恢复、异常标记清除')
  const p9999 = listRows('patrol').find((x) => x.id === 9999)!
  assert(ledgerOf(p9999).length === 1 && ledgerOf(p9999)[0].缺陷编号 === 'DEFE-0007', '台账回写成功')
})

// 7. 历史补录：按巡视日期从早到晚，已派过的不动
group('历史巡视单补录', () => {
  freshStore()
  const rs = backfillHistoricalPatrols()
  console.log('    补录返回：' + rs.map((x) => x.message).join(' | '))
  const patrols = listRows('patrol')
  const p6 = patrols.find((x) => x.id === 6)!
  const p7 = patrols.find((x) => x.id === 7)!
  const p8 = patrols.find((x) => x.id === 8)!
  const p9 = patrols.find((x) => x.id === 9)!
  assert(p6.status === '已完成' && ledgerOf(p6).length === 2, '9/15 已完成异常 2 项补派 2 张')
  assert(p7.status === '已完成' && ledgerOf(p7).length === 0, '9/18 无异常单补盖完成不造单')
  assert(ledgerOf(p8).length === 1 && ledgerOf(p8)[0].缺陷编号 === 'DEFE-0006', '9/28 已派单不重复派生')
  assert(p9.status === '已完成' && ledgerOf(p9).length === 1, '9/20 待复核遗留单补派完成')
  const codes = ledgerOf(p6).map((i) => i.缺陷编号).concat(ledgerOf(p9).map((i) => i.缺陷编号))
  assert(new Set(codes).size === codes.length && !codes.includes('DEFE-0006'), '补录单号不撞号')
  assert(rs.every((x) => x.ok), '补录全部成功')
  assert(backfillHistoricalPatrols().length === 0, '补录幂等，第二轮无动作')
})

// 8. 状态回写：消缺单派发后台账同步
group('消缺状态回写台账', () => {
  freshStore()
  assert(okResult(runPatrolAction(4, '复核派单', '周敏')), '派单')
  const firstId = listRows('defect').find((d) => d['来源巡视单号'] === 'PATR-0004')!.id
  setOperator('周敏')
  const r = runAction('defect', firstId, '派发消缺')
  assert(okResult(r), '消缺单派发：' + r.message)
  const item = ledgerOf(listRows('patrol').find((x) => x.id === 4)!).find((i) => i.缺陷ID === firstId)!
  assert(item.状态 === '消缺中', '台账状态同步回写为消缺中')
})

// 9. 异常项数宽容辨认
group('异常项数宽容辨认', () => {
  assert(parseCount('3项') === 3, '「3项」认成 3')
  assert(parseCount('') === 0, '空值认成 0')
  assert(parseCount('样例数据') === 0, '纯文字认成 0（兼容旧脏数据）')
  assert(parseCount(99, 30) === 30, '超过检查项数钳到上限')
  assert(parseCount(-2) === 0, '负数钳到 0')
})

// 10. 旧版本 localStorage 升级：本地改动保留，种子新字段补齐
group('旧数据升级合并', () => {
  const legacy = {
    patrol: [{
      id: 2, status: '巡视中', pending: true, abnormal: false,
      巡视单号: 'PATR-0002', 巡视路线: '用户改过的路线', 巡视人员: '巡视检查样例2',
      巡视日期: '2026-09-02', 检查项数: '巡视检查样例2', 异常项数: '巡视检查样例2',
      巡视时长: '巡视检查样例2', 巡视状态: '巡视检查样例2',
    }],
    crew: [],
  }
  const merged = mergeSeed(SEED_ROWS, legacy as any)
  const patrol2 = merged.patrol.find((x) => x.id === 2)!
  assert(patrol2['巡视路线'] === '用户改过的路线', '本地改动保留')
  assert(patrol2['巡视人员'] === '李娜', '种子新字段（真实巡视人）补齐')
  assert(parseCount(patrol2['异常项数']) === 2, '占位脏值让位后取种子真实异常项数（2）')
  assert(parseCount(patrol2['检查项数']) === 28, '检查项数同样升级为真实值')
  assert(merged.crew.some((x) => x['姓名'] === '周敏'), '新种子模块（人员档案）正常加载')
  assert(merged.patrol.some((x) => x.id === 4), '本地缺失的种子巡视单补回')
})

for (const [name, fn] of groups) {
  console.log('\n● ' + name)
  try {
    await fn()
  } catch {
    // 断言失败已计数
  }
}
console.log('')
if (failed) {
  console.error(`存在 ${failed} 个失败用例`)
  process.exit(1)
}
console.log('全部用例通过')
