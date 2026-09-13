import type { MullApi } from './index'

declare global {
  interface Window {
    mull: MullApi
  }
}

export {}
