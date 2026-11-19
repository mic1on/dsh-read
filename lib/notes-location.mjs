// A saved index is only usable when its quote still identifies that paragraph.
function normalized(text) {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : ''
}

export function noteLocation(book, note) {
  const index = note.paragraph
  if (!Number.isInteger(index) || index < 0 || index >= book.paragraphs.length) {
    throw new Error('批注段落已不存在，书籍内容可能已变化，无法可靠定位。')
  }
  const quote = normalized(note.quote)
  if (!quote) throw new Error('这条批注没有引用原文，无法可靠定位。')
  if (!normalized(book.paragraphs[index].text).includes(quote)) {
    throw new Error('原段落与批注摘录不匹配，书籍内容可能已变化；未跳转，请核对原书。')
  }
  for (let at = 0; at < book.paragraphs.length; at += 1) {
    if (at !== index && normalized(book.paragraphs[at].text).includes(quote)) {
      throw new Error('摘录在多个段落中出现，无法可靠定位；请核对原书。')
    }
  }
  return index
}
