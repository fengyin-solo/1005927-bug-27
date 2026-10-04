/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/**
 * 巡视单派生出的待派台账条目：巡视单与消缺单各存一份，互为对账依据。
 * 一旦写入，只能随消缺单状态同步，不允许按异常项数的变化隐式增删。
 */
export type LedgerItem = {
  项次: number
  缺陷ID: number
  缺陷编号: string
  状态: string
  派单时间: string
  操作人: string
  备注: string
}

export type EntryValue = string | number | boolean | LedgerItem[] | null

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: EntryValue
}

export function isLedgerItems(value: EntryValue | undefined): value is LedgerItem[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null && '缺陷编号' in item)
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
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
