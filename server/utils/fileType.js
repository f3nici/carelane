import fs from 'node:fs'

/**
 * Detect a file's true type from its leading "magic bytes", independent of the
 * client-declared Content-Type (which is attacker-controlled — a request can
 * label arbitrary bytes as `application/pdf`). Returns a MIME string for the
 * formats CareLane accepts, or null when the signature is unrecognised.
 * @param {Buffer} buf the first bytes of the file (≥12 recommended)
 * @returns {string|null}
 */
export function detectFileType (buf) {
  if (!buf || buf.length < 4) return null
  // PDF — "%PDF"
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'
  // PNG — \x89PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  // JPEG — FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  // WEBP — "RIFF"...."WEBP"
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  // WebM — EBML header \x1A\x45\xDF\xA3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm'
  // MP4 / MOV / 3GPP — ISO Base Media File Format: bytes 4-7 == 'ftyp'
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.toString('ascii', 8, 12)
    if (brand.startsWith('qt ')) return 'video/quicktime'
    if (brand.startsWith('3gp')) return 'video/3gpp'
    return 'video/mp4'
  }
  return null
}

/**
 * Read the first bytes of a file on disk and detect its true type via
 * {@link detectFileType}. Returns null if the file can't be read.
 * @param {string} filePath
 * @returns {string|null}
 */
export function sniffFileType (filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(12)
    fs.readSync(fd, buf, 0, 12, 0)
    return detectFileType(buf)
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Sanitise a user-supplied filename for use as a Content-Disposition download
 * name: drop control characters (incl. CR/LF, which could otherwise be used for
 * header injection) and path separators, collapse whitespace, and cap the
 * length. Falls back when nothing usable remains.
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function sanitizeDownloadName (name, fallback = 'download') {
  const cleaned = Array.from(String(name || ''))
    .filter(ch => {
      const c = ch.charCodeAt(0)
      if (c < 0x20 || c === 0x7f) return false // control chars (incl. CR/LF)
      return ch !== '/' && ch !== '\\' // path separators
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .trim()
  return cleaned || fallback
}
