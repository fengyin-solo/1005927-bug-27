<template>
  <section class="page" data-module="defect">
    <header class="page-head">
      <div>
        <h2>缺陷消缺管理</h2>
        <p class="page-desc">维护消缺任务，围绕缺陷编号、缺陷类别、发现方式、严重等级做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记消缺任务</button>
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
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
          <td :colspan="columns.length + 2" class="empty-state">暂无缺陷消缺数据，可先登记消缺任务</td>
        </tr>
      </tbody>
    </table>

    <p v-if="orphanHint" class="warn-bar">{{ orphanHint }}</p>

    <footer class="page-foot">
      <span>共 {{ total }} 条缺陷消缺记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { isPatrolDerivedDefect } from '@/api/patrol-review'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('defect')
const columns = ["缺陷编号", "缺陷类别", "发现方式", "严重等级", "责任班组", "要求完成日", "来源巡视单号", "来源项次", "消缺措施", "消缺状态"]
const statuses = ["待派发", "消缺中", "待验收", "已闭环"]
const stats = [{"label": "待派发缺陷", "value": 0}, {"label": "消缺中缺陷", "value": 0}, {"label": "超期未闭环", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["缺陷编号", "缺陷类别", "来源巡视单号"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const orphanHint = computed(() => {
  const orphans = rows.value.filter((row) => row.abnormal || row['关联状态'] === '关联失败')
  if (!orphans.length) {
    return ''
  }
  return `有 ${orphans.length} 张派生消缺单取不到对应巡视单：${orphans.map((row) => row['缺陷编号']).join('、')}。数据原样保留未覆盖，可用「重试关联」在巡视单补回后续挂。`
})

function actionsFor(row: EntryRow): string[] {
  if (isPatrolDerivedDefect(row)) {
    if (row.abnormal || row['关联状态'] === '关联失败') {
      return ['重试关联']
    }
    const status = String(row.status)
    if (status === '待派发') {
      return ['派发消缺', '重试关联']
    }
    if (status === '消缺中') {
      return ['提交验收']
    }
    if (status === '待验收') {
      return ['确认闭环']
    }
    return []
  }
  const status = String(row.status)
  if (status === '待派发') {
    return ['派发消缺']
  }
  if (status === '消缺中') {
    return ['提交验收']
  }
  if (status === '待验收') {
    return ['确认闭环']
  }
  return []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '消缺任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '缺陷消缺列表读取失败'
  }
}

onMounted(reload)
</script>
