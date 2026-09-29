import type { AssistantApi } from '../shared/types.ts'

declare global {
  interface Window {
    /** Exposé par `preload.cts`. */
    assistant: AssistantApi
  }
}
