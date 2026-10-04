<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>巡视检查管理</h2>
        <p class="page-desc">巡视单逐级流转，复核时一次性派生消缺单并回写消缺侧待派台账；已派单的巡视单锁定，异常项数仅本路线巡视人可维护。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="checkLedger">核对待派台账</button>
        <button class="btn" type="button" @click="exportRows">导出巡视检查清单</button>
      </div>
    </header>

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

    <div v-if="banner" class="banner" :class="banner.kind">{{ banner.text }}</div>
    <div v-if="issues.length" class="banner warn">
      <strong>待派台账核对发现 {{ issues.length }} 处问题：</strong>
      <ul style="margin:6px 0 0 18px;padding:0">
        <li v-for="(issue, index) in issues" :key="index">
          [{{ issue.level === 'error' ? '错误' : '提示' }}] 巡视单 {{ issue.patrolNo }}：{{ issue.message }}
        </li>
      </ul>
    </div>

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
          <th>待派台账</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            {{ row[column] ?? '—' }}
            <span v-if="column === '异常项数' && row['异常项数待核实'] === '是'" class="tag warn">待核实</span>
          </td>
          <td>{{ row.status }}</td>
          <td>
            <button class="link" type="button" @click="openDetail(row)">
              {{ row['待派台账状态'] ?? '未建立' }}（{{ row['派单数'] ?? 0 }} 张）
            </button>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
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
          <td :colspan="columns.length + 3" class="empty-state">暂无巡视检查数据</td>
        </tr>
      </tbody>
    </table>

    <div v-if="detail" class="detail-panel">
      <header style="display:flex;justify-content:space-between;align-items:center">
        <h3>巡视单详情：{{ detail.patrol.巡视单号 }} · {{ detail.patrol.巡视路线 }}</h3>
        <button class="btn ghost" type="button" @click="detail = null">关闭</button>
      </header>
      <dl class="detail-grid">
        <div><dt>巡视状态</dt><dd>{{ detail.patrol.status }}</dd></div>
        <div><dt>巡视人员</dt><dd>{{ detail.patrol.巡视人员 }}</dd></div>
        <div><dt>巡视日期</dt><dd>{{ detail.patrol.巡视日期 }}</dd></div>
        <div><dt>检查项数</dt><dd>{{ detail.patrol.检查项数 }}</dd></div>
        <div><dt>异常项数</dt><dd>{{ detail.patrol.异常项数 }} <span v-if="detail.patrol['异常项数待核实'] === '是'" class="tag warn">待核实</span></dd></div>
        <div><dt>台账记录异常项</dt><dd>{{ detail.ledger ? detail.ledger.abnormalCount : '—' }}</dd></div>
        <div v-if="detail.patrol.中断原因"><dt>挂起原因</dt><dd class="warn-text">{{ detail.patrol.中断原因 }}</dd></div>
      </dl>

      <div v-if="!detail.ledger" class="muted-text" style="font-size:13px;margin:6px 0">
        台账未建立：复核提交时才会一次性派生；当前操作人「{{ store.operator }}」
        <template v-if="canEditAbnormal(detail.patrol)">可维护异常项数</template>
        <template v-else>无权维护（须为本路线巡视人且非维修岗）</template>
      </div>

      <form v-if="canEditAbnormal(detail.patrol)" class="inline-form" @submit.prevent="saveAbnormal">
        <label>异常项数：
          <input v-model.number="abnormalDraft" type="number" min="0" step="1" />
        </label>
        <button class="btn" type="submit">保存异常项数</button>
      </form>

      <h3 style="margin-top:10px">已派消缺单（{{ detail.defects.length }} 张，以消缺表与台账实链为准）</h3>
      <table v-if="detail.defects.length" class="data-table">
        <thead>
          <tr><th>异常项序号</th><th>缺陷编号</th><th>严重等级</th><th>消缺状态</th><th>发现方式</th><th>要求完成日</th></tr>
        </thead>
        <tbody>
          <tr v-for="defect in detail.defects" :key="String(defect.id)">
            <td>第 {{ defect.异常项序号 }} 项</td>
            <td>{{ defect.缺陷编号 }}</td>
            <td>{{ defect.严重等级 }}</td>
            <td>{{ defect.status }}</td>
            <td>{{ defect.发现方式 }}</td>
            <td>{{ defect.要求完成日 || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted-text" style="font-size:13px">尚未派生出消缺单。</p>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡视检查记录 · 派生只发生一次，提交中断可点「确认完成」重试补齐</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  changeAbnormalCount,
  downloadEntries,
  ledgerChecks,
  listEntries,
  moduleMeta,
  patrolDetail,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, LedgerIssue } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ['巡视单号', '巡视路线', '巡视人员', '巡视日期', '检查项数', '异常项数', '巡视时长', '巡视状态']
const store = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const banner = ref<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)
const issues = ref<LedgerIssue[]>([])
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const detail = ref<ReturnType<typeof patrolDetail> | null>(null)
const abnormalDraft = ref(0)

const stats = computed(() => [
  { label: '巡视单总数', value: rows.value.length },
  { label: '巡视中/待复核', value: rows.value.filter((row) => ['巡视中', '待复核'].includes(String(row.status))).length },
  { label: '已派消缺单', value: rows.value.reduce((sum, row) => sum + Number(row.派单数 ?? 0), 0) },
])

const statusOrder = ['待巡视', '巡视中', '待复核', '已完成']
const statusSummary = computed(() =>
  statusOrder.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 逐级流转：每一行只给当前状态允许的下一步动作，跳级根本点不到。
function availableActions(row: EntryRow): string[] {
  const map: Record<string, string[]> = {
    待巡视: ['开始巡视'],
    巡视中: ['提交复核'],
    待复核: ['确认完成'],
    已完成: [],
  }
  return map[String(row.status)] ?? []
}

function canEditAbnormal(patrol: EntryRow): boolean {
  if (String(patrol.status) === '已完成') {
    return false
  }
  if (patrol['待派台账状态'] && patrol['待派台账状态'] !== '未建立') {
    return false
  }
  const names = String(patrol.巡视人员 ?? '').split(/[、,，\/\s]+/).filter(Boolean)
  return names.includes(store.operator)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openDetail(row: EntryRow) {
  banner.value = null
  try {
    detail.value = patrolDetail(Number(row.id))
    abnormalDraft.value = Number(detail.value.patrol.异常项数 ?? 0)
  } catch (error) {
    banner.value = { kind: 'error', text: error instanceof Error ? error.message : '巡视详情取不到，请重试' }
  }
}

function saveAbnormal() {
  if (!detail.value) {
    return
  }
  const result = changeAbnormalCount(Number(detail.value.patrol.id), store.operator, Number(abnormalDraft.value))
  banner.value = { kind: result.ok ? 'ok' : 'error', text: result.message }
  if (result.ok) {
    reload()
    openDetail(detail.value.patrol)
  }
}

function runAction(action: string, row: EntryRow) {
  banner.value = null
  const result = applyAction(meta.key, Number(row.id), action)
  banner.value = { kind: result.ok ? 'ok' : 'error', text: result.message }
  reload()
  if (detail.value && Number(detail.value.patrol.id) === Number(row.id)) {
    openDetail(row)
  }
}

function checkLedger() {
  issues.value = ledgerChecks()
  if (!issues.value.length) {
    banner.value = { kind: 'ok', text: '待派台账核对通过：两处异常项数一致，派单条数与台账逐项对得上。' }
  } else {
    banner.value = null
  }
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    banner.value = { kind: 'error', text: error instanceof Error ? error.message : '巡视检查列表读取失败' }
  }
}

onMounted(reload)
</script>
