import {
  CREW_KEY,
  migrateDatabase,
  STORAGE_VERSION,
  type DomainStore,
} from './patrol-domain'
import { buildSeedDatabase } from './seed'
import type { Database, EntryRow } from './types'

// 本地持久化：整库一份快照放在 localStorage 里，刷新、关掉再打开都还在。
// 巡视状态、异常项数、派生消缺单、待派台账同在这一份里，一次整体写入，天然整笔提交。
const STORAGE_KEY = 'pv-plant-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoredShape =
  | Database
  | Record<string, unknown>

function isDatabase(raw: unknown): raw is Database {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      'entries' in raw &&
      typeof (raw as { entries?: unknown }).entries === 'object',
  )
}

function readStorage(): Database {
  const fallback = buildSeedDatabase()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoredShape
    // 老版本：直接是 Record<模块, 行[]>，没有 entries/台账壳，统一走迁移。
    if (!isDatabase(parsed)) {
      const legacy = parsed as Record<string, EntryRow[]>
      const { db } = migrateDatabase({ version: 1, entries: legacy, dispatchLedgers: {} })
      persist(db)
      return db
    }
    // 版本升级：历史巡视单补录等迁移只跑一次，且幂等。
    if ((parsed.version ?? 1) < STORAGE_VERSION) {
      const { db } = migrateDatabase(parsed)
      persist(db)
      return db
    }
    if (!parsed.dispatchLedgers) {
      parsed.dispatchLedgers = {}
    }
    return parsed
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

function persist(db: Database): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  }
}

let cache: Database | null = null

export function database(): Database {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 整库快照落库：调用方在快照上改完一次性提交，不允许半笔状态停留。 */
export function commitDatabase(db: Database): void {
  // 先持久化、后换缓存：setItem 抛错（如配额不足）时缓存仍是上一笔已提交状态，
  // hydrate 不会读到没落库的半成品，等同整笔回滚。
  persist(db)
  cache = db
}

export function allRows(): Record<string, EntryRow[]> {
  return database().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const db = database()
  commitDatabase({
    ...db,
    entries: { ...db.entries, [key]: rows },
  })
}

export function resetRows(key: string): EntryRow[] {
  const seed = buildSeedDatabase()
  const rows = clone(seed.entries[key] ?? [])
  const db = database()
  if (key === 'patrol' || key === 'defect') {
    // 巡视与消缺由待派台账强耦合：只重置一边会让台账指着已删的单据，
    // 这两张表连同台账一起回到播种态。
    commitDatabase({
      ...db,
      entries: { ...db.entries, patrol: clone(seed.entries.patrol ?? []), defect: clone(seed.entries.defect ?? []) },
      dispatchLedgers: clone(seed.dispatchLedgers),
    })
  } else {
    commitDatabase({
      ...db,
      entries: { ...db.entries, [key]: rows },
    })
  }
  return rows
}

/** 回到首次播种的整库（含历史补录）。 */
export function resetDatabase(): Database {
  const seed = buildSeedDatabase()
  commitDatabase(clone(seed))
  return cache as Database
}

/** 领域层用的存储端口：取快照、整笔提交、维修岗位名单、时钟。 */
export const localDomainStore: DomainStore = {
  hydrate(): Database {
    // 每次 hydrate 返回当前快照的深拷贝，领域内的临时改动不会在提交前泄漏，
    // 校验失败直接丢弃这份拷贝，等同整笔回滚。
    return clone(database())
  },
  commit(db: Database): void {
    // 提交的必须是领域层基于当前快照派生的整库，直接整体落库。
    commitDatabase(clone(db))
  },
  repairNames(): string[] {
    return (listRows(CREW_KEY) ?? [])
      .filter((row) => /维修|检修|消缺/.test(String(row.岗位工种 ?? '')))
      .map((row) => String(row.姓名 ?? ''))
      .filter(Boolean)
  },
  clock(): Date {
    return new Date()
  },
}

export function storageKey(): string {
  return STORAGE_KEY
}
