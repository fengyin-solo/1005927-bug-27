import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitDatabase,
  database,
  listRows,
  localDomainStore,
  resetRows,
} from '@/data/local-store'
import {
  advancePatrol,
  derivedDefects,
  DomainError,
  getLedger,
  markDefectDispatched,
  resolveSourcePatrol,
  runLedgerChecks,
  updateAbnormalCount,
  type SubmitReviewResult,
} from '@/data/patrol-domain'
import type {
  ActionResult,
  DispatchLedger,
  EntryRow,
  LedgerIssue,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const PATROL_KEY = 'patrol'
const DEFECT_KEY = 'defect'

export { DomainError }

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function fail(error: unknown, fallback: string): ActionResult {
  if (error instanceof DomainError) {
    return {
      ok: false,
      message: error.message,
      code: error.code,
      defectNos: error.defectNos,
    }
  }
  return { ok: false, message: error instanceof Error ? error.message : fallback }
}

/**
 * 巡视单动作：开始巡视 / 提交复核 / 确认完成。
 * 确认完成即复核提交：一次性派生消缺单，失败整笔回滚，中断可重试补齐。
 */
export function runPatrolAction(id: number, action: string): ActionResult & { review?: SubmitReviewResult } {
  try {
    const result = advancePatrol({ store: localDomainStore }, id, action)
    if (action === '确认完成') {
      const review = result as SubmitReviewResult
      return {
        ok: true,
        message:
          `复核${review.resumed ? '断点续派' : '提交'}完成：异常 ${review.abnormalCount} 项，` +
          `本次${review.derivedCount > 0 ? `新派生 ${review.derivedCount} 张` : '未新派生（均已派过）'}，` +
          `待派台账共 ${review.defectNos.length} 张：${review.defectNos.join('、')}`,
        defectNos: review.defectNos,
        review,
      }
    }
    return { ok: true, message: `巡视单已${action}，当前状态「${result.status}」` }
  } catch (error) {
    return fail(error, '巡视操作失败')
  }
}

/** 修改异常项数：仅本路线巡视人、且非维修岗可改；派过单的台账建立后锁死。 */
export function changeAbnormalCount(id: number, operator: string, abnormalCount: number): ActionResult {
  try {
    updateAbnormalCount({ store: localDomainStore }, { patrolId: id, operator, abnormalCount })
    return { ok: true, message: `异常项数已更新为 ${abnormalCount}，台账尚未建立前可继续调整` }
  } catch (error) {
    return fail(error, '异常项数更新失败')
  }
}

/** 巡视详情：已派单据永远以消缺表+台账实链为准，不拿异常项数现算。 */
export function patrolDetail(id: number): {
  patrol: EntryRow
  ledger?: DispatchLedger
  defects: EntryRow[]
} {
  const db = database()
  const patrol = (db.entries[PATROL_KEY] ?? []).find((row) => Number(row.id) === Number(id))
  if (!patrol) {
    throw new DomainError('PATROL_NOT_FOUND', `巡视单 ${id} 取不到，请刷新后重试`, { patrolId: id })
  }
  return {
    patrol,
    ledger: getLedger(db, id),
    defects: derivedDefects(db, id),
  }
}

/** 消缺单对应的来源巡视单：取不到直接报错，允许重试，不顶旧数据。 */
export function defectSourcePatrol(defectId: number): EntryRow {
  const db = database()
  const defect = (db.entries[DEFECT_KEY] ?? []).find((row) => Number(row.id) === Number(defectId))
  if (!defect) {
    throw new DomainError('DEFECT_NOT_FOUND', `消缺单 ${defectId} 取不到，请刷新后重试`)
  }
  return resolveSourcePatrol(db, defect)
}

/**
 * 消缺动作：派发消缺 / 提交验收 / 确认闭环。
 * 「派发消缺」成功后回写巡视侧待派台账行状态，两处条数与状态一致。
 */
export function runDefectAction(id: number, action: string): ActionResult {
  const meta = moduleMeta(DEFECT_KEY)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  try {
    if (action === '派发消缺') {
      const defect = markDefectDispatched({ store: localDomainStore }, id)
      const suffix = String(defect.来源巡视单号 ?? '')
        ? `，已回写巡视单 ${String(defect.来源巡视单号)} 的待派台账`
        : ''
      return { ok: true, message: `消缺单已派发，当前状态「${target}」${suffix}` }
    }
    return genericAction(DEFECT_KEY, id, action)
  } catch (error) {
    return fail(error, '消缺操作失败')
  }
}

function genericAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  commitDatabase({ ...database(), entries: { ...database().entries, [key]: next } })
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 统一动作入口：巡视、消缺走领域规则，其余模块维持通用状态流转。 */
export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === PATROL_KEY) {
    return runPatrolAction(id, action)
  }
  if (key === DEFECT_KEY) {
    return runDefectAction(id, action)
  }
  return genericAction(key, id, action)
}

/** 待派台账核对：两处异常项数、派单条数、逐项实链。 */
export function ledgerChecks(): LedgerIssue[] {
  return runLedgerChecks(database())
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
