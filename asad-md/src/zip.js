// src/zip.js — tiny streaming ZIP writer (no dependencies, so nothing extra to install).
//
// Writes straight into a Node writable stream (an HTTP response), one file at a time,
// so memory use stays at "one file" no matter how big the backup is.
// Supports UTF-8 file names, "stored" and "deflate" methods. No zip64 (limit ~4 GB).

import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time: time & 0xffff, date: date & 0xffff }
}

const MAX_TOTAL = 3.5 * 1024 * 1024 * 1024
const MAX_ENTRIES = 65000

export class ZipWriter {
  constructor(out) {
    this.out = out
    this.offset = 0
    this.entries = []
  }

  _write(buf) {
    return new Promise((resolve, reject) => {
      const out = this.out
      if (out.destroyed || out.writableEnded) return reject(new Error('client closed the connection'))
      this.offset += buf.length
      if (out.write(buf)) return resolve()
      const done = (err) => {
        out.off('drain', onDrain)
        out.off('close', onClose)
        out.off('error', onError)
        err ? reject(err) : resolve()
      }
      const onDrain = () => done()
      const onClose = () => done(new Error('client closed the connection'))
      const onError = (e) => done(e)
      out.on('drain', onDrain)
      out.on('close', onClose)
      out.on('error', onError)
    })
  }

  // name: path inside the zip (use "/" as separator). data: Buffer or string.
  async addFile(name, data, { date = new Date(), compress = true } = {}) {
    if (this.entries.length >= MAX_ENTRIES) throw new Error('too many files for one zip')
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    if (this.offset + raw.length > MAX_TOTAL) throw new Error('backup is too large for one zip')

    let body = raw
    let method = 0
    if (compress && raw.length > 128) {
      const z = zlib.deflateRawSync(raw)
      if (z.length < raw.length) { body = z; method = 8 }
    }
    const nameBuf = Buffer.from(name.replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8')
    const crc = crc32(raw)
    const { time, date: dd } = dosDateTime(date)
    const offset = this.offset

    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4) // version needed
    h.writeUInt16LE(0x0800, 6) // UTF-8 names
    h.writeUInt16LE(method, 8)
    h.writeUInt16LE(time, 10)
    h.writeUInt16LE(dd, 12)
    h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(body.length, 18)
    h.writeUInt32LE(raw.length, 22)
    h.writeUInt16LE(nameBuf.length, 26)
    h.writeUInt16LE(0, 28)
    await this._write(Buffer.concat([h, nameBuf]))
    await this._write(body)

    this.entries.push({ nameBuf, method, time, date: dd, crc, csize: body.length, usize: raw.length, offset })
  }

  async finish() {
    const cdStart = this.offset
    for (const e of this.entries) {
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE(20, 4) // version made by
      c.writeUInt16LE(20, 6) // version needed
      c.writeUInt16LE(0x0800, 8)
      c.writeUInt16LE(e.method, 10)
      c.writeUInt16LE(e.time, 12)
      c.writeUInt16LE(e.date, 14)
      c.writeUInt32LE(e.crc, 16)
      c.writeUInt32LE(e.csize, 20)
      c.writeUInt32LE(e.usize, 24)
      c.writeUInt16LE(e.nameBuf.length, 28)
      c.writeUInt16LE(0, 30) // extra
      c.writeUInt16LE(0, 32) // comment
      c.writeUInt16LE(0, 34) // disk
      c.writeUInt16LE(0, 36) // internal attrs
      c.writeUInt32LE(0, 38) // external attrs
      c.writeUInt32LE(e.offset, 42)
      await this._write(Buffer.concat([c, e.nameBuf]))
    }
    const cdSize = this.offset - cdStart
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(cdSize, 12)
    end.writeUInt32LE(cdStart, 16)
    end.writeUInt16LE(0, 20)
    await this._write(end)
    await new Promise((resolve) => this.out.end(resolve))
  }
}
