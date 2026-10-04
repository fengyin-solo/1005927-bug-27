/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

// 字段值允许标量：既有记录里的检查项数/异常项数可能是脏文本，全部用字符串兼容。
export type FieldValue = string | number | boolean
export type RowFields = Record<string, FieldValue>

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: FieldValue
}

// 巡视复核派生出的消缺单逐项挂在待派台账里：一项异常对应一条台账行、一张消缺单。
export type DispatchLedgerItem = {
  seq: number                 // 巡视单内的异常项序号（从 1 起）
  defectId: number | null     // 已派生的消缺单主键，未派生为 null
  defectNo: string | null     // 已派生的消缺单编号
  state: string              // 待派台账行状态：待派生 / 待派发 / 已派发
  dispatchedAt: string | null // 消缺单执行「派发消缺」后回写的时间
}

export type DispatchLedger = {
  patrolNo: string                       // 来源巡视单号
  patrolDate: string                     // 来源巡视日期（YYYY-MM-DD）
  abnormalCount: number                  // 复核确认的异常项数
  items: DispatchLedgerItem[]
  backfilled: boolean                    // 是否为历史巡视单按巡视日期补录
  createdAt: string
  updatedAt: string
}

// 全库一张快照：巡视、消缺、待派台账同一份，一次落库，天然整笔提交。
export type Database = {
  version: number
  entries: Record<string, EntryRow[]>
  dispatchLedgers: Record<number, DispatchLedger> // key 为巡视单 id
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  code?: string
  defectNos?: string[]
}

export type LedgerIssue = {
  patrolId: number
  patrolNo: string
  level: 'error' | 'warn'
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
