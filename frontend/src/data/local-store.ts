import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pv-plant-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return mergeSeed(fallback, parsed)
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

/**
 * 种子与本地数据合并：
 * - 同 id 记录以本地改动为准，但种子里新增的字段（巡视人员真实姓名、待派台账等）补进去，
 *   老版本浏览器里的旧结构数据升级后依然能跑；
 * - 本地值若还是生成器留下的占位样例（「XX样例N」），视为没被用户改过，让位于新种子；
 * - 本地多出的记录原样保留。
 */
export function mergeSeed(
  seed: Record<string, EntryRow[]>,
  stored: Record<string, EntryRow[]>,
): Record<string, EntryRow[]> {
  const merged: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(seed)) {
    const seedRows = seed[key] ?? []
    const storedRows = stored[key] ?? []
    const storedById = new Map(storedRows.map((row) => [Number(row.id), row]))
    const next = seedRows.map((seedRow) => {
      const local = storedById.get(Number(seedRow.id))
      if (!local) {
        return seedRow
      }
      const picked: EntryRow = { ...seedRow }
      for (const [field, value] of Object.entries(local)) {
        if (value !== '' && !(typeof value === 'string' && /样例\d*$/.test(value))) {
          picked[field] = value
        }
      }
      return picked
    })
    const seedIds = new Set(seedRows.map((row) => Number(row.id)))
    for (const row of storedRows) {
      if (!seedIds.has(Number(row.id))) {
        next.push(row)
      }
    }
    merged[key] = next
  }
  for (const key of Object.keys(stored)) {
    if (!(key in merged)) {
      merged[key] = stored[key]
    }
  }
  return merged
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveAllRows({ [key]: rows })
}

/**
 * 一次提交多个模块：要么整笔落盘，要么完全不动。
 * 巡视扣减异常项数 + 写待派台账 + 派生消缺单必须同一份写入，扣减不成就整笔回滚。
 */
export function saveAllRows(patch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...patch }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
