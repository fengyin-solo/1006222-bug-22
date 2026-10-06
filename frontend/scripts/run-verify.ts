// Node 下的内存 localStorage 垫片，仅用于逻辑验证脚本。
class MemoryStorage {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value))
  }
}

;(globalThis as Record<string, unknown>).window = globalThis
;(globalThis as Record<string, unknown>).localStorage = new MemoryStorage()

await import('./verify-transformer.ts')
