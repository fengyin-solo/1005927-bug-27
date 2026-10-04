import { listRows, saveAllRows, saveRows } from '@/data/local-store'
import { isLedgerItems, type ActionResult, type EntryRow, type LedgerItem } from '@/data/types'

/**
 * 巡视复核派单领域服务。
 *
 * 不变量：
 * 1. 派生只发生一次——已派出的消缺单落在「待派台账」里，之后异常项数怎么改都不隐式增删。
 * 2. 巡视状态、异常项数扣减、台账落账、消缺单派生在同一笔事务里落盘，校验不过整笔回滚。
 * 3. 复核中断后允许重试：按项次补齐缺的那一张；接不上的项写明原因，不静默停在半路。
 * 4. 消缺单找不到对应巡视单时保留原数据等重试，绝不顶一份旧数据上去。
 */

const DEFECT_PREFIX = 'DEFE-'
const PATROL_PREFIX = 'PATR-'
const DEFECT_FIELDS = {
  缺陷类别: '巡视发现缺陷',
  发现方式: '巡视检查',
  严重等级: '待定级',
}

// 命中这些岗种就算「修」的人；既巡又修的巡视单不收其复核。
const REPAIR_POST_KEYWORDS = ['消缺', '检修', '维修', '修复']

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function ok(message: string): ActionResult {
  return { ok: true, message }
}

/** 宽容认异常项数：兼容历史脏数据，认不出来按 0 处理，并给出上限钳制。 */
export function parseCount(value: unknown, cap?: number): number {
  let n: number
  if (typeof value === 'number' && Number.isFinite(value)) {
    n = Math.trunc(value)
  } else {
    const matched = String(value ?? '').trim().match(/\d+/)
    n = matched ? Number(matched[0]) : 0
  }
  if (n < 0) {
    n = 0
  }
  if (typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 && n > cap) {
    n = cap
  }
  return n
}

export function ledgerOf(row: EntryRow): LedgerItem[] {
  const items = row['待派台账']
  return isLedgerItems(items) ? items : []
}

function inspectorsOf(row: EntryRow): string[] {
  return String(row['巡视人员'] ?? '')
    .split(/[、,，\s/]+/)
    .map((name) => name.trim())
    .filter(Boolean)
}

function isRouteInspector(patrol: EntryRow, operator: string): boolean {
  const name = operator.trim()
  return name.length > 0 && inspectorsOf(patrol).includes(name)
}

function crewByName(name: string): EntryRow | undefined {
  return listRows('crew').find((row) => String(row['姓名'] ?? '').trim() === name.trim())
}

/** 既巡又修：人员档案岗种带消缺/检修等字样，或在消缺责任班组里挂名。 */
export function isRepairRole(operator: string): boolean {
  const name = operator.trim()
  if (!name) {
    return false
  }
  const crew = crewByName(name)
  if (crew && REPAIR_POST_KEYWORDS.some((word) => String(crew['岗位工种'] ?? '').includes(word))) {
    return true
  }
  return listRows('defect').some((row) => String(row['责任班组'] ?? '').includes(name))
}

function nextDefectId(defects: EntryRow[]): number {
  return defects.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function defectCode(id: number): string {
  return `${DEFECT_PREFIX}${String(id).padStart(4, '0')}`
}

function patrolCode(id: number | string): string {
  return `${PATROL_PREFIX}${String(id).padStart(4, '0')}`
}

function dueDate(patrolDate: unknown): string {
  const text = String(patrolDate ?? '').trim()
  const matched = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (!matched) {
    return ''
  }
  const d = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
  d.setDate(d.getDate() + 7)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function linkedDefect(
  defects: EntryRow[],
  item: LedgerItem | undefined,
  patrol: EntryRow,
  sequence: number,
): { defect?: EntryRow; conflictPatrol?: string } {
  const patrolNo = String(patrol['巡视单号'] ?? '')
  if (item) {
    const byId = defects.find((row) => Number(row.id) === Number(item.缺陷ID))
    if (byId) {
      const owner = String(byId['来源巡视单号'] ?? '')
      if (owner && owner !== patrolNo) {
        return { conflictPatrol: owner }
      }
      return { defect: byId }
    }
    const byCode = defects.find((row) => String(row['缺陷编号']) === item.缺陷编号)
    if (byCode) {
      const owner = String(byCode['来源巡视单号'] ?? '')
      if (owner && owner !== patrolNo) {
        return { conflictPatrol: owner }
      }
      return { defect: byCode }
    }
  }
  // 中断后旧台账缺项，但消缺单其实已经派生过：按 巡视单号+项次 找回，避免重复派生。
  const byLink = defects.find(
    (row) => String(row['来源巡视单号'] ?? '') === patrolNo && Number(row['来源项次']) === sequence,
  )
  return byLink ? { defect: byLink } : {}
}

function buildDefect(id: number, patrol: EntryRow, sequence: number, operator: string): EntryRow {
  return {
    id,
    status: '待派发',
    pending: true,
    abnormal: false,
    缺陷编号: defectCode(id),
    缺陷类别: DEFECT_FIELDS.缺陷类别,
    发现方式: DEFECT_FIELDS.发现方式,
    严重等级: DEFECT_FIELDS.严重等级,
    责任班组: '',
    要求完成日: dueDate(patrol['巡视日期']),
    来源巡视ID: Number(patrol.id),
    来源巡视单号: String(patrol['巡视单号'] ?? patrolCode(patrol.id)),
    来源项次: sequence,
    消缺措施: '',
    消缺状态: '待派发',
    关联状态: '已关联',
    关联失败原因: '',
    派单时间: nowText(),
    派单操作人: operator,
  }
}

// ---------------------------------------------------------------------------
// 巡视单动作
// ---------------------------------------------------------------------------

function findRow(key: string, id: number, entity: string): EntryRow[] | ActionResult {
  const rows = listRows(key)
  if (!rows.some((row) => Number(row.id) === id)) {
    return fail(`没有找到编号为 ${id} 的${entity}`)
  }
  return rows
}

/** 巡视单上的动作统一从这里走，页面不做业务判断。 */
export function runPatrolAction(id: number, action: string, operator: string): ActionResult {
  const rows = findRow('patrol', id, '巡视记录')
  if (!Array.isArray(rows)) {
    return rows
  }
  const row = rows.find((item) => Number(item.id) === id) as EntryRow
  const current = String(row.status)

  if (action === '开始巡视') {
    if (current !== '待巡视') {
      return fail(`当前状态「${current}」，不能开始巡视`)
    }
    const next = { ...row, status: '巡视中', pending: true, abnormal: false }
    saveRows('patrol', rows.map((item) => (Number(item.id) === id ? next : item)))
    return ok(`巡视单 ${row['巡视单号']} 已开始巡视`)
  }

  if (action === '提交复核') {
    if (ledgerOf(row).length > 0 || current === '已完成') {
      return dispatchedMessage(row, '已派过单的巡视单不再收复核')
    }
    if (current !== '巡视中') {
      return fail(`跳级操作被拦：巡视单 ${row['巡视单号']} 当前「${current}」，须先开始巡视并完成巡视后再提交复核`)
    }
    if (!isRouteInspector(row, operator)) {
      return fail(`只有本路线巡视人（${inspectorsOf(row).join('、') || '未指派'}）能提交复核，${operator || '当前操作人'} 不在其列`)
    }
    if (isRepairRole(operator)) {
      return fail(`${operator} 既参与巡视又承担消缺，岗位不相容，该巡视单不收其复核`)
    }
    const cap = parseCount(row['检查项数'])
    const abnormalCount = parseCount(row['异常项数'], cap || undefined)
    const next: EntryRow = {
      ...row,
      status: '待复核',
      pending: true,
      abnormal: false,
      异常项数: abnormalCount,
      待派异常项数: abnormalCount,
      派单失败原因: '',
      提交人: operator,
      提交时间: nowText(),
    }
    saveRows('patrol', rows.map((item) => (Number(item.id) === id ? next : item)))
    return ok(`巡视单 ${row['巡视单号']} 已提交复核，异常项 ${abnormalCount} 项待派`)
  }

  if (action === '复核派单') {
    return reviewAndDispatch(id, operator)
  }

  return fail(`巡视记录没有登记「${action}」这个动作`)
}

/** 修改异常项数：只有本路线巡视人能动，派过单（已落台账）后锁死。 */
export function updateAbnormalCount(id: number, value: unknown, operator: string): ActionResult {
  const rows = findRow('patrol', id, '巡视记录')
  if (!Array.isArray(rows)) {
    return rows
  }
  const row = rows.find((item) => Number(item.id) === id) as EntryRow
  const ledger = ledgerOf(row)
  if (ledger.length > 0 || String(row.status) === '已完成') {
    return dispatchedMessage(row, '派过单的巡视单异常项数已锁定')
  }
  if (!isRouteInspector(row, operator)) {
    return fail(`异常项数只有本路线巡视人（${inspectorsOf(row).join('、') || '未指派'}）能改，${operator || '当前操作人'} 无权修改`)
  }
  if (isRepairRole(operator)) {
    return fail(`${operator} 既参与巡视又承担消缺，岗位不相容，不能登记异常项数`)
  }
  if (String(row.status) === '待巡视') {
    return fail('巡视单尚未开始巡视，先开始巡视再登记异常项数')
  }
  const cap = parseCount(row['检查项数'])
  const count = parseCount(value, cap || undefined)
  const raw = String(value ?? '').trim()
  const next: EntryRow = {
    ...row,
    异常项数: count,
    待派异常项数: String(row.status) === '待复核' ? count : row['待派异常项数'],
  }
  saveRows('patrol', rows.map((item) => (Number(item.id) === id ? next : item)))
  const note = raw !== String(count) ? `（「${raw}」无法辨认或超出检查项数，已按 ${count} 认）` : ''
  return ok(`巡视单 ${row['巡视单号']} 异常项数已记为 ${count} ${note}`.trim())
}

// ---------------------------------------------------------------------------
// 复核派单：一次派生、事务落盘、中断可续
// ---------------------------------------------------------------------------

type ReviewOptions = {
  allowNonRoute?: boolean // 历史补录走系统账号，跳过本路线校验
  backfill?: boolean
}

export function reviewAndDispatch(id: number, operator: string, options: ReviewOptions = {}): ActionResult {
  const patrolRows = listRows('patrol')
  const patrol = patrolRows.find((row) => Number(row.id) === id)
  if (!patrol) {
    return fail(`没有找到编号为 ${id} 的巡视记录`)
  }

  const ledger = ledgerOf(patrol)
  const totalItems = parseCount(patrol['异常项数'], parseCount(patrol['检查项数']) || undefined)

  // 有人在派单后把异常项数改小：已派条数对不上，整笔回滚，一项都不动。
  // 这条要先于「已派单拒收」判断，否则改小后再复核只会被挡，不会暴露扣减不平。
  if (ledger.length > totalItems) {
    return fail(
      `扣减不成，整笔回滚：巡视单 ${patrol['巡视单号']} 已派出 ${ledger.length} 张消缺单，当前异常项数只有 ${totalItems}，拒绝按缩小后的数字重派`,
    )
  }

  // 已完成且台账齐：不再收复核，并指出已派到哪一张。
  if (String(patrol.status) === '已完成' && ledger.length > 0) {
    return dispatchedMessage(patrol, '派过单的巡视单不再收复核')
  }
  if (String(patrol.status) === '已完成' && totalItems === 0) {
    return fail(`巡视单 ${patrol['巡视单号']} 已复核完成，无异常项，无需派单`)
  }
  if (String(patrol.status) === '待巡视' || String(patrol.status) === '巡视中') {
    return fail(`跳级操作被拦：巡视单 ${patrol['巡视单号']} 当前「${patrol.status}」，须先提交复核到「待复核」才能复核派单`)
  }

  if (!options.allowNonRoute) {
    if (!isRouteInspector(patrol, operator)) {
      return fail(`只有本路线巡视人（${inspectorsOf(patrol).join('、') || '未指派'}）能复核派单，${operator || '当前操作人'} 无权操作`)
    }
    if (isRepairRole(operator)) {
      return fail(`${operator} 既参与巡视又承担消缺，岗位不相容，该巡视单不收其复核`)
    }
  }

  // —— 以下在内存副本上组装，全部校验通过后一次性落盘（同一份事务）——
  const defects = listRows('defect')
  const nextPatrol = clone(patrol)
  const nextDefects = clone(defects)
  const nextLedger: LedgerItem[] = clone(ledger)
  const createdCodes: string[] = []
  const stuckReasons: string[] = []

  for (let sequence = 1; sequence <= totalItems; sequence += 1) {
    const index = sequence - 1
    const existing = nextLedger[index]
    const found = linkedDefect(nextDefects, existing, nextPatrol, sequence)

    if (found.conflictPatrol) {
      // 接不上：台账指向的消缺单已归属别的巡视单，写明原因并保留现场待人工处理。
      const code = existing?.缺陷编号 ?? '未知单号'
      const reason = `第 ${sequence} 项接不上：${code} 已归属巡视单 ${found.conflictPatrol}，未顶替、未重复派生，请人工核对`
      stuckReasons.push(reason)
      if (existing) {
        nextLedger[index] = { ...existing, 备注: reason, 状态: '关联失败' }
      }
      continue
    }

    if (found.defect) {
      // 旧台账缺项 / 关联字段被抹掉：把同一项的消缺单接回来，业务字段一律不覆盖。
      const defect = found.defect
      defect['来源巡视ID'] = Number(nextPatrol.id)
      defect['来源巡视单号'] = String(nextPatrol['巡视单号'] ?? patrolCode(nextPatrol.id))
      defect['来源项次'] = sequence
      defect['关联状态'] = '已关联'
      defect['关联失败原因'] = ''
      defect.abnormal = false
      const synced: LedgerItem = existing ?? {
        项次: sequence,
        缺陷ID: Number(defect.id),
        缺陷编号: String(defect['缺陷编号']),
        状态: String(defect.status),
        派单时间: String(defect['派单时间'] ?? nowText()),
        操作人: String(defect['派单操作人'] ?? operator),
        备注: '中断重试时接回',
      }
      nextLedger[index] = { ...synced, 缺陷ID: Number(defect.id), 缺陷编号: String(defect['缺陷编号']), 状态: String(defect.status) }
      continue
    }

    // 缺的那一张：补派。
    const newId = nextDefectId(nextDefects)
    const defect = buildDefect(newId, nextPatrol, sequence, options.backfill ? '历史补录' : operator)
    nextDefects.push(defect)
    createdCodes.push(defectCode(newId))
    nextLedger[index] = {
      项次: sequence,
      缺陷ID: newId,
      缺陷编号: defectCode(newId),
      状态: '待派发',
      派单时间: nowText(),
      操作人: options.backfill ? '历史补录' : operator,
      备注: options.backfill ? '按巡视日期历史补录' : ledger.length > 0 ? '中断重试补派' : '',
    }
  }

  const validItems = nextLedger.filter((item) => item.状态 !== '关联失败')

  // 派单条数与台账/异常项数一致性校验：不过就整笔回滚。
  if (validItems.length !== totalItems - stuckReasons.length || new Set(validItems.map((i) => i.缺陷ID)).size !== validItems.length) {
    return fail(`扣减不成，整笔回滚：派单条数与异常项数对不上（异常 ${totalItems} 项、台账 ${validItems.length} 条），本笔未写入任何数据`)
  }

  const stuckCount = totalItems - validItems.length
  nextPatrol['待派台账'] = nextLedger
  nextPatrol['待派异常项数'] = stuckCount
  nextPatrol['异常项数'] = totalItems
  nextPatrol['派单失败原因'] = stuckReasons.join('；')
  nextPatrol['复核操作人'] = options.backfill ? '历史补录' : operator
  nextPatrol['复核时间'] = nowText()
  if (options.backfill) {
    nextPatrol['补录'] = true
  }
  if (stuckCount === 0) {
    nextPatrol.status = '已完成'
    nextPatrol.pending = false
    nextPatrol.abnormal = false
  } else {
    nextPatrol.status = '待复核'
    nextPatrol.pending = true
    nextPatrol.abnormal = true
  }

  saveAllRows({
    patrol: patrolRows.map((row) => (Number(row.id) === id ? (nextPatrol as EntryRow) : row)),
    defect: nextDefects,
  })

  const codeList = nextLedger.filter((item) => item.状态 !== '关联失败').map((item) => item.缺陷编号).join('、')
  if (stuckCount > 0) {
    return fail(`巡视单 ${patrol['巡视单号']} 已补派 ${createdCodes.length} 张，仍有 ${stuckCount} 项接不上：${stuckReasons.join('；')}。可修正后重试，已派单据不受影响`)
  }
  const verb = ledger.length > 0 ? '中断重试完成' : options.backfill ? '历史补录完成' : '复核派单完成'
  return ok(`${verb}：巡视单 ${patrol['巡视单号']} 的 ${totalItems} 个异常项已全部落入待派台账（${codeList}），两处异常项数一致`)
}

function dispatchedMessage(row: EntryRow, prefix: string): ActionResult {
  const codes = ledgerOf(row)
    .filter((item) => item.状态 !== '关联失败')
    .map((item) => item.缺陷编号)
    .join('、')
  return fail(`${prefix}：该单已派到 ${codes || '待派台账'}（共 ${ledgerOf(row).length} 张）`)
}

// ---------------------------------------------------------------------------
// 消缺单侧：断流重试关联 + 状态回写台账
// ---------------------------------------------------------------------------

/** 取不到对应巡视单的消缺单：不顶旧数据，允许重试；能接上就把两边重新挂牢。 */
export function retryDefectLinkage(defectId: number): ActionResult {
  const defects = listRows('defect')
  const defect = defects.find((row) => Number(row.id) === defectId)
  if (!defect) {
    return fail(`没有找到编号为 ${defectId} 的消缺任务`)
  }
  const patrolNo = String(defect['来源巡视单号'] ?? '').trim()
  if (!patrolNo) {
    return fail(`消缺单 ${defect['缺陷编号']} 不是巡视派生单，无关联可重试`)
  }

  const patrolRows = listRows('patrol')
  const patrol =
    patrolRows.find((row) => Number(row.id) === Number(defect['来源巡视ID'])) ??
    patrolRows.find((row) => String(row['巡视单号']) === patrolNo)

  // 关键：取不到巡视单时原样保留，不用旧数据顶上去。
  if (!patrol) {
    const next = clone(defect)
    next['关联状态'] = '关联失败'
    next['关联失败原因'] = `取不到对应巡视单 ${patrolNo}，现有数据保留未覆盖，请补回巡视单后重试`
    next.abnormal = true
    saveRows('defect', defects.map((row) => (Number(row.id) === defectId ? (next as EntryRow) : row)))
    return fail(`消缺单 ${defect['缺陷编号']} 取不到对应巡视单 ${patrolNo}，已保留原数据并标记，可在巡视单补回后重试，不会顶替旧数据`)
  }

  const sequence = parseCount(defect['来源项次']) || 1
  const totalItems = parseCount(patrol['异常项数'], parseCount(patrol['检查项数']) || undefined)
  const ledger = clone(ledgerOf(patrol))
  const index = sequence - 1

  if (sequence > totalItems && totalItems > 0) {
    return fail(`接不上：巡视单 ${patrolNo} 异常项数只有 ${totalItems}，消缺单 ${defect['缺陷编号']} 自称第 ${sequence} 项，未改动任何数据，请人工核对`)
  }

  const nextDefect = clone(defect)
  nextDefect['来源巡视ID'] = Number(patrol.id)
  nextDefect['来源巡视单号'] = String(patrol['巡视单号'])
  nextDefect['来源项次'] = sequence
  nextDefect['关联状态'] = '已关联'
  nextDefect['关联失败原因'] = ''
  nextDefect.abnormal = false

  ledger[index] = {
    项次: sequence,
    缺陷ID: Number(defect.id),
    缺陷编号: String(defect['缺陷编号']),
    状态: String(defect.status),
    派单时间: ledger[index]?.派单时间 ?? String(defect['派单时间'] ?? nowText()),
    操作人: ledger[index]?.操作人 ?? String(defect['派单操作人'] ?? '断流重试'),
    备注: ledger[index]?.备注 ? ledger[index].备注 : '断流重试关联',
  }

  const nextPatrol = clone(patrol)
  nextPatrol['待派台账'] = ledger
  const linked = ledger.filter((item) => item && item.状态 !== '关联失败').length
  if (String(patrol.status) === '待复核' && linked >= totalItems && totalItems > 0) {
    nextPatrol.status = '已完成'
    nextPatrol.pending = false
    nextPatrol['待派异常项数'] = 0
    nextPatrol['派单失败原因'] = ''
    nextPatrol.abnormal = false
  }

  saveAllRows({
    defect: defects.map((row) => (Number(row.id) === defectId ? (nextDefect as EntryRow) : row)),
    patrol: patrolRows.map((row) => (Number(row.id) === patrol.id ? (nextPatrol as EntryRow) : row)),
  })
  return ok(`消缺单 ${defect['缺陷编号']} 已重新关联到巡视单 ${patrol['巡视单号']} 第 ${sequence} 项，台账已回写`)
}

/** 消缺单状态流转时，把状态同步回巡视单的待派台账，两边始终对得上。 */
export function syncLedgerStatus(defect: EntryRow): void {
  const patrolRows = listRows('patrol')
  let changed = false
  const nextPatrolRows = patrolRows.map((row) => {
    const ledger = ledgerOf(row)
    if (!ledger.some((item) => Number(item.缺陷ID) === Number(defect.id))) {
      return row
    }
    changed = true
    const next: EntryRow = {
      ...row,
      待派台账: ledger.map((item) =>
        Number(item.缺陷ID) === Number(defect.id) ? { ...item, 状态: String(defect.status) } : item,
      ),
    }
    return next
  })
  if (changed) {
    saveRows('patrol', nextPatrolRows)
  }
}

export function isPatrolDerivedDefect(row: EntryRow): boolean {
  return String(row['来源巡视单号'] ?? '').trim().length > 0
}

// ---------------------------------------------------------------------------
// 对账：派单条数、台账、两处异常项数
// ---------------------------------------------------------------------------

export type LedgerMismatch = {
  patrolId: number
  patrolNo: string
  message: string
}

export type LedgerCheck = {
  mismatches: LedgerMismatch[]
  orphans: EntryRow[]
  pendingBackfill: EntryRow[]
}

export function checkDispatchLedgers(): LedgerCheck {
  const mismatches: LedgerMismatch[] = []
  const patrolRows = listRows('patrol')
  const defects = listRows('defect')
  const today = nowText().slice(0, 10)
  const pendingBackfill: EntryRow[] = []

  for (const patrol of patrolRows) {
    const ledger = ledgerOf(patrol)
    const total = parseCount(patrol['异常项数'])
    const patrolNo = String(patrol['巡视单号'] ?? '')

    // 没落过台账：只可能是待派/待复核的在途单或等历史补录的旧单，不属对账差异。
    if (ledger.length === 0) {
      const isHistory = String(patrol.status) === '已完成' || String(patrol['巡视日期'] ?? '').localeCompare(today) < 0
      if (isHistory && total > 0) {
        pendingBackfill.push(patrol)
      }
      continue
    }

    // 断流单（关联失败/取不到巡视单）是待重试的在途异常，不计入任一侧已派条数。
    const linked = defects.filter(
      (row) => String(row['来源巡视单号'] ?? '') === patrolNo && row['关联状态'] !== '关联失败',
    )
    const linkedIds = new Set(linked.map((row) => Number(row.id)))
    const ledgerIds = new Set(ledger.filter((item) => item.状态 !== '关联失败').map((item) => Number(item.缺陷ID)))

    for (const item of ledger) {
      const defect = defects.find((row) => Number(row.id) === Number(item.缺陷ID))
      if (!defect) {
        mismatches.push({ patrolId: Number(patrol.id), patrolNo, message: `台账第 ${item.项次} 项指向的 ${item.缺陷编号} 在消缺台账中不存在` })
      } else if (String(defect.status) !== item.状态) {
        mismatches.push({ patrolId: Number(patrol.id), patrolNo, message: `${item.缺陷编号} 状态不一致：台账「${item.状态}」/ 消缺单「${defect.status}」` })
      }
    }
    if (linkedIds.size !== ledgerIds.size || [...linkedIds].some((id) => !ledgerIds.has(id))) {
      mismatches.push({ patrolId: Number(patrol.id), patrolNo, message: `派单条数与台账不一致：台账 ${ledgerIds.size} 条，消缺侧待派台账 ${linkedIds.size} 条` })
    }
    const waiting = parseCount(patrol['待派异常项数'])
    if (String(patrol.status) === '已完成' && ledgerIds.size !== total) {
      mismatches.push({ patrolId: Number(patrol.id), patrolNo, message: `两处异常项数对不上：巡视单 ${total} 项，已派台账 ${ledgerIds.size} 条` })
    }
    if (String(patrol.status) === '待复核' && ledgerIds.size + waiting !== total) {
      mismatches.push({ patrolId: Number(patrol.id), patrolNo, message: `扣减不平：已派 ${ledgerIds.size} 条 + 待派 ${waiting} 项 ≠ 异常项数 ${total}` })
    }
  }

  const orphans = defects.filter((row) => {
    const no = String(row['来源巡视单号'] ?? '').trim()
    if (!no) {
      return false
    }
    const exists = patrolRows.some(
      (patrol) => Number(patrol.id) === Number(row['来源巡视ID']) || String(patrol['巡视单号']) === no,
    )
    return !exists || row['关联状态'] === '关联失败'
  })
  return { mismatches, orphans, pendingBackfill }
}

// ---------------------------------------------------------------------------
// 历史巡视单：按巡视日期补录
// ---------------------------------------------------------------------------

let backfilled = false

/**
 * 历史单（待复核 / 已完成但没派过单、没有待派台账）按巡视日期从早到晚幂等补录。
 * 有异常项的派生消缺单并落台账；无异常项的直接补盖复核完成。
 */
export function backfillHistoricalPatrols(): ActionResult[] {
  if (backfilled) {
    return []
  }
  backfilled = true
  const results: ActionResult[] = []
  const today = nowText().slice(0, 10)
  // 历史口径：巡视日期早于今天的遗留单，或早就标了已完成但没落台账的单；今天的在途单不碰。
  const candidates = listRows('patrol')
    .filter((row) => {
      if (ledgerOf(row).length > 0) {
        return false
      }
      if (!['待复核', '已完成'].includes(String(row.status))) {
        return false
      }
      return String(row.status) === '已完成' || String(row['巡视日期'] ?? '').localeCompare(today) < 0
    })
    .sort((a, b) => String(a['巡视日期'] ?? '').localeCompare(String(b['巡视日期'] ?? '')))

  for (const patrol of candidates) {
    const total = parseCount(patrol['异常项数'], parseCount(patrol['检查项数']) || undefined)
    if (total === 0) {
      const rows = listRows('patrol')
      const next: EntryRow = {
        ...patrol,
        status: '已完成',
        pending: false,
        abnormal: false,
        异常项数: 0,
        待派异常项数: 0,
        待派台账: [],
        补录: true,
        复核操作人: '历史补录',
        复核时间: nowText(),
        派单失败原因: '',
      }
      saveRows('patrol', rows.map((row) => (Number(row.id) === patrol.id ? next : row)))
      results.push(ok(`历史补录：巡视单 ${patrol['巡视单号']}（${patrol['巡视日期']}）无异常项，补盖复核完成`))
    } else {
      results.push(reviewAndDispatch(Number(patrol.id), '历史补录', { allowNonRoute: true, backfill: true }))
    }
  }
  return results
}
