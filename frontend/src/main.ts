import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { backfillHistoricalPatrols } from './api/patrol-review'
import './styles/global.css'

// 历史巡视单按巡视日期补录（待复核 / 已完成但没落台账的旧单），幂等执行。
backfillHistoricalPatrols()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
