// Minimal ZIP writer (store method, no compression). Images are already
// compressed, so deflating them again would cost time for almost no gain.
(function (root) {
  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  class ZipWriter {
    constructor() {
      this.parts = [];
      this.central = [];
      this.offset = 0;
      this.encoder = new TextEncoder();
    }

    /** @param {string} name  @param {Uint8Array} data */
    add(name, data) {
      const nameBytes = this.encoder.encode(name);
      const crc = crc32(data);
      const { time, day } = dosDateTime(new Date());

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); // local file header signature
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0800, true); // flags: UTF-8 names
      local.setUint16(8, 0, true); // method: store
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true); // central directory signature
      entry.setUint16(4, 20, true); // version made by
      entry.setUint16(6, 20, true); // version needed
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(10, 0, true);
      entry.setUint16(12, time, true);
      entry.setUint16(14, day, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true);
      entry.setUint16(28, nameBytes.length, true);
      entry.setUint32(42, this.offset, true); // offset of local header

      this.parts.push(local.buffer, nameBytes, data);
      this.central.push(entry.buffer, nameBytes);
      this.offset += 30 + nameBytes.length + data.length;
    }

    get size() {
      return this.offset;
    }

    /** @returns {Blob} */
    finish() {
      const count = this.central.length / 2;
      const centralSize = this.central.reduce((n, p) => n + p.byteLength, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); // end of central directory signature
      end.setUint16(8, count, true);
      end.setUint16(10, count, true);
      end.setUint32(12, centralSize, true);
      end.setUint32(16, this.offset, true);
      return new Blob(this.parts.concat(this.central, [end.buffer]), { type: 'application/zip' });
    }
  }

  root.SiteScraperZip = ZipWriter;
})(globalThis);
