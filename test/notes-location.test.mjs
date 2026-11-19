import assert from 'node:assert/strict'
import test from 'node:test'
import { noteLocation } from '../lib/notes-location.mjs'

const book = (...texts) => ({ paragraphs: texts.map((text) => ({ text })) })

test('location accepts a unique quote in its original paragraph and normalizes whitespace', () => {
  assert.equal(noteLocation(book('前文', '原文  摘录\n后续', '尾声'), { paragraph: 1, quote: '原文\n摘录' }), 1)
})

test('location refuses shifted, edited, missing, image and ambiguous paragraphs', () => {
  const original = book('前文', '独特摘录', '尾声')
  for (const paragraph of [-1, 3, 1.5, undefined, '1']) {
    assert.throws(() => noteLocation(original, { paragraph, quote: '独特摘录' }), /段落已不存在/)
  }
  for (const quote of ['', '  ', null]) {
    assert.throws(() => noteLocation(original, { paragraph: 1, quote }), /没有引用原文/)
  }
  assert.throws(() => noteLocation(book('前文', '插入内容', '独特摘录'), { paragraph: 1, quote: '独特摘录' }), /不匹配/)
  assert.throws(() => noteLocation(book('前文', '独特，摘录'), { paragraph: 1, quote: '独特摘录' }), /不匹配/)
  assert.throws(() => noteLocation(book('前文', ''), { paragraph: 1, quote: '摘录' }), /不匹配/)
  assert.throws(() => noteLocation(book('重复摘录', '另一重复摘录'), { paragraph: 1, quote: '重复摘录' }), /多个段落/)
})
