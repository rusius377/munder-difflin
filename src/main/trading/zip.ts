/**
 * Read the entries of a .zip archive (Binance's daily data files hold one
 * CSV each). Stored and deflated entries; sizes come from the central
 * directory, so archives written with data descriptors read fine.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry { name: string; data: Buffer }

export function unzip(buf: Buffer): ZipEntry[] {
  // End of central directory: signature 0x06054b50, within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 파일이 아닙니다 (끝 레코드 없음)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 중앙 디렉터리가 손상되었습니다');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip 로컬 헤더가 손상되었습니다');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`지원하지 않는 zip 압축 방식: ${method}`);
  }
  return out;
}

/** The first CSV in an archive (Binance's daily files). */
export function firstCsv(buf: Buffer): Buffer {
  const e = unzip(buf).find((x) => /\.csv$/i.test(x.name)) ?? unzip(buf)[0];
  if (!e) throw new Error('zip 파일이 비어 있습니다');
  return e.data;
}
