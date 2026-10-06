import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { ensureDataV2 } from './domain/transformer/migration'
import './styles/global.css'

// 挂载前先跑一次性数据迁移（老数据按原编号迁移、缺项补齐、历史告警回填）。
ensureDataV2()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
