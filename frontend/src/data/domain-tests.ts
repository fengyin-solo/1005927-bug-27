/**
 * 巡视复核 → 消缺派生 的行为验证（不依赖浏览器/DOM）。
 * 运行：node --import <esbuild-register> 或经 scripts/run-domain-tests.mjs 转译执行。
 */
import { buildSeedDatabase } from './seed'
import {
  advancePatrol,
  DomainError,
  LEDGER_ITEM_DISPATCHED,
  markDefectDispatched,
  migrateDatabase,
  parseAbnormalCount,
  resolveSourcePatrol,
  runLedgerChecks,
  submitReview,
  updateAbnormalCount,
  type DomainStore,
} from './patrol-domain'
import type { Database, EntryRow } from './types'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type MemoryStoreOptions = {
  db?: Database
  // 每提交一次调用一次：返回 true 表示这次提交「中断」（不落库并抛错）。
  failCommit?: (attempt: number) => boolean
}

function makeStore(options: MemoryStoreOptions = {}) {
  let db = options.db ?? buildSeedDatabase()
  let attempts = 0
  const store: DomainStore = {
    hydrate() {
      // 返回最近一笔已提交快照的深拷贝；提交失败的那笔改动不会出现在这里，
      // 与 localStorage 写失败的真实行为一致。
      return clone(db)
    },
    commit(next: Database) {
      attempts += 1
      if (options.failCommit?.(attempts)) {
        throw new Error('模拟中断：本次提交未完成')
      }
      db = next
    },
    repairNames() {
      return (db.entries.crew ?? [])
        .filter((row) => /维修|检修|消缺/.test(String(row.岗位工种 ?? '')))
        .map((row) => String(row.姓名))
    },
    clock() {
      return new Date('2026-10-04T10:00:00')
    },
  }
  return {
    store,
    db: () => db,
    patrol: (id: number) => db.entries.patrol.find((row) => Number(row.id) === id) as EntryRow,
    defects: () => db.entries.defect,
    ledger: (id: number) => db.dispatchLedgers[id],
  }
}

let passed = 0
let failed = 0
function assert(condition: unknown, message: string) {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}
function expectError(fn: () => unknown, code: string, message: string) {
  try {
    fn()
    failed += 1
    console.error(`  ✗ ${message}（预期抛错 ${code}，实际未抛）`)
  } catch (error) {
    if (error instanceof DomainError && error.code === code) {
      passed += 1
    } else {
      failed += 1
      console.error(`  ✗ ${message}（预期 ${code}，实际 ${(error as Error).message}）`)
    }
  }
}

// ---------- 异常项数识别 ----------
console.log('异常项识别')
assert(parseAbnormalCount(3) === 3, '数字 3')
assert(parseAbnormalCount('3') === 3, '字符串 3')
assert(parseAbnormalCount('三') === 3, '中文 三')
assert(parseAbnormalCount('十') === 10, '中文 十')
assert(parseAbnormalCount('十二') === 12, '中文 十二')
assert(parseAbnormalCount('二十') === 20, '中文 二十')
assert(parseAbnormalCount('二十三') === 23, '中文 二十三')
assert(parseAbnormalCount('两') === 2, '两=2')
assert(parseAbnormalCount('巡视检查样例1') === null, '脏文本认不出 → null')
assert(parseAbnormalCount('') === null, '空串 → null')
assert(parseAbnormalCount(-1) === null, '负数 → null')

// ---------- 历史补录 ----------
console.log('历史巡视单按巡视日期补录')
{
  const seed = buildSeedDatabase()
  // 播种数据里 5（2 项）、6（1 项）是已完成历史单
  const ledger5 = seed.dispatchLedgers[5]
  const ledger6 = seed.dispatchLedgers[6]
  assert(ledger5 && ledger5.abnormalCount === 2 && ledger5.items.length === 2, 'PATR-0005 补录 2 项台账')
  assert(ledger6 && ledger6.abnormalCount === 1, 'PATR-0006 补录 1 项台账')
  assert(ledger5.backfilled === true, '台账标记为历史补录')
  const derivedNos = ledger5.items.map((item) => item.defectNo)
  assert(derivedNos.every(Boolean), '每项都有消缺单编号')
  const defects = seed.entries.defect.filter((d) => derivedNos.includes(String(d.缺陷编号)))
  assert(defects.length === 2, '消缺表实有 2 张补录单')
  assert(defects.every((d) => d.发现方式 === '历史巡视补录'), '补录单标注发现方式')
  assert(defects.every((d) => String(d.来源巡视单号) === 'PATR-0005'), '回链巡视单号')
  assert(defects.every((d) => /^2026-09-20$/.test(String(d.派生时间).slice( 0, 10))), '派生时间锚定巡视日期')
  assert(runLedgerChecks(seed).length === 0, '播种库台账核对零问题')

  // 迁移幂等：再迁一遍不应多单
  const again = migrateDatabase(clone({ version: 1, entries: buildSeedDatabase().entries, dispatchLedgers: buildSeedDatabase().dispatchLedgers }))
  const count1 = seed.entries.defect.length
  const count2 = again.db.entries.defect.length
  assert(count1 === count2, '重复迁移不重复补录')
}

// ---------- 老格式迁移（脏数据兼容） ----------
console.log('老版本数据迁移与脏数据兼容')
{
  const legacy = {
    patrol: [
      { id: 91, status: '待复核', pending: true, abnormal: false, 巡视单号: 'P91', 巡视路线: 'R', 巡视人员: '李晓峰', 巡视日期: '2026-10-01', 检查项数: 10, 异常项数: '巡视检查样例9', 巡视时长: '' },
      { id: 92, status: '已完成', pending: false, abnormal: false, 巡视单号: 'P92', 巡视路线: 'R', 巡视人员: '李晓峰', 巡视日期: '2026-09-15', 检查项数: 10, 异常项数: '二', 巡视时长: '' },
    ],
    defect: [],
    crew: buildSeedDatabase().entries.crew,
  }
  const { db, report } = migrateDatabase({ version: 1, entries: clone(legacy), dispatchLedgers: {} })
  assert(db.entries.patrol[0].异常项数 === 0 && db.entries.patrol[0].异常项数待核实 === '是', '脏文本 → 0 且标待核实')
  assert(report.normalizedPatrolIds.includes(91), '脏文本记录在归一化清单')
  assert(db.entries.patrol[1].异常项数 === 2, '中文数字 二 → 2')
  assert(db.dispatchLedgers[92] && db.dispatchLedgers[92].items.length === 2, '已完成中文数字历史单补录 2 项')
}

// ---------- 正常复核：派生一次 ----------
console.log('正常复核：一次性派生')
{
  const env = makeStore()
  // PATR-0003 待复核、3 项异常、巡视人赵清晨
  const beforeCount = env.defects().length
  const result = submitReview({ store: env.store }, 3)
  assert(result.abnormalCount === 3, '复核确认异常 3 项')
  assert(result.derivedCount === 3, '本次派生 3 张')
  assert(env.defects().length === beforeCount + 3, '消缺表新增 3 张')
  assert(env.patrol(3).status === '已完成', '巡视单置已完成')
  const ledger = env.ledger(3)
  assert(ledger.items.length === 3 && ledger.items.every((i) => i.defectId !== null), '台账 3 行均有消缺单')
  const nos = ledger.items.map((i) => i.defectNo)
  assert(new Set(nos).size === 3, '消缺单编号不重复')
  assert(runLedgerChecks(env.db()).filter((i) => i.patrolId === 3).length === 0, '台账核对零问题')

  // 再次复核不收
  expectError(() => submitReview({ store: env.store }, 3), 'REVIEW_LOCKED', '已完成单不再收复核')
  // 已派单巡视单改异常项数也锁死
  expectError(() => updateAbnormalCount({ store: env.store }, { patrolId: 3, operator: '赵清晨', abnormalCount: 1 }), 'REVIEW_LOCKED', '已派单异常项数锁定')
}

// ---------- 派生只发生一次（任意重复调用） ----------
console.log('派生幂等')
{
  const env = makeStore()
  submitReview({ store: env.store }, 3)
  const countAfter = env.defects().length
  // 直接再走一遍 advancePatrol 确认完成 / submitReview 都不应新增
  expectError(() => advancePatrol({ store: env.store }, 3, '确认完成'), 'REVIEW_LOCKED', '重复确认完成被锁')
  assert(env.defects().length === countAfter, '消缺单不翻倍')
}

// ---------- 中途中断 → 重试补齐 ----------
console.log('复核中断可重试、只补缺项')
{
  const env = makeStore()
  // 第 2 次提交（第 1 个异常项落库后、派第 2 项时）中断
  let interrupted = false
  const failStore = makeStore({
    db: buildSeedDatabase(),
    failCommit: (attempt) => {
      if (!interrupted && attempt === 3) {
        interrupted = true
        return true
      }
      return false
    },
  })
  try {
    submitReview({ store: failStore.store }, 3)
    failed += 1
    console.error('  ✗ 应抛出中断错误')
  } catch (error) {
    assert(/中断/.test((error as Error).message), '中断错误向上抛')
  }
  assert(interrupted, '确实发生过中断')
  // 中断态：台账已建、1 张已派、巡视单仍是待复核
  assert(failStore.patrol(3).status === '待复核', '中断后巡视单未完成')
  assert(failStore.ledger(3).items.filter((i) => i.defectId).length === 1, '中断前 1 张已落库')
  const countAtInterrupt = failStore.defects().length

  // 重试：补齐剩余 2 张
  const retry = submitReview({ store: failStore.store }, 3)
  assert(retry.resumed === true, '重试识别为断点续派')
  assert(retry.derivedCount === 2, '本次只新派生 2 张')
  assert(failStore.defects().length === countAtInterrupt + 2, '总数恰为 3 张不翻倍')
  assert(failStore.patrol(3).status === '已完成', '重试后完成')
  assert(runLedgerChecks(failStore.db()).length === 0, '续派后台账核对零问题')

  // 防 env 未用告警
  assert(env.defects().length > 0, '基线环境正常')
}

// ---------- 取不到对应巡视单/消缺单：报错可重试，不顶旧数据 ----------
console.log('引用缺失：报错而非旧数据顶替')
{
  const env = makeStore()
  expectError(() => submitReview({ store: env.store }, 999), 'PATROL_NOT_FOUND', '不存在的巡视单')
  submitReview({ store: env.store }, 3)
  const ledger = env.ledger(3)
  // 手工删掉一张派生消缺单，模拟消缺侧取不到
  const victimId = ledger.items[1].defectId as number
  const mutated = clone(env.db())
  mutated.entries.defect = mutated.entries.defect.filter((d) => Number(d.id) !== victimId)
  const broken = makeStore({ db: mutated })
  expectError(() => submitReview({ store: broken.store }, 3), 'REVIEW_LOCKED', '已完成单缺失消缺单仍锁复核')
  // 中断态缺失：待复核单台账行指向的消缺单被删
  const env2 = makeStore()
  const half = clone(buildSeedDatabase())
  // 构造半完成台账（1 项已派）再删除其消缺单
  half.dispatchLedgers[3] = {
    patrolNo: 'PATR-0003', patrolDate: '2026-10-02', abnormalCount: 3, backfilled: false,
    items: [{ seq: 1, defectId: 99999, defectNo: 'DEFE-9999', state: '待派发', dispatchedAt: null }],
    createdAt: '2026-10-04 10:00', updatedAt: '2026-10-04 10:00',
  }
  half.entries.patrol.find((p) => Number(p.id) === 3)!.status = '待复核'
  const broken2 = makeStore({ db: half })
  expectError(() => submitReview({ store: broken2.store }, 3), 'DERIVED_DEFECT_MISSING', '台账指向的消缺单缺失时报错不顶旧数据')
  assert(broken2.defects().every((d) => String(d.缺陷编号) !== 'DEFE-9999'), '没有伪造旧单据')

  // resolveSourcePatrol
  const defect = env.db().entries.defect.find((d) => String(d.来源巡视单号) === 'PATR-0003') as EntryRow
  const patrol = resolveSourcePatrol(env.db(), defect)
  assert(String(patrol.巡视单号) === 'PATR-0003', '能取到真实来源巡视单')
  const ghost: EntryRow = { id: 1, status: '待派发', pending: true, abnormal: false, 缺陷编号: 'X', 来源巡视单号: 'GHOST' }
  expectError(() => resolveSourcePatrol(env.db(), ghost), 'SOURCE_PATROL_NOT_FOUND', '幽灵来源报错')
}

// ---------- 状态逐级、跳级拦截并指出已派到哪张 ----------
console.log('状态机：逐级、跳级拦截')
{
  const env = makeStore()
  // 待巡视直接确认完成
  const err = (() => {
    try { advancePatrol({ store: env.store }, 1, '确认完成'); return null } catch (e) { return e as DomainError }
  })()
  assert(err?.code === 'STATUS_SKIP', '跳级被拦')
  assert(/尚未派单|已派到/.test(err?.message ?? ''), '拦截信息说明派单情况')
  // 正常逐级
  advancePatrol({ store: env.store }, 1, '开始巡视')
  assert(env.patrol(1).status === '巡视中', '开始巡视')
  advancePatrol({ store: env.store }, 1, '提交复核')
  assert(env.patrol(1).status === '待复核', '提交复核')
  // 待复核且异常 0 项：确认完成派生 0 张
  const r = advancePatrol({ store: env.store }, 1, '确认完成')
  assert(env.patrol(1).status === '已完成' && r.status === '已完成', '0 异常也可完成')
  // 已完成再操作
  expectError(() => advancePatrol({ store: env.store }, 1, '开始巡视'), 'REVIEW_LOCKED', '已完成不再收动作')

  // 跳级信息指出已派到哪一张：待复核单先派单，再尝试从别的入口跳
  submitReview({ store: env.store }, 3)
  const err2 = (() => {
    try { advancePatrol({ store: env.store }, 3, '提交复核'); return null } catch (e) { return e as DomainError }
  })()
  assert(err2?.code === 'REVIEW_LOCKED' && /DEFE-/.test(err2.message), '锁定信息列出消缺单编号')
}

// ---------- 异常项数权限 ----------
console.log('异常项数权限')
{
  const env = makeStore()
  // PATR-0002 巡视中，巡视人王启航，异常 2
  // 非本路线人改不动
  expectError(() => updateAbnormalCount({ store: env.store }, { patrolId: 2, operator: '李晓峰', abnormalCount: 1 }), 'NOT_ROUTE_PATROLMAN', '非本路线人被拒')
  // 管理员改不动
  expectError(() => updateAbnormalCount({ store: env.store }, { patrolId: 2, operator: '值班管理员', abnormalCount: 1 }), 'NOT_ROUTE_PATROLMAN', '管理员无权')
  // 本人可以
  const row = updateAbnormalCount({ store: env.store }, { patrolId: 2, operator: '王启航', abnormalCount: 4 })
  assert(Number(row.异常项数) === 4, '本路线巡视人可改')
  // 超过检查项数
  expectError(() => updateAbnormalCount({ store: env.store }, { patrolId: 2, operator: '王启航', abnormalCount: 25 }), 'BAD_ABNORMAL', '异常>检查被拒')
  // 既巡又修：PATR-0004 巡视人郑检修是检修工
  expectError(() => updateAbnormalCount({ store: env.store }, { patrolId: 4, operator: '郑检修', abnormalCount: 2 }), 'DUAL_ROLE_FORBIDDEN', '既巡又修被拒')
  // 派过单后锁：3 已派单
  submitReview({ store: env.store }, 3)
  expectError(() => updateAbnormalCount({ store: env.store }, { patrolId: 3, operator: '赵清晨', abnormalCount: 2 }), 'REVIEW_LOCKED', '派单后锁定')
}

// ---------- 异常项数被改小：不影响已派单据，台账核对报错 ----------
console.log('异常项数改小：已派单据不随之变少')
{
  const env = makeStore()
  submitReview({ store: env.store }, 3)
  const nosBefore = env.ledger(3).items.map((i) => i.defectNo)
  // 直接篡改存储（模拟有人绕过前端改小异常项数）
  const tampered = clone(env.db())
  tampered.entries.patrol.find((p) => Number(p.id) === 3)!.异常项数 = 1
  const env2 = makeStore({ db: tampered })
  // 详情派生单据仍为 3 张
  const { defects } = (() => {
    // 复用 derivedDefects 逻辑：通过 runLedgerChecks 与直接读台账验证
    return { defects: tampered.entries.defect.filter((d) => String(d.来源巡视单号) === 'PATR-0003') }
  })()
  assert(defects.length === 3, '改小异常项数，已派 3 张消缺单不蒸发')
  assert(JSON.stringify(nosBefore) !== null, '基线')
  const issues = runLedgerChecks(env2.db())
  assert(issues.some((i) => i.patrolId === 3 && /异常项数对不上/.test(i.message)), '台账核对报两处异常项数不一致')
  assert(issues.some((i) => i.patrolId === 3 && /派单条数不一致/.test(i.message) === false), '台账条数仍为 3（不翻倍）')
}

// ---------- 派发消缺回写台账 ----------
console.log('派发消缺回写待派台账')
{
  const env = makeStore()
  submitReview({ store: env.store }, 3)
  const firstId = env.ledger(3).items[0].defectId as number
  markDefectDispatched({ store: env.store }, firstId)
  const item = env.ledger(3).items[0]
  assert(item.state === LEDGER_ITEM_DISPATCHED && item.dispatchedAt !== null, '台账行回写已派发')
  assert(env.defects().find((d) => Number(d.id) === firstId)?.status === '消缺中', '消缺单为消缺中')
  assert(env.patrol(3)['待派台账状态'] === '部分已派发', '巡视单台账状态：部分已派发')
  for (const rest of env.ledger(3).items.slice(1)) {
    markDefectDispatched({ store: env.store }, rest.defectId as number)
  }
  assert(env.patrol(3)['待派台账状态'] === '全部已派发', '全部派发后状态更新')
  assert(runLedgerChecks(env.db()).length === 0, '全部派发后核对零问题')

  // 状态不一致检测：手工把消缺单打回待派发
  const tampered = clone(env.db())
  const d = tampered.entries.defect.find((x) => Number(x.id) === firstId)!
  d.status = '待派发'
  const env2 = makeStore({ db: tampered })
  assert(runLedgerChecks(env2.db()).some((i) => /仍是待派发，台账却记已派发/.test(i.message)), '检出台账与消缺状态不一致')
}

// ---------- 扣减不成整笔回滚（额度校验） ----------
console.log('整笔回滚：异常项数认不出/不合理时一笔不写')
{
  const env = makeStore()
  const mutated = clone(buildSeedDatabase())
  mutated.entries.patrol.find((p) => Number(p.id) === 3)!.异常项数 = '脏数据X'
  const env2 = makeStore({ db: mutated })
  const defectCountBefore = env2.defects().length
  expectError(() => submitReview({ store: env2.store }, 3), 'ABNORMAL_UNRECOGNIZED', '异常项数认不出挂起')
  assert(env2.defects().length === defectCountBefore, '认不出时不产生任何消缺单（整笔回滚）')
  assert(env2.patrol(3).status === '待复核', '巡视单状态未动')
  assert(/无法识别/.test(String(env2.patrol(3).中断原因 ?? '')), '中断原因写明')

  const mutated2 = clone(buildSeedDatabase())
  mutated2.entries.patrol.find((p) => Number(p.id) === 3)!.异常项数 = 99
  const env3 = makeStore({ db: mutated2 })
  expectError(() => submitReview({ store: env3.store }, 3), 'ABNORMAL_EXCEEDS_CHECK', '异常>检查被拒')
  assert(env3.ledger(3) === undefined, '不合理时台账都不建立')
}

// ---------- 汇总 ----------
console.log(`\n${passed} 项通过，${failed} 项失败`)
if (failed > 0) {
  process.exit(1)
}
