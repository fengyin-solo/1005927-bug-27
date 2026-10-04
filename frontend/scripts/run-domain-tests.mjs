// 用项目自带的 esbuild 即时转译并运行领域行为测试，无需引入测试框架。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const result = await build({
  entryPoints: ['src/data/domain-tests.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})

const dir = mkdtempSync(join(tmpdir(), 'patrol-tests-'))
const out = join(dir, 'tests.mjs')
writeFileSync(out, result.outputFiles[0].text)

await import(pathToFileURL(out).href)
