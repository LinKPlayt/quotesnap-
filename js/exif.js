// Read where and when a JPEG photo was taken from its EXIF data (no library).
// Phones only save this when location is on for the camera, and some photo pickers remove it
// before the browser sees the file, so a missing location is normal: callers fall back to the
// phone's current position.

// -> { lat, lon, takenAt } (any of them may be missing) or null when the file has no EXIF
export function readExif(buf) {
  const v = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null; // not a JPEG
  let p = 2;
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) return null;
    const marker = v.getUint8(p + 1);
    const len = v.getUint16(p + 2);
    if (marker === 0xda || marker === 0xd9) return null; // image data starts: no EXIF before it
    if (marker === 0xe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) {
      try { return parseTiff(v, p + 10, Math.min(v.byteLength, p + 2 + len)); } catch { return null; }
    }
    p += 2 + len;
  }
  return null;
}

function parseTiff(v, start, end) {
  const order = v.getUint16(start);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  const inRange = (o, n) => start + o >= start && start + o + n <= end;
  if (u16(2) !== 42) return null;

  // read one IFD: tag -> { type, count, valueOffset (relative to TIFF start) }
  const ifd = (off) => {
    const tags = {};
    if (!inRange(off, 2)) return tags;
    const n = u16(off);
    for (let i = 0; i < n && i < 500; i++) {
      const e = off + 2 + i * 12;
      if (!inRange(e, 12)) break;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1) * count;
      tags[u16(e)] = { type, count, at: size <= 4 ? e + 8 : u32(e + 8) };
    }
    return tags;
  };
  const ascii = (t) => {
    if (!t || !inRange(t.at, t.count)) return '';
    let s = '';
    for (let i = 0; i < t.count; i++) { const c = v.getUint8(start + t.at + i); if (!c) break; s += String.fromCharCode(c); }
    return s.trim();
  };
  const rationals = (t) => {
    if (!t || t.type !== 5 || !inRange(t.at, t.count * 8)) return null;
    const out = [];
    for (let i = 0; i < t.count; i++) { const d = u32(t.at + i * 8 + 4); out.push(d ? u32(t.at + i * 8) / d : NaN); }
    return out;
  };
  const dms = (r) => (r && r.length >= 3 && r.every(Number.isFinite) ? r[0] + r[1] / 60 + r[2] / 3600 : null);

  const ifd0 = ifd(u32(4));
  const out = {};
  if (ifd0[0x8825]) {
    const g = ifd(ifd0[0x8825].type === 4 ? u32(ifd0[0x8825].at) : ifd0[0x8825].at);
    let lat = dms(rationals(g[2]));
    let lon = dms(rationals(g[4]));
    if (lat !== null && lon !== null && !(lat === 0 && lon === 0)) {
      if (ascii(g[1]).toUpperCase() === 'S') lat = -lat;
      if (ascii(g[3]).toUpperCase() === 'W') lon = -lon;
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { out.lat = Math.round(lat * 1e6) / 1e6; out.lon = Math.round(lon * 1e6) / 1e6; }
    }
  }
  if (ifd0[0x8769]) {
    const ex = ifd(u32(ifd0[0x8769].at));
    const d = ascii(ex[0x9003]) || ascii(ifd0[0x0132]); // "2026:11:05 14:03:22"
    const m = d.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/);
    if (m) out.takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  }
  return out;
}

// Browser helper: read just the start of the file (EXIF sits at the front).
export async function photoLocation(file) {
  try {
    if (!file || !/jpe?g/i.test(file.type || file.name || '')) return null;
    const head = await file.slice(0, 256 * 1024).arrayBuffer();
    const x = readExif(head);
    return x && Number.isFinite(x.lat) ? x : null;
  } catch { return null; }
}
