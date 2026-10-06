import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDocumentation } from './check-docs.mjs'

// 每例使用临时资料；无效引用与私有路径必须使CI失败，不能默默跳过。
async function fixture(t, text) {
  const root = await mkdtemp(join(tmpdir(), 'leximeet-org-docs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'README.md'), text)
  return root
}

test('中文相对链接与原图可以独立校验，历史对话不读取', async (t) => {
  const root = await fixture(t, '[说明](说明.md) ![图](图.svg)')
  await writeFile(join(root, '说明.md'), '公开说明')
  await writeFile(join(root, '图.svg'), '<svg/>')
  await mkdir(join(root, '.chat'))
  await writeFile(join(root, '.chat', '历史.md'), '[坏链接](不存在.md)')
  assert.deepEqual(await verifyDocumentation(root), { pages: 2, diagrams: 0 })
})

test('缺失引用阻止发布', async (t) => {
  const root = await fixture(t, '[说明](缺失.md)')
  await assert.rejects(verifyDocumentation(root), /引用不存在/)
})

test('越界引用和私有过程引用不能进入公开文档', async (t) => {
  const root = await fixture(t, '[外部](../说明.md)')
  await assert.rejects(verifyDocumentation(root), /越出仓库/)
  await writeFile(join(root, 'README.md'), '[过程](dcs/过程.md)')
  await assert.rejects(verifyDocumentation(root), /私有路径或过程/)
})

test('实际明暗图与正文一致，改动SVG或正文时拒绝旧清单', async (t) => {
  const root = await fixture(t, '组织入口')
  await mkdir(join(root, 'profile'))
  await cp(new URL('../docs', import.meta.url), join(root, 'docs'), { recursive: true })
  // 只拿当前真实图块，不依赖原仓库其他文档或网络。
  const original = await readFile(new URL('../profile/README.md', import.meta.url), 'utf8')
  const block = /<!-- leximeet-diagram:[\s\S]*?<!-- \/leximeet-diagram -->/.exec(original)[0]
  await writeFile(join(root, 'profile', 'README.md'), block)
  const result = await verifyDocumentation(root)
  assert.equal(result.diagrams, 1)
  const manifest = JSON.parse(
    await readFile(join(root, 'docs/diagrams/rendered/manifest.json'), 'utf8'),
  )
  const svg = join(root, manifest.diagrams[0].outputs.light.path)
  const bytes = await readFile(svg)
  await writeFile(svg, '<svg/>')
  await assert.rejects(verifyDocumentation(root), /SVG摘要不一致/)
  await writeFile(svg, bytes)
  await writeFile(join(root, 'profile', 'README.md'), block.replace('封存 A', '自动合并 A'))
  await assert.rejects(verifyDocumentation(root), /正文图源不一致/)
})
