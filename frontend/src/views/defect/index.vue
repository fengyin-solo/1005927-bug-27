<template>
  <section class="page" data-module="defect">
    <header class="page-head">
      <div>
        <h2>缺陷消缺管理</h2>
        <p class="page-desc">巡视复核派生的消缺单自动进入待派台账；派发后回写巡视侧台账行状态，两处异常项数与派单条数保持一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出缺陷消缺清单</button>
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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '来源巡视单号'">
              <button v-if="row[column]" class="link" type="button" @click="showSource(row)">{{ row[column] }}</button>
              <span v-else class="muted-text">非巡视派生</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无缺陷消缺数据</td>
        </tr>
      </tbody>
    </table>

    <div v-if="source" class="detail-panel">
      <header style="display:flex;justify-content:space-between;align-items:center">
        <h3>来源巡视单：{{ source.巡视单号 }}</h3>
        <button class="btn ghost" type="button" @click="source = null">关闭</button>
      </header>
      <dl class="detail-grid">
        <div><dt>巡视路线</dt><dd>{{ source.巡视路线 }}</dd></div>
        <div><dt>巡视人员</dt><dd>{{ source.巡视人员 }}</dd></div>
        <div><dt>巡视日期</dt><dd>{{ source.巡视日期 }}</dd></div>
        <div><dt>异常项数</dt><dd>{{ source.异常项数 }}</dd></div>
        <div><dt>巡视状态</dt><dd>{{ source.status }}</dd></div>
        <div><dt>待派台账</dt><dd>{{ source['待派台账状态'] ?? '未建立' }}（{{ source.派单数 ?? 0 }} 张）</dd></div>
      </dl>
      <p class="muted-text" style="font-size:12px;margin:4px 0 0">来源巡视单每次实时查询；取不到会明确报错并允许重试，不会显示旧数据。</p>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条缺陷消缺记录 · 待派发 {{ pendingCount }} 条来自巡视待派台账</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  defectSourcePatrol,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('defect')
const columns = ['缺陷编号', '缺陷类别', '发现方式', '严重等级', '责任班组', '要求完成日', '消缺措施', '来源巡视单号', '消缺状态']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const banner = ref<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = ['缺陷编号', '缺陷类别', '来源巡视单号']
const source = ref<EntryRow | null>(null)

const stats = computed(() => [
  { label: '待派发缺陷', value: rows.value.filter((row) => String(row.status) === '待派发').length },
  { label: '消缺中缺陷', value: rows.value.filter((row) => String(row.status) === '消缺中').length },
  { label: '巡视派生单', value: rows.value.filter((row) => Boolean(row.来源巡视单号)).length },
])
const pendingCount = computed(() => rows.value.filter((row) => String(row.status) === '待派发' && row.来源巡视单号).length)

const statusOrder = ['待派发', '消缺中', '待验收', '已闭环']
const statusSummary = computed(() =>
  statusOrder.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function availableActions(row: EntryRow): string[] {
  const map: Record<string, string[]> = {
    待派发: ['派发消缺'],
    消缺中: ['提交验收'],
    待验收: ['确认闭环'],
    已闭环: [],
  }
  return map[String(row.status)] ?? []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function showSource(row: EntryRow) {
  banner.value = null
  try {
    source.value = defectSourcePatrol(Number(row.id))
  } catch (error) {
    source.value = null
    banner.value = { kind: 'error', text: error instanceof Error ? error.message : '来源巡视单取不到，请重试' }
  }
}

function runAction(action: string, row: EntryRow) {
  banner.value = null
  const result = applyAction(meta.key, Number(row.id), action)
  banner.value = { kind: result.ok ? 'ok' : 'error', text: result.message }
  reload()
}

function reload() {
  banner.value = null
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    banner.value = { kind: 'error', text: error instanceof Error ? error.message : '缺陷消缺列表读取失败' }
  }
}

onMounted(reload)
</script>
