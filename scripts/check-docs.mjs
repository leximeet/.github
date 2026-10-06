import { readdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

// 组织仓只核验自己的公开文件，不依赖相邻仓库、外网或历史对话。
export async function verifyDocumentation(repository) {
  const root = resolve(repository)
  const pages = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) pages.push(path)
    }
  }
  await walk(root)
  function localTarget(owner, reference) {
    const path = decodeURIComponent(reference.split(/[?#]/, 1)[0])
    const target = resolve(dirname(owner), path)
    if (!target.startsWith(root + sep)) throw new Error(`引用越出仓库：${reference}`)
    return target
  }
  for (const page of pages) {
    const text = await readFile(page, 'utf8')
    if (/\/Users\/[^/\s]+\/|file:\/\/|(?:^|[(/])dcs\//m.test(text))
      throw new Error('公开正文含私有路径或过程资料引用')
    const references = [
      ...Array.from(text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g), (m) => m[1]),
      ...Array.from(text.matchAll(/\b(?:src|srcset)="([^"]+)"/g), (m) => m[1]),
    ]
    for (const reference of references) {
      if (/^(?:https?:|mailto:|#)/i.test(reference)) continue
      const target = localTarget(page, reference)
      const exists = await stat(target).catch(() => null)
      if (!exists?.isFile()) throw new Error(`引用不存在：${reference}`)
    }
  }
  // 图源、正文可编辑源码与两主题导出共用清单；禁止只更新图片绕过来源核验。
  const sourcesPath = resolve(root, 'docs/diagrams/sources.json')
  let diagrams = 0
  if (await stat(sourcesPath).catch(() => null)) {
    const sources = JSON.parse(await readFile(sourcesPath, 'utf8'))
    const rendered = JSON.parse(
      await readFile(resolve(root, 'docs/diagrams/rendered/manifest.json'), 'utf8'),
    )
    if (
      sources.format !== 1 ||
      rendered.format !== 1 ||
      !sources.diagrams?.length ||
      sources.diagrams.length !== rendered.diagrams?.length
    )
      throw new Error('图表清单不完整')
    for (const source of sources.diagrams) {
      const bytes = await readFile(localTarget(resolve(root, 'README.md'), source.source))
      const output = rendered.diagrams.find((item) => item.source === source.source)
      if (hash(bytes) !== source.sourceSha256 || output?.sourceSha256 !== source.sourceSha256)
        throw new Error('图源与导出摘要不一致')
      const page = await readFile(localTarget(resolve(root, 'README.md'), source.page), 'utf8')
      const block = page
        .split(`<!-- leximeet-diagram: ${source.id} -->`)[1]
        ?.split('<!-- /leximeet-diagram -->')[0]
      const code = /```mermaid\s*\n([\s\S]*?)```/.exec(block ?? '')?.[1]
      if (!code || code.trim() !== bytes.toString('utf8').trim()) throw new Error('正文图源不一致')
      for (const theme of ['light', 'dark']) {
        const image = output.outputs?.[theme]
        const svgPath = localTarget(resolve(root, 'README.md'), image.path)
        const svg = await readFile(svgPath)
        if (hash(svg) !== image.sha256) throw new Error('SVG摘要不一致')
        const refs = Array.from(block.matchAll(/\b(?:src|srcset)="([^"]+)"/g), (m) =>
          localTarget(localTarget(resolve(root, 'README.md'), source.page), m[1]),
        )
        if (!refs.includes(svgPath)) throw new Error('正文未引用清单中的SVG')
        if (
          !svg.includes(Buffer.from('<svg')) ||
          /<script\b|<foreignObject\b/i.test(svg.toString())
        )
          throw new Error('SVG含不允许的可执行或HTML内容')
      }
      diagrams++
    }
  }
  return { pages: pages.length, diagrams }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyDocumentation(dirname(dirname(fileURLToPath(import.meta.url))))
  console.log(`公开文档检查通过：${result.pages}页，${result.diagrams}张明暗图`)
}
