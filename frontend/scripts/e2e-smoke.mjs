// 真实 local-service/local-store（window.localStorage 路径）的端到端冒烟。
// 用内存版 localStorage 垫片跑通：老格式迁移 → 逐级巡视 → 派生只一次 →
// 派发回写 → 台账核对 → 既巡又修拦截 → 全新播种历史补录。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- localStorage / window 垫片 ----
const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
}

let bundleCache = null
async function loadService() {
  if (!bundleCache) {
    const result = await build({
      entryPoints: ['src/api/local-service.ts'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
      define: { 'import.meta.env.MODE': '"test"' },
    })
    bundleCache = result.outputFiles[0].text
  }
  const dir = mkdtempSync(join(tmpdir(), 'patrol-e2e-'))
  const file = join(dir, `service-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, bundleCache)
  // 新模块 URL → 模块级缓存全新初始化，模拟刷新页面后重新 hydrate。
  return import(pathToFileURL(file).href)
}

let passed = 0
let failed = 0
function check(cond, msg) {
  if (cond) passed += 1
  else { failed += 1; console.error('  ✗ ' + msg) }
}

// ===== 场景 A：老版本 localStorage 数据迁移 + 完整业务链路 =====
mem.clear()
mem.set('pv-plant-ops:entries', JSON.stringify({
  patrol: [{
    id: 1, status: '待复核', pending: true, abnormal: false,
    巡视单号: 'P-OLD-1', 巡视路线: '老路线', 巡视人员: '赵清晨',
    巡视日期: '2026-09-10', 检查项数: 10, 异常项数: 2, 巡视时长: '',
  }],
  defect: [],
  crew: [
    { id: 1, 姓名: '赵清晨', 岗位工种: '巡视工' },
    { id: 2, 姓名: '钱多金', 岗位工种: '检修工' },
  ],
}))
{
  const svc = await loadService()
  const list = svc.listEntries('patrol')
  check(list.total === 1, '老数据迁移后可读')
  check(svc.ledgerChecks().length === 0, '待复核未完成老单尚未派生，核对无问题')

  const r = svc.runPatrolAction(1, '确认完成')
  check(r.ok, '确认完成成功：' + r.message)
  check(r.defectNos.length === 2, '派生 2 张：' + JSON.stringify(r.defectNos))
  const detail = svc.patrolDetail(1)
  check(detail.defects.length === 2, '详情面板 2 张（实链）')
  check(detail.patrol.status === '已完成', '状态已完成')

  const again = svc.runPatrolAction(1, '确认完成')
  check(!again.ok && again.code === 'REVIEW_LOCKED', '重复复核锁：' + again.code)
  check(again.defectNos.length === 2, '锁定信息带已派单号')

  const blocked = svc.changeAbnormalCount(1, '钱多金', 1)
  check(!blocked.ok && blocked.code === 'REVIEW_LOCKED', '已派单改异常项数被锁')

  const first = svc.patrolDetail(1).defects[0]
  const dispatch = svc.runDefectAction(Number(first.id), '派发消缺')
  check(dispatch.ok, '派发成功：' + dispatch.message)
  check(/已回写/.test(dispatch.message), '提示已回写台账')
  const detail2 = svc.patrolDetail(1)
  check(detail2.ledger.items[0].state === '已派发', '台账行已派发')
  check(detail2.patrol['待派台账状态'] === '部分已派发', '部分已派发')
  check(svc.ledgerChecks().length === 0, '派发一张后核对仍零问题')

  const source = svc.defectSourcePatrol(Number(svc.patrolDetail(1).defects[1].id))
  check(source.巡视单号 === 'P-OLD-1', '来源巡视单实时解析')

  const raw = JSON.parse(mem.get('pv-plant-ops:entries'))
  check(raw.version === 2 && raw.entries && raw.dispatchLedgers, '整库结构 v2 已持久化')
}

// ===== 场景 B：刷新页面后数据仍一致（新模块实例从 localStorage 再 hydrate） =====
{
  const svc = await loadService()
  const detail = svc.patrolDetail(1)
  check(detail.patrol.status === '已完成', '刷新后仍已完成')
  check(detail.defects.length === 2, '刷新后仍是 2 张不翻倍')
  check(detail.ledger.items[0].state === '已派发', '派发回写刷新后保留')
  check(svc.ledgerChecks().length === 0, '刷新后核对零问题')
}

// ===== 场景 C：全新播种（无 localStorage）→ 历史补录 + 逐级流转 + 既巡又修 =====
mem.clear()
{
  const svc = await loadService()
  const list = svc.listEntries('patrol')
  check(list.items.length === 6, '播种 6 张巡视单')
  const historical = list.items.filter((r) => String(r.status) === '已完成')
  check(historical.length === 2, '2 张历史已完成单')
  check(svc.ledgerChecks().length === 0, '播种库台账零问题')
  for (const row of historical) {
    const detail = svc.patrolDetail(Number(row.id))
    check(detail.defects.length === Number(row.异常项数), `${row.巡视单号} 按巡视日期补录 ${row.异常项数} 张`)
  }

  const skip = svc.runPatrolAction(1, '确认完成')
  check(!skip.ok && skip.code === 'STATUS_SKIP', '跳级拦截：' + skip.code)
  check(svc.runPatrolAction(1, '开始巡视').ok, '开始巡视')
  check(svc.runPatrolAction(1, '提交复核').ok, '提交复核')
  const done = svc.runPatrolAction(1, '确认完成')
  check(done.ok && done.defectNos.length === 0, '0 异常完成、0 派生')

  const dual = svc.changeAbnormalCount(4, '郑检修', 2)
  check(!dual.ok && dual.code === 'DUAL_ROLE_FORBIDDEN', '既巡又修拒绝：' + dual.code)
  const outsider = svc.changeAbnormalCount(2, '赵清晨', 1)
  check(!outsider.ok && outsider.code === 'NOT_ROUTE_PATROLMAN', '非本路线巡视人拒绝')
  const owner = svc.changeAbnormalCount(2, '王启航', 5)
  check(owner.ok, '本路线巡视人可改')
}

console.log(`\n${passed} 项通过，${failed} 项失败`)
process.exit(failed ? 1 : 0)
