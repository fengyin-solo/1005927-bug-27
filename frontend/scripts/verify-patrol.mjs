/* eslint-disable */
// 巡视复核派单领域规则验证脚本。
// 用法：node scripts/verify-patrol.mjs（内部用仓库自带 esbuild 即时打包 TS 后执行）
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'

const bundleUrl = new URL('../node_modules/.verify-patrol.bundle.mjs', import.meta.url)
await build({
  entryPoints: [new URL('./verify-patrol.src.mts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { '@': new URL('../src', import.meta.url).pathname },
  outfile: bundleUrl.pathname,
  logLevel: 'silent',
})

process.on('exit', () => {
  try { rmSync(bundleUrl.pathname) } catch {}
})

await import(pathToFileURL(bundleUrl.pathname).href)
