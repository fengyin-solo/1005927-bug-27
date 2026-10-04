<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">光伏电站运行维护管理平台</h1>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <header class="app-head">
        <span class="head-desc">面向电站台账、组串阵列、逆变器、汇流箱、跟踪支架、组件清洗、告警处置与发电结算的一体化光伏电站运行维护工作台。</span>
        <span class="head-user">
          当前值班：
          <select class="operator-select" :value="store.operator" @change="onOperatorChange">
            <option v-for="name in operators" :key="name" :value="name">{{ name }}</option>
          </select>
          · {{ store.shiftLabel }}
        </span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { useSessionStore, OPERATORS } from '@/stores/session'

const store = useSessionStore()
const operators = OPERATORS

function onOperatorChange(event: Event) {
  store.setOperator((event.target as HTMLSelectElement).value)
}

const navItems = [{ label: "运营概览", path: "/" }, { label: "电站台账", path: "/station" }, { label: "组串阵列", path: "/array" }, { label: "逆变器", path: "/inverter" }, { label: "汇流箱", path: "/combiner" }, { label: "跟踪支架", path: "/tracker" }, { label: "组件清洗", path: "/cleaning" }, { label: "告警事件", path: "/alarm" }, { label: "缺陷消缺", path: "/defect" }, { label: "巡视检查", path: "/patrol" }, { label: "备品备件", path: "/spare" }, { label: "电量计量", path: "/meter" }, { label: "并网调度", path: "/dispatch" }, { label: "辐照监测", path: "/irradiance" }, { label: "安全工器具", path: "/tooling" }, { label: "消防设施", path: "/fire" }, { label: "发电结算", path: "/settlement" }, { label: "运维合同", path: "/contract" }, { label: "运维人员", path: "/crew" }]
</script>
