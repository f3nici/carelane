import { describe, it, expect } from 'vitest'
import { detectFileType, sanitizeDownloadName } from '../server/utils/fileType.js'

describe('detectFileType', () => {
  it('detects PDF, PNG, JPEG and WEBP from magic bytes', () => {
    expect(detectFileType(Buffer.from('%PDF-1.7'))).toBe('application/pdf')
    expect(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
    expect(detectFileType(webp)).toBe('image/webp')
  })

  it('returns null for a forged content type (HTML labelled as a PDF)', () => {
    // The bytes are what matter, not the declared mimetype.
    expect(detectFileType(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull()
    expect(detectFileType(Buffer.from('GIF89a'))).toBeNull()
    expect(detectFileType(Buffer.alloc(2))).toBeNull()
  })
})

describe('sanitizeDownloadName', () => {
  it('strips control characters (CRLF header-injection) and path separators', () => {
    expect(sanitizeDownloadName('report.pdf\r\nSet-Cookie: x=1')).toBe('report.pdfSet-Cookie: x=1')
    expect(sanitizeDownloadName('../../etc/passwd')).toBe('....etcpasswd')
    expect(sanitizeDownloadName('a\\b/c.png')).toBe('abc.png')
  })

  it('falls back when nothing usable remains and caps length', () => {
    expect(sanitizeDownloadName('', 'fallback.pdf')).toBe('fallback.pdf')
    expect(sanitizeDownloadName('   ', 'fallback.pdf')).toBe('fallback.pdf')
    expect(sanitizeDownloadName('a'.repeat(500)).length).toBe(200)
  })
})
