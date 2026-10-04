<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>巡视检查管理</h2>
        <p class="page-desc">复核派单只派生一次：巡视状态、异常项数扣减与待派台账同事务落盘，扣减不成整笔回滚；中断后可按项续派。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="runLedgerCheck">台账对账</button>
        <button class="btn" type="button" @click="exportRows">导出巡视检查清单</button>
      </div>
    </header>

    <div class="operator-bar">
      <label>
        当前操作人：
        <select v-model="operator" @change="onOperatorChange">
          <option v-for="name in operatorOptions" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <span class="operator-hint">异常项数与复核派单只认本路线巡视人；既巡又修岗（赵六）的复核一律不收</span>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td v-for="column in columns" :key="column">{{ display(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无巡视检查数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡视检查记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <div class="drawer">
        <header class="drawer-head">
          <h3>巡视单 {{ detail['巡视单号'] }} · 详情</h3>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>

        <dl class="detail-grid">
          <div v-for="field in columns" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ display(detail, field) || '—' }}</dd>
          </div>
          <div>
            <dt>待派异常项数</dt>
            <dd>{{ detail['待派异常项数'] ?? '—' }}</dd>
          </div>
          <div>
            <dt>复核操作人/时间</dt>
            <dd>{{ detail['复核操作人'] ? `${detail['复核操作人']} · ${detail['复核时间'] ?? ''}` : '—' }}</dd>
          </div>
          <div v-if="detail['派单失败原因']" class="detail-full detail-warn">
            <dt>中断/失败原因</dt>
            <dd>{{ detail['派单失败原因'] }}</dd>
          </div>
        </dl>

        <section class="ledger-block">
          <h4>待派台账（派生结果已回写消缺侧）</h4>
          <table v-if="ledgerItems.length" class="data-table inner-table">
            <thead>
              <tr>
                <th>异常项次</th><th>缺陷编号</th><th>消缺单状态</th><th>派单时间</th><th>操作人</th><th>备注</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in ledgerItems" :key="item.项次" :class="{ 'row-abnormal': item.状态 === '关联失败' }">
                <td>第 {{ item.项次 }} 项</td>
                <td>{{ item.缺陷编号 }}</td>
                <td>{{ item.状态 }}</td>
                <td>{{ item.派单时间 }}</td>
                <td>{{ item.操作人 }}</td>
                <td>{{ item.备注 || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted-text">尚未派单。</p>
        </section>

        <section class="edit-block">
          <h4>异常项数登记</h4>
          <div class="edit-row">
            <input v-model="abnormalInput" type="number" min="0" :disabled="locked(detail)" />
            <button class="btn primary" type="button" :disabled="locked(detail)" @click="saveAbnormal">
              保存异常项数
            </button>
            <span class="muted-text">派过单后锁定；只有本路线巡视人可改；填不清的旧值按数字辨认并钳到检查项数以内。</span>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getOperator,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  setOperator,
} from '@/api/local-service'
import {
  checkDispatchLedgers,
  ledgerOf,
  updateAbnormalCount,
} from '@/api/patrol-review'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, LedgerItem } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ['巡视单号', '巡视路线', '巡视人员', '巡视日期', '检查项数', '异常项数', '巡视时长', '巡视状态']
const filterFields = columns.slice(0, 3)
const statuses = ['待巡视', '巡视中', '待复核', '已完成']

const session = useSessionStore()
const operator = ref(getOperator())
const operatorOptions = ['值班管理员', '王强', '李娜', '周敏', '孙杰', '赵六']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})

const detail = ref<EntryRow | null>(null)
const abnormalInput = ref('')
const ledgerItems = ref<LedgerItem[]>([])

const stats = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return [
    { label: '今日巡视单', value: rows.value.filter((row) => String(row['巡视日期']) === today).length },
    { label: '巡视中记录', value: rows.value.filter((row) => String(row.status) === '巡视中').length },
    {
      label: '发现异常项',
      value: rows.value
        .filter((row) => String(row.status) !== '待巡视')
        .reduce((sum, row) => sum + Number(row['异常项数'] || 0), 0),
    },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function display(row: EntryRow, column: string): string | number {
  if (column === '异常项数') {
    const waiting = row['待派异常项数']
    return waiting !== undefined && Number(waiting) > 0 ? `${row[column] ?? 0}（待派 ${waiting}）` : String(row[column] ?? 0)
  }
  return String(row[column] ?? '—')
}

function actionsFor(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === '待巡视') {
    return ['开始巡视']
  }
  if (status === '巡视中') {
    return ['提交复核']
  }
  if (status === '待复核') {
    return ['复核派单']
  }
  return []
}

function locked(row: EntryRow): boolean {
  return ledgerOf(row).length > 0 || String(row.status) === '已完成'
}

function notify(result: { ok: boolean; message: string }) {
  message.value = result.message
  messageOk.value = result.ok
}

function onOperatorChange() {
  setOperator(operator.value)
  session.setOperator(operator.value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  message.value = ''
  notify(applyAction(meta.key, Number(row.id), action))
  reload()
}

function openDetail(row: EntryRow) {
  detail.value = row
  abnormalInput.value = String(row['异常项数'] ?? 0)
  ledgerItems.value = ledgerOf(row)
}

function closeDetail() {
  detail.value = null
}

function saveAbnormal() {
  if (!detail.value) {
    return
  }
  const result = updateAbnormalCount(Number(detail.value.id), abnormalInput.value, operator.value)
  notify(result)
  reload()
  if (result.ok) {
    const refreshed = rows.value.find((row) => Number(row.id) === Number(detail.value?.id))
    if (refreshed) {
      openDetail(refreshed)
    }
  }
}

function runLedgerCheck() {
  const { mismatches, orphans, pendingBackfill } = checkDispatchLedgers()
  const notes: string[] = []
  for (const item of mismatches) {
    notes.push(`${item.patrolNo}：${item.message}`)
  }
  for (const defect of orphans) {
    notes.push(`${defect['缺陷编号']}：${defect['关联失败原因'] || '取不到对应巡视单，待重试关联'}`)
  }
  for (const patrol of pendingBackfill) {
    notes.push(`${patrol['巡视单号']}：历史巡视单有 ${patrol['异常项数']} 个异常项尚未补录台账`)
  }
  if (notes.length === 0) {
    notify({ ok: true, message: '对账通过：派单条数、待派台账与两处异常项数全部一致' })
    return
  }
  notify({ ok: false, message: `对账发现 ${notes.length} 处问题——${notes.join('；')}` })
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (detail.value) {
      const refreshed = rows.value.find((row) => Number(row.id) === Number(detail.value?.id))
      if (refreshed) {
        detail.value = refreshed
        ledgerItems.value = ledgerOf(refreshed)
      }
    }
  } catch (error) {
    notify({ ok: false, message: error instanceof Error ? error.message : '巡视检查列表读取失败' })
  }
}

onMounted(reload)
</script>
