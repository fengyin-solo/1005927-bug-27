/**
 * 巡视复核 → 消缺派生 领域逻辑。
 *
 * 设计要点（对应业务诉求）：
 * 1. 巡视状态、异常项数、派生出的消缺单、消缺侧待派台账同处一份 Database 快照，
 *    每次提交整体持久化；派生前置校验不通过则一笔不写，等同整笔回滚。
 * 2. 派生按异常项序号幂等：同一项异常永远只派生一张消缺单，重复复核不会翻倍。
 *    复核中途中断后重试，只补还没派单的那一项；台账/消缺对不上时给出明确原因，
 *    不会沉默停在半路。
 * 3. 已派过单（台账已建立）的巡视单不再收异常项数改动；状态只能按
 *    待巡视→巡视中→待复核→已完成 逐级走，跳级直接拦下并指出已派到哪一张。
 * 4. 异常项数只有本路线巡视人能改；巡视人若同时在册维修岗位（既巡又修）则不收。
 * 5. 派生结果回写消缺侧待派台账，两处异常项数必须对得上，派单条数与台账逐项核对。
 * 6. 异常项怎么认：阿拉伯数字、纯数字串、中文简写数字（如「三」）都认得；
 *    认不出的脏数据按 0 处理并挂「待核实」，兼容既有巡视记录，绝不抛异常。
 * 7. 历史的巡视单按巡视日期补录：已完成历史单一次性补齐台账与消缺单。
 */

import type {
  Database,
  DispatchLedger,
  DispatchLedgerItem,
  EntryRow,
  FieldValue,
  LedgerIssue,
} from './types'

export const PATROL_KEY = 'patrol'
export const DEFECT_KEY = 'defect'
export const CREW_KEY = 'crew'

export const PATROL_STATUSES = ['待巡视', '巡视中', '待复核', '已完成'] as const

export const LEDGER_ITEM_WAIT_DISPATCH = '待派发'
export const LEDGER_ITEM_DISPATCHED = '已派发'

export class DomainError extends Error {
  code: string
  patrolId?: number
  defectNos?: string[]

  constructor(code: string, message: string, extras?: { patrolId?: number; defectNos?: string[] }) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.patrolId = extras?.patrolId
    this.defectNos = extras?.defectNos
  }
}

// ---------- 小工具 ----------

export function nowStamp(clock: () => Date = () => new Date()): string {
  const d = clock()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function today(clock: () => Date = () => new Date()): string {
  return nowStamp(clock).slice(0, 10)
}

function daysAfter(date: string, days: number): string {
  const [y, m, d] = date.split('-').map((part) => Number(part))
  if (!y || !m || !d) {
    return date
  }
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

/**
 * 认异常项数：
 * - number 或纯数字串：直接取非负整数；
 * - 中文简写数字「零一二两三四五六七八九十百」组合也认得（兼容历史手抄记录）；
 * - 其余（模板样例脏文本、空值、负数、小数）一律视为认不出，返回 null，
 *   调用方按 0 项处理并标注「异常项数待核实」，绝不因为脏数据崩掉整单。
 */
const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
}

function parseCnNumber(text: string): number | null {
  const t = text.trim()
  if (!t || [...t].some((ch) => !(ch in CN_DIGITS || ch === '十' || ch === '百'))) {
    return null
  }
  // 处理含「十」「百」的简写：十、十几、几十、X百X十X
  let total = 0
  let section = 0
  let num = 0
  let matched = false
  for (const ch of t) {
    if (ch in CN_DIGITS) {
      num = CN_DIGITS[ch]
      matched = true
    } else if (ch === '十') {
      section += (num === 0 && matched === false ? 1 : num) * 10
      num = 0
      matched = true
    } else if (ch === '百') {
      section += (num === 0 ? 1 : num) * 100
      num = 0
      matched = true
    }
  }
  total = section + num
  return matched ? total : null
}

export function parseAbnormalCount(value: FieldValue | undefined | null): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (/^\d+$/.test(t)) {
      return Number(t)
    }
    if (t !== '') {
      return parseCnNumber(t)
    }
  }
  return null
}

/** 认检查项数：认不出按 0，仅用于展示与校验，不阻断业务。 */
export function parseCheckCount(value: FieldValue | undefined | null): number {
  const n = parseAbnormalCount(value)
  return n ?? 0
}

function splitNames(value: FieldValue | undefined): string[] {
  return String(value ?? '')
    .split(/[、,，\/\s]+/)
    .map((name) => name.trim())
    .filter(Boolean)
}

// ---------- 存储接口 ----------

/**
 * 领域层只认这个端口：hydrate 取当前快照，commit 整笔落库。
 * 纯前端实现见 local-store.ts（整体写 localStorage，天然原子）；
 * 测试用内存实现，可以让 commit 中途抛错模拟「复核提交中途中断」。
 */
export interface DomainStore {
  hydrate(): Database
  commit(db: Database): void
  /** 维修岗位人员名单（岗位工种含维修/检修/消缺），用于拦「既巡又修」。 */
  repairNames(): string[]
  clock(): Date
}

type StoreCtx = {
  store: DomainStore
}

function rows(db: Database, key: string): EntryRow[] {
  return db.entries[key] ?? []
}

function findPatrol(db: Database, patrolId: number): EntryRow | undefined {
  return rows(db, PATROL_KEY).find((row) => Number(row.id) === Number(patrolId))
}

function findDefect(db: Database, defectId: number): EntryRow | undefined {
  return rows(db, DEFECT_KEY).find((row) => Number(row.id) === Number(defectId))
}

// ---------- 派生编号 ----------

function nextDefectId(db: Database): number {
  return rows(db, DEFECT_KEY).reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

function formatDefectNo(id: number): string {
  return `DEFE-${String(id).padStart(4, '0')}`
}

function buildDefectRow(
  db: Database,
  patrol: EntryRow,
  seq: number,
  backfilled: boolean,
  stamp: string,
): EntryRow {
  const id = nextDefectId(db)
  const patrolDate = String(patrol.巡视日期 ?? '')
  return {
    id,
    status: '待派发',
    pending: true,
    abnormal: false,
    缺陷编号: formatDefectNo(id),
    缺陷类别: '巡视发现',
    发现方式: backfilled ? '历史巡视补录' : '巡视复核派生',
    严重等级: '一般',
    责任班组: '',
    要求完成日: /^\d{4}-\d{2}-\d{2}$/.test(patrolDate) ? daysAfter(patrolDate, 7) : '',
    消缺措施: '',
    消缺状态: '待派发',
    来源巡视单号: String(patrol.巡视单号 ?? ''),
    异常项序号: seq,
    补录: backfilled ? '是' : '否',
    派生时间: stamp,
  }
}

// ---------- 台账 ----------

export function getLedger(db: Database, patrolId: number): DispatchLedger | undefined {
  return db.dispatchLedgers[Number(patrolId)]
}

export function derivedDefects(db: Database, patrolId: number): EntryRow[] {
  // 详情面板里「已经派出去的单子」永远以消缺表 + 台账实链为准，
  // 不拿异常项数现算——有人把异常项数改小也不会让已派单据蒸发或翻倍。
  const ledger = getLedger(db, patrolId)
  if (!ledger) {
    return []
  }
  return ledger.items
    .filter((item) => item.defectId !== null)
    .map((item) => findDefect(db, item.defectId as number))
    .filter((row): row is EntryRow => Boolean(row))
    .sort((a, b) => Number(a.异常项序号) - Number(b.异常项序号))
}

function emptyLedger(patrol: EntryRow, abnormalCount: number, stamp: string, backfilled: boolean): DispatchLedger {
  return {
    patrolNo: String(patrol.巡视单号 ?? ''),
    patrolDate: String(patrol.巡视日期 ?? ''),
    abnormalCount,
    items: [],
    backfilled,
    createdAt: stamp,
    updatedAt: stamp,
  }
}

// ---------- 状态流转 ----------

const NEXT_STATUS: Record<string, string> = {
  开始巡视: '巡视中',
  提交复核: '待复核',
  确认完成: '已完成',
}

export type AdvanceResult = Partial<SubmitReviewResult> & {
  status: string
}

/**
 * 巡视单动作分发。
 * - 开始巡视 / 提交复核：只允许逐级前进，跳级拦下。
 * - 确认完成：收复核，做一次性、可断点续派的消缺派生。
 */
export function advancePatrol(
  { store }: StoreCtx,
  patrolId: number,
  action: string,
): AdvanceResult {
  const db = store.hydrate()
  const patrol = findPatrol(db, patrolId)
  if (!patrol) {
    throw new DomainError('PATROL_NOT_FOUND', `找不到编号为 ${patrolId} 的巡视单，数据可能已被重置，请重试而不是沿用旧页面数据`, { patrolId })
  }
  const target = NEXT_STATUS[action]
  if (!target) {
    throw new DomainError('ACTION_UNKNOWN', `巡视记录没有登记「${action}」这个动作`, { patrolId })
  }
  const current = String(patrol.status)
  // 已完成、已派过单的单子不再收复核类操作（优先于「重复操作」提示，
  // 好把已派到哪一张一并告诉用户）。
  if (current === '已完成') {
    const { defectNos } = ledgerSummary(db, patrolId)
    throw new DomainError(
      'REVIEW_LOCKED',
      defectNos.length
        ? `巡视单已复核完成并派单 ${defectNos.length} 张（${defectNos.join('、')}），不再接收复核`
        : '巡视单已复核完成，不再接收复核',
      { patrolId, defectNos },
    )
  }
  if (current === target) {
    throw new DomainError('ALREADY_IN_STATUS', `巡视单已经是「${target}」，不用重复操作`, { patrolId })
  }
  const expectedCurrent = PATROL_STATUSES[PATROL_STATUSES.indexOf(target as (typeof PATROL_STATUSES)[number]) - 1]
  if (current !== expectedCurrent) {
    // 跳级拦截：指出当前态、期望的上一级，以及已经派到了哪一张。
    const { defectNos } = ledgerSummary(db, patrolId)
    const tail = defectNos.length
      ? `；该单已派到 ${defectNos[defectNos.length - 1]}（共 ${defectNos.length} 张：${defectNos.join('、')}）`
      : '；该单尚未派单'
    throw new DomainError(
      'STATUS_SKIP',
      `不能从「${current}」直接${action}到「${target}」，需先处于「${expectedCurrent}」${tail}`,
      { patrolId, defectNos },
    )
  }

  if (action !== '确认完成') {
    patrol.status = target
    patrol.pending = target !== '已完成'
    store.commit(db)
    return { status: target } as AdvanceResult
  }
  return submitReview({ store }, patrolId)
}

function ledgerSummary(db: Database, patrolId: number): { ledger?: DispatchLedger; defectNos: string[] } {
  const ledger = getLedger(db, patrolId)
  if (!ledger) {
    return { defectNos: [] }
  }
  const defectNos = ledger.items
    .filter((item) => item.defectNo)
    .map((item) => item.defectNo as string)
  return { ledger, defectNos }
}

// ---------- 复核提交（核心） ----------

export type SubmitReviewResult = {
  status: '已完成'
  abnormalCount: number
  derivedCount: number
  defectNos: string[]
  resumed: boolean
}

/**
 * 复核提交。一次性派生的实现：
 * - 先在快照上做全部前置校验，任何一项不满足就抛错、一笔不写（整笔回滚）；
 * - 通过后逐项提交：每补一张消缺单连同台账行一起 commit，中断后重试只会补缺项；
 * - 已存在的台账/消缺按异常项序号幂等命中，绝不重复派生。
 */
export function submitReview({ store }: StoreCtx, patrolId: number): SubmitReviewResult {
  const pre = store.hydrate()
  const patrol = findPatrol(pre, patrolId)
  if (!patrol) {
    throw new DomainError('PATROL_NOT_FOUND', `找不到编号为 ${patrolId} 的巡视单，数据可能已被重置，请重试而不是沿用旧页面数据`, { patrolId })
  }
  const current = String(patrol.status)
  const ledger = getLedger(pre, patrolId)

  if (current === '已完成') {
    const { defectNos } = ledgerSummary(pre, patrolId)
    throw new DomainError(
      'REVIEW_LOCKED',
      defectNos.length
        ? `巡视单已复核完成并派单 ${defectNos.length} 张（${defectNos.join('、')}），不再接收复核`
        : '巡视单已复核完成，不再接收复核',
      { patrolId, defectNos },
    )
  }

  // 异常项怎么认：数字/数字串/中文数字都认；认不出按 0，但要写清「待核实」，
  // 不会沉默地按一个错数派单。
  const recognized = parseAbnormalCount(patrol.异常项数)
  if (recognized === null) {
    journalBlock(store, patrolId, `异常项数「${String(patrol.异常项数 ?? '')}」无法识别，请本路线巡视人核实后再复核`)
    throw new DomainError(
      'ABNORMAL_UNRECOGNIZED',
      `异常项数「${String(patrol.异常项数 ?? '')}」无法识别，已挂起复核，请本路线巡视人核实后重试`,
      { patrolId },
    )
  }
  const abnormalCount = recognized
  const checkCount = parseCheckCount(patrol.检查项数)
  if (checkCount > 0 && abnormalCount > checkCount) {
    journalBlock(store, patrolId, `异常项数 ${abnormalCount} 大于检查项数 ${checkCount}，数据不合理`)
    throw new DomainError(
      'ABNORMAL_EXCEEDS_CHECK',
      `异常项数 ${abnormalCount} 大于检查项数 ${checkCount}，已挂起复核，请核实后重试`,
      { patrolId },
    )
  }

  // 断点续派的一致性核对：台账已存在说明上次提交中途断过。
  let resumed = false
  if (ledger) {
    resumed = ledger.items.some((item) => item.defectId !== null) || ledger.items.length > 0
    if (ledger.abnormalCount !== abnormalCount) {
      // 有人把异常项数改小/改大：已派台账是凭据，本次不收，并把原因写明。
      journalBlock(
        store,
        patrolId,
        `异常项数与已派台账不一致：巡视单 ${abnormalCount} 项，台账仍记 ${ledger.abnormalCount} 项；已派 ${ledger.items.filter((i) => i.defectId).length} 张，禁止据此增减派单`,
      )
      throw new DomainError(
        'LEDGER_ABNORMAL_MISMATCH',
        `异常项数对不上：当前 ${abnormalCount} 项，已派台账记的是 ${ledger.abnormalCount} 项。已派过的单不会跟着改动，请恢复异常项数或走异常流程处理`,
        { patrolId },
      )
    }
    // 已派消缺单必须在消缺表里真实存在（取不到对应巡视单的消缺单时绝不顶旧数据）。
    for (const item of ledger.items) {
      if (item.defectId !== null && !findDefect(pre, item.defectId)) {
        journalBlock(store, patrolId, `台账第 ${item.seq} 项指向的消缺单 ${item.defectNo ?? '#' + item.defectId} 已不存在，无法续派`)
        throw new DomainError(
          'DERIVED_DEFECT_MISSING',
          `台账第 ${item.seq} 项的消缺单 ${item.defectNo ?? '#' + item.defectId} 在消缺表里取不到，数据对不上，本次续派已挂起；请核对数据后重试，不会用旧数据顶替`,
          { patrolId },
        )
      }
    }
    const seqs = ledger.items.map((item) => item.seq)
    if (seqs.some((seq, i) => seq !== i + 1)) {
      journalBlock(store, patrolId, '台账异常项序号不连续，无法断点续派')
      throw new DomainError('LEDGER_SEQ_GAP', '台账异常项序号不连续，无法续派，已写明原因并挂起，请联系管理员核对台账', { patrolId })
    }
  }

  const stamp = nowStamp(store.clock)

  // 台账不存在：本次首次提交，先空建台账并落库（后续逐项补）。
  if (!ledger) {
    const db0 = store.hydrate()
    const p0 = findPatrol(db0, patrolId)
    if (!p0) {
      throw new DomainError('PATROL_NOT_FOUND', `提交中途巡视单 ${patrolId} 取不到了，请重试`, { patrolId })
    }
    db0.dispatchLedgers[Number(patrolId)] = emptyLedger(p0, abnormalCount, stamp, false)
    p0.待派台账状态 = '已建立'
    store.commit(db0)
  }

  const derivedNos: string[] = []
  let derivedCount = 0

  // 逐项派生：每个异常序号只派一张，缺哪项补哪项。
  for (let seq = 1; seq <= abnormalCount; seq += 1) {
    const db = store.hydrate()
    const p = findPatrol(db, patrolId)
    if (!p) {
      throw new DomainError('PATROL_NOT_FOUND', `续派第 ${seq} 项时巡视单取不到了，请重试`, { patrolId })
    }
    const lg = getLedger(db, patrolId)
    if (!lg) {
      // 理论上不会发生（前面刚建过）；接不上就写清原因，不沉默。
      throw new DomainError('LEDGER_MISSING', `续派第 ${seq} 项时待派台账取不到，无法接上，请重试`, { patrolId })
    }
    let item = lg.items.find((candidate) => candidate.seq === seq)
    if (item && item.defectId !== null) {
      // 已派生过：幂等跳过，保证派生只发生一次。
      const existed = findDefect(db, item.defectId)
      if (existed) {
        derivedNos.push(String(existed.缺陷编号))
        continue
      }
      // 台账说派过、消缺表却没有：不顶旧数据，写明原因后挂起。
      p.中断原因 = `${stamp} 第 ${seq} 项消缺单 ${item.defectNo ?? ''} 在消缺表缺失，续派挂起`
      store.commit(db)
      throw new DomainError(
        'DERIVED_DEFECT_MISSING',
        `第 ${seq} 项消缺单在消缺表里取不到，已停止续派并写明原因，数据修复后可重试补齐剩余项`,
        { patrolId },
      )
    }

    // 扣减：本项尚待派生才允许派（待派生额度 -1）。额度不足（重复/并发派过）整笔回滚。
    const pendingQuota = lg.abnormalCount - lg.items.filter((candidate) => candidate.defectId !== null).length
    if (pendingQuota <= 0) {
      throw new DomainError(
        'QUOTA_EXHAUSTED',
        `待派生额度已扣完，第 ${seq} 项不再派生（防止重复派单导致翻倍），本次提交整笔回滚`,
        { patrolId },
      )
    }

    const defect = buildDefectRow(db, p, seq, false, stamp)
    db.entries[DEFECT_KEY] = [...rows(db, DEFECT_KEY), defect]
    const newItem: DispatchLedgerItem = {
      seq,
      defectId: defect.id,
      defectNo: String(defect.缺陷编号),
      state: LEDGER_ITEM_WAIT_DISPATCH,
      dispatchedAt: null,
    }
    if (item) {
      lg.items = lg.items.map((candidate) => (candidate.seq === seq ? newItem : candidate))
    } else {
      lg.items = [...lg.items, newItem].sort((a, b) => a.seq - b.seq)
    }
    lg.updatedAt = stamp
    p.派单数 = lg.items.filter((candidate) => candidate.defectId !== null).length
    p.中断原因 = ''
    // 消缺单与台账行同一笔落库：要么都生效，要么都不生效。
    store.commit(db)
    derivedNos.push(String(defect.缺陷编号))
    derivedCount += 1
  }

  // 收尾：全部项都派齐，巡视单置已完成（与台账、消缺同一笔）。
  const dbEnd = store.hydrate()
  const pEnd = findPatrol(dbEnd, patrolId)
  if (!pEnd) {
    throw new DomainError('PATROL_NOT_FOUND', '收尾时巡视单取不到了，请重试', { patrolId })
  }
  const lgEnd = getLedger(dbEnd, patrolId)
  if (!lgEnd || lgEnd.items.filter((item) => item.defectId !== null).length !== abnormalCount) {
    throw new DomainError('RESUME_INCOMPLETE', '派单项数与异常项数未齐，暂不能完成复核，请重试补齐', { patrolId })
  }
  pEnd.status = '已完成'
  pEnd.pending = false
  pEnd.待派台账状态 = '已回写'
  pEnd.复核时间 = stamp
  pEnd.中断原因 = ''
  store.commit(dbEnd)

  return { status: '已完成', abnormalCount, derivedCount, defectNos: derivedNos, resumed }
}

/** 结构性挂起：把原因写到巡视单上并落库，保证「别什么都不说停在半路」。 */
function journalBlock(store: DomainStore, patrolId: number, reason: string): void {
  try {
    const db = store.hydrate()
    const patrol = findPatrol(db, patrolId)
    if (patrol) {
      patrol.中断原因 = `${nowStamp(store.clock)} ${reason}`
      store.commit(db)
    }
  } catch {
    // 写原因失败也不能掩盖原始业务错误
  }
}

// ---------- 异常项数修改（带权限与锁） ----------

export type UpdateAbnormalInput = {
  patrolId: number
  operator: string
  abnormalCount: number
}

/**
 * 修改异常项数：
 * - 只有本路线巡视人能动；
 * - 巡视人若是在册维修/检修/消缺岗位（既巡又修），一律不收；
 * - 待巡视/巡视中/待复核可改；已建台账（派过单）的单子锁死，改不动；
 * - 认不出的原值允许由巡视人改成明确数字（兼容历史脏数据）。
 */
export function updateAbnormalCount({ store }: StoreCtx, input: UpdateAbnormalInput): EntryRow {
  const { patrolId, operator, abnormalCount } = input
  const op = operator.trim()
  if (!op) {
    throw new DomainError('NO_OPERATOR', '未指定当前操作人，无法核对巡视人身份')
  }
  if (!Number.isInteger(abnormalCount) || abnormalCount < 0) {
    throw new DomainError('BAD_ABNORMAL', '异常项数必须是不小于 0 的整数')
  }
  const db = store.hydrate()
  const patrol = findPatrol(db, patrolId)
  if (!patrol) {
    throw new DomainError('PATROL_NOT_FOUND', `找不到编号为 ${patrolId} 的巡视单，请刷新后重试`, { patrolId })
  }
  if (String(patrol.status) === '已完成') {
    const { defectNos } = ledgerSummary(db, patrolId)
    throw new DomainError(
      'REVIEW_LOCKED',
      defectNos.length ? `巡视单已完成并派单（${defectNos.join('、')}），异常项数已锁定` : '巡视单已完成，异常项数已锁定',
      { patrolId, defectNos },
    )
  }
  if (getLedger(db, patrolId)) {
    const { defectNos } = ledgerSummary(db, patrolId)
    throw new DomainError(
      'LEDGER_LOCKED',
      `该巡视单已派单 ${defectNos.length} 张（${defectNos.join('、') || '无'}），台账已建立，异常项数锁死，不再接受修改`,
      { patrolId, defectNos },
    )
  }
  const patrolmen = splitNames(patrol.巡视人员)
  if (!patrolmen.includes(op)) {
    throw new DomainError(
      'NOT_ROUTE_PATROLMAN',
      `异常项数只有本路线巡视人能改：该路线巡视人为「${patrolmen.join('、') || '未登记'}」，当前操作人「${op}」无权修改`,
      { patrolId },
    )
  }
  // 既巡又修：当前操作人若同时是维修岗，不收（发现与消缺必须分离）。
  if (store.repairNames().includes(op)) {
    throw new DomainError(
      'DUAL_ROLE_FORBIDDEN',
      `「${op}」同时登记在维修/检修/消缺岗位，一人既巡又修的复核不收，请由非维修岗的巡视人修改`,
      { patrolId },
    )
  }
  const checkCount = parseCheckCount(patrol.检查项数)
  if (checkCount > 0 && abnormalCount > checkCount) {
    throw new DomainError('BAD_ABNORMAL', `异常项数 ${abnormalCount} 不能大于检查项数 ${checkCount}`)
  }
  patrol.异常项数 = abnormalCount
  patrol.异常项数待核实 = '否'
  store.commit(db)
  return patrol
}

// ---------- 待派台账一致性校验 ----------

/**
 * 台账核对：两处异常项数对得上 + 派单条数与台账一致 + 消缺表实链完整。
 */
export function runLedgerChecks(db: Database): LedgerIssue[] {
  const issues: LedgerIssue[] = []
  for (const patrol of rows(db, PATROL_KEY)) {
    const patrolId = Number(patrol.id)
    const ledger = getLedger(db, patrolId)
    const linked = rows(db, DEFECT_KEY).filter(
      (defect) => String(defect.来源巡视单号 ?? '') === String(patrol.巡视单号 ?? ''),
    )

    if (!ledger) {
      // 已完成却没有台账：历史补录漏网或数据损坏。
      if (String(patrol.status) === '已完成' && linked.length > 0) {
        issues.push({
          patrolId,
          patrolNo: String(patrol.巡视单号 ?? patrolId),
          level: 'error',
          message: '巡视单已完成且有派生消缺单，但缺待派台账',
        })
      }
      linked.forEach((defect) => {
        issues.push({
          patrolId,
          patrolNo: String(patrol.巡视单号 ?? patrolId),
          level: 'warn',
          message: `消缺单 ${defect.缺陷编号} 指向该巡视单，但无台账记录`,
        })
      })
      continue
    }

    // 1) 两处异常项数对得上
    const currentAbnormal = parseAbnormalCount(patrol.异常项数)
    if (currentAbnormal !== null && currentAbnormal !== ledger.abnormalCount) {
      issues.push({
        patrolId,
        patrolNo: ledger.patrolNo,
        level: 'error',
        message: `异常项数对不上：巡视单 ${currentAbnormal} 项，待派台账 ${ledger.abnormalCount} 项`,
      })
    }

    // 2) 派单条数与台账一致
    const derivedItems = ledger.items.filter((item) => item.defectId !== null)
    if (derivedItems.length !== linked.length) {
      issues.push({
        patrolId,
        patrolNo: ledger.patrolNo,
        level: 'error',
        message: `派单条数不一致：台账 ${derivedItems.length} 张，消缺表实链 ${linked.length} 张`,
      })
    }

    // 3) 逐项核对：序号连续、消缺单真实存在、回链一致、状态一致
    ledger.items.forEach((item, index) => {
      if (item.seq !== index + 1) {
        issues.push({ patrolId, patrolNo: ledger.patrolNo, level: 'error', message: `台账第 ${index + 1} 行序号 ${item.seq} 不连续` })
      }
      if (item.defectId === null) {
        issues.push({ patrolId, patrolNo: ledger.patrolNo, level: 'warn', message: `台账第 ${item.seq} 项尚未派生消缺单` })
        return
      }
      const defect = findDefect(db, item.defectId)
      if (!defect) {
        issues.push({ patrolId, patrolNo: ledger.patrolNo, level: 'error', message: `台账第 ${item.seq} 项的消缺单 ${item.defectNo ?? '#' + item.defectId} 不存在` })
        return
      }
      if (String(defect.缺陷编号) !== item.defectNo) {
        issues.push({ patrolId, patrolNo: ledger.patrolNo, level: 'error', message: `台账第 ${item.seq} 项编号 ${item.defectNo} 与消缺表 ${defect.缺陷编号} 不符` })
      }
      if (String(defect.来源巡视单号 ?? '') !== ledger.patrolNo) {
        issues.push({ patrolId, patrolNo: ledger.patrolNo, level: 'error', message: `消缺单 ${defect.缺陷编号} 回链巡视单号 ${String(defect.来源巡视单号 ?? '')} 与台账 ${ledger.patrolNo} 不符` })
      }
      // 台账行状态必须与消缺单实际状态对得上
      const waiting = String(defect.status) === '待派发'
      if (waiting && item.state === LEDGER_ITEM_DISPATCHED) {
        issues.push({ patrolId, patrolNo: ledger.patrolNo, level: 'error', message: `消缺单 ${defect.缺陷编号} 仍是待派发，台账却记已派发` })
      }
      if (!waiting && item.state !== LEDGER_ITEM_DISPATCHED) {
        issues.push({ patrolId, patrolNo: ledger.patrolNo, level: 'error', message: `消缺单 ${defect.缺陷编号} 已派发（${defect.status}），台账未回写` })
      }
    })

    // 消缺表多出的无台账行
    const ledgerIds = new Set(ledger.items.map((item) => item.defectId))
    linked.forEach((defect) => {
      if (!ledgerIds.has(Number(defect.id))) {
        issues.push({ patrolId, patrolNo: ledger.patrolNo, level: 'error', message: `消缺单 ${defect.缺陷编号} 在消缺表存在，台账里却没有对应行` })
      }
    })
  }
  return issues
}

// ---------- 消缺侧：派单回写 / 来源查询 / 台账行状态 ----------

/** 消缺单执行「派发消缺」成功后回写待派台账（派单条数与状态保持一致）。 */
export function markDefectDispatched({ store }: StoreCtx, defectId: number, stamp?: string): EntryRow {
  const db = store.hydrate()
  const defect = findDefect(db, defectId)
  if (!defect) {
    throw new DomainError('DEFECT_NOT_FOUND', `找不到编号为 ${defectId} 的消缺单，请刷新后重试`)
  }
  defect.status = '消缺中'
  defect.pending = true
  defect.消缺状态 = '消缺中'
  const patrolNo = String(defect.来源巡视单号 ?? '')
  if (patrolNo) {
    const entry = Object.entries(db.dispatchLedgers).find(([, ledger]) => ledger.patrolNo === patrolNo)
    if (entry) {
      const [patrolId, ledger] = entry
      const item = ledger.items.find((candidate) => candidate.defectId === defectId)
      if (item) {
        item.state = LEDGER_ITEM_DISPATCHED
        item.dispatchedAt = stamp ?? nowStamp(store.clock)
        ledger.updatedAt = item.dispatchedAt
        const patrol = findPatrol(db, Number(patrolId))
        if (patrol) {
          patrol.待派台账状态 = ledger.items.every((candidate) => candidate.state === LEDGER_ITEM_DISPATCHED) ? '全部已派发' : '部分已派发'
        }
      }
    }
  }
  store.commit(db)
  return defect
}

/**
 * 取消缺单对应的巡视单：必须实时从快照取，取不到明确报错、允许重试，
 * 绝不返回页面缓存的旧巡视数据顶替。
 */
export function resolveSourcePatrol(db: Database, defect: EntryRow): EntryRow {
  const patrolNo = String(defect.来源巡视单号 ?? '')
  if (!patrolNo) {
    throw new DomainError('NO_SOURCE', `消缺单 ${String(defect.缺陷编号 ?? defect.id)} 不是巡视派生单，没有来源巡视单号`)
  }
  const patrol = rows(db, PATROL_KEY).find((row) => String(row.巡视单号 ?? '') === patrolNo)
  if (!patrol) {
    throw new DomainError('SOURCE_PATROL_NOT_FOUND', `消缺单 ${String(defect.缺陷编号 ?? defect.id)} 对应的巡视单 ${patrolNo} 取不到，可能已被删除或数据未加载，请重试而不是沿用旧数据`)
  }
  return patrol
}

// ---------- 历史巡视单补录 / 老数据迁移 ----------

export const STORAGE_VERSION = 2

export type MigrationReport = {
  migrated: boolean
  backfilledPatrolIds: number[]
  backfilledDefectNos: string[]
  normalizedPatrolIds: number[]
}

/**
 * 把老版本库（只有 entries、没有待派台账）迁到当前结构：
 * - 历史的巡视单按巡视日期补录：已完成且异常项数认得的，补齐台账与消缺单；
 * - 认不出的异常项数记 0 展示并标「待核实」，等本路线巡视人确认，绝不瞎派；
 * - 补齐巡视侧派单数/台账状态字段；
 * - 幂等：重复执行不会重复补。
 */
export function migrateDatabase(
  raw: { version?: number; entries?: Record<string, EntryRow[]>; dispatchLedgers?: Record<number, DispatchLedger> } | null,
  clock: () => Date = () => new Date(),
): { db: Database; report: MigrationReport } {
  const entries: Record<string, EntryRow[]> = {}
  for (const [key, list] of Object.entries(raw?.entries ?? {})) {
    entries[key] = list.map((row) => ({ ...row }))
  }
  const db: Database = {
    version: STORAGE_VERSION,
    entries,
    dispatchLedgers: raw?.dispatchLedgers ? JSON.parse(JSON.stringify(raw.dispatchLedgers)) : {},
  }

  const report: MigrationReport = {
    migrated: (raw?.version ?? 1) < STORAGE_VERSION,
    backfilledPatrolIds: [],
    backfilledDefectNos: [],
    normalizedPatrolIds: [],
  }

  const patrols = entries[PATROL_KEY] ?? []
  for (const patrol of patrols) {
    const recognized = parseAbnormalCount(patrol.异常项数)
    if (recognized === null) {
      // 兼容既有脏记录：认不出按 0 展示，标待核实，不阻断。
      if (patrol.异常项数 !== 0) {
        patrol.异常项原值 = String(patrol.异常项数 ?? '')
        patrol.异常项数 = 0
        patrol.异常项数待核实 = '是'
        report.normalizedPatrolIds.push(Number(patrol.id))
      }
    } else if (patrol.异常项数 !== recognized) {
      patrol.异常项数 = recognized
      patrol.异常项数待核实 = '否'
      report.normalizedPatrolIds.push(Number(patrol.id))
    } else if (!('异常项数待核实' in patrol)) {
      patrol.异常项数待核实 = '否'
    }

    if (String(patrol.status) === '已完成' && recognized !== null && recognized > 0) {
      const result = backfillPatrol(db, Number(patrol.id), clock)
      if (result) {
        report.backfilledPatrolIds.push(Number(patrol.id))
        report.backfilledDefectNos.push(...result.defectNos)
      }
    }
  }
  return { db, report }
}

/**
 * 历史已完成巡视单按巡视日期补录：缺台账建台账、缺消缺单补消缺单，
 * 已存在的按巡视单号+异常项序号幂等命中。
 */
export function backfillPatrol(
  db: Database,
  patrolId: number,
  clock: () => Date = () => new Date(),
): { defectNos: string[]; created: number } | null {
  const patrol = findPatrol(db, patrolId)
  if (!patrol) {
    return null
  }
  const abnormalCount = parseAbnormalCount(patrol.异常项数) ?? 0
  if (abnormalCount <= 0) {
    return { defectNos: [], created: 0 }
  }
  // 补录时间锚定巡视日期，体现「按巡视日期补录」。
  const patrolDate = /^\d{4}-\d{2}-\d{2}$/.test(String(patrol.巡视日期 ?? ''))
    ? String(patrol.巡视日期)
    : today(clock)
  const stamp = `${patrolDate} 18:00`

  let ledger = getLedger(db, patrolId)
  if (!ledger) {
    ledger = emptyLedger(patrol, abnormalCount, stamp, true)
    db.dispatchLedgers[Number(patrolId)] = ledger
  }
  ledger.backfilled = true

  const createdNos: string[] = []
  let created = 0
  for (let seq = 1; seq <= abnormalCount; seq += 1) {
    const existing = ledger.items.find((item) => item.seq === seq)
    if (existing?.defectId && findDefect(db, existing.defectId)) {
      createdNos.push(existing.defectNo as string)
      continue
    }
    const defect = buildDefectRow(db, patrol, seq, true, stamp)
    db.entries[DEFECT_KEY] = [...rows(db, DEFECT_KEY), defect]
    const item: DispatchLedgerItem = {
      seq,
      defectId: defect.id,
      defectNo: String(defect.缺陷编号),
      state: LEDGER_ITEM_WAIT_DISPATCH,
      dispatchedAt: null,
    }
    if (existing) {
      ledger.items = ledger.items.map((candidate) => (candidate.seq === seq ? item : candidate))
    } else {
      ledger.items = [...ledger.items, item]
    }
    createdNos.push(String(defect.缺陷编号))
    created += 1
  }
  ledger.items.sort((a, b) => a.seq - b.seq)
  ledger.updatedAt = stamp
  patrol.派单数 = ledger.items.filter((item) => item.defectId !== null).length
  patrol.待派台账状态 = ledger.backfilled ? '历史已补录' : '已回写'
  return { defectNos: createdNos, created }
}
