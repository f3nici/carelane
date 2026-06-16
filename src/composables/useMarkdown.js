import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * Render Markdown to sanitized HTML safe for `v-html`. `marked` emits raw HTML
 * (it has no built-in sanitizer), and the bodies we render are AI-drafted,
 * human-edited or RAG-derived — i.e. not fully trusted — so every Markdown
 * string is passed through DOMPurify before it reaches the DOM. This is the
 * single chokepoint for all `v-html` markdown rendering in the app.
 * @param {string} [markdown]
 * @returns {string} sanitized HTML
 */
export function renderMarkdown (markdown) {
  const html = marked.parse(markdown || '')
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
