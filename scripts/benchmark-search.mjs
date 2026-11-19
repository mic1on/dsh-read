// Reproducible 10 MiB / 50,000 paragraph search benchmark; no external book needed.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, platform, arch, cpus } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { loadBook, publicBook } from '../lib/book.mjs'
import { searchBook } from '../lib/book-search.mjs'

export function benchmarkText() {
  const body = '长夜微风吹过河岸，读者沿着章节寻找原文。'.repeat(3)
  return Array.from({ length: 50000 }, (_, i) => `${i % 1000 === 0 ? `第 ${i / 1000 + 1} 章\n\n` : ''}段落 ${i}: ${body} ${'a'.repeat(25)}${i % 1000 === 999 ? ' lighthouse 稀疏命中' : ''}`).join('\n\n')
}

export async function benchmarkSearch({ bookPath, output } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-benchmark-'))
  try {
    const text = benchmarkText()
    const path = bookPath ? resolve(bookPath) : join(directory, 'large-book.txt')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    const before = performance.now()
    const book = await loadBook(path)
    const parseMs = performance.now() - before
    const measurements = []
    for (const [name, query] of [['dense', '原文'], ['sparse', 'LIGHTHOUSE'], ['absent', '未出现的唯一关键词']]) {
      const first = await searchBook(book, { query })
      for (const [page, cursor] of [['first', undefined], ...(first.nextCursor ? [['next', first.nextCursor]] : [])]) {
        const durations = []
        let returned = 0
        for (let i = 0; i < 20; i += 1) {
          const start = performance.now()
          const result = await searchBook(book, { query, cursor })
          durations.push(performance.now() - start)
          returned = result.results.length
          assert.ok(returned <= 20)
        }
        durations.sort((a, b) => a - b)
        const p95Ms = durations[Math.ceil(durations.length * .95) - 1]
        measurements.push({ scenario: name, page, samples: 20, returned, p95Ms: +p95Ms.toFixed(3), maxMs: +durations.at(-1).toFixed(3) })
        assert.ok(p95Ms <= 500, `${name} ${page}: P95 ${p95Ms.toFixed(2)} ms exceeds 500 ms`)
      }
    }
    const report = { measuredAt: new Date().toISOString(), node: process.version,
      platform: `${platform()} ${arch()}`, cpu: cpus()[0]?.model,
      bytes: Buffer.byteLength(text), paragraphs: book.paragraphCount, chars: book.chars,
      parseMs: +parseMs.toFixed(3), measurements, book: publicBook(book) }
    if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n') }
    return report
  } finally { await rm(directory, { recursive: true, force: true }) }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await benchmarkSearch({ output: process.argv[2] }), null, 2))
}
