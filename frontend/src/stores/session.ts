import { defineStore } from 'pinia'

// 演示用登录身份：巡视页面要据此判断「是不是本路线巡视人、是否兼维修岗」。
export const OPERATORS = [
  '值班管理员',
  '李晓峰',
  '王启航',
  '赵清晨',
  '郑检修',
  '孙明远',
  '周雨桐',
] as const

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '光伏电站运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setOperator(name: string) {
      this.operator = name
    },
  },
})
