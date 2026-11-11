// Writes the total duration into a fragmented MP4 from MediaRecorder.
//
// MediaRecorder writes ftyp + moov (no samples, duration 0) and then one
// moof+mdat pair per chunk, so players do not know how long the video is
// until they reach the end: the seek bar's knob keeps jumping while the
// "duration" grows. Here the sample durations of all fragments are added up
// and written into the moov (mvhd, tkhd, mdhd, plus an mvex/mehd box, which
// is where players look for a fragmented file's length). The fragments
// themselves are untouched; their data offsets are relative to each moof,
// so moving them by a few bytes is safe.

import { closeSync, createReadStream, createWriteStream, fstatSync, openSync, readSync, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

interface Box { type: string; start: number; size: number; header: number }

function readBoxAt(fd: number, pos: number, end: number): Box | undefined {
  if (pos + 8 > end) return undefined;
  const h = Buffer.alloc(16);
  readSync(fd, h, 0, 16, pos);
  let size = h.readUInt32BE(0);
  const type = h.toString('latin1', 4, 8);
  let header = 8;
  if (size === 1) { size = Number(h.readBigUInt64BE(8)); header = 16; }
  else if (size === 0) size = end - pos;
  if (size < header || pos + size > end) return undefined;
  return { type, start: pos, size, header };
}

function children(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let p = start; p + 8 <= end;) {
    let size = buf.readUInt32BE(p);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p, size, header });
    p += size;
  }
  return out;
}

const find = (buf: Buffer, parent: Box, type: string) => children(buf, parent.start + parent.header, parent.start + parent.size).find((b) => b.type === type);

/** Duration in the track's timescale, summed over all fragments. */
function fragmentDuration(fd: number, fileSize: number, defaultDuration: number): number {
  let total = 0;
  for (let pos = 0; pos < fileSize;) {
    const box = readBoxAt(fd, pos, fileSize);
    if (!box) break;
    if (box.type === 'moof') {
      const buf = Buffer.alloc(box.size);
      readSync(fd, buf, 0, box.size, box.start);
      const moof: Box = { ...box, start: 0 };
      for (const traf of children(buf, moof.header, moof.size).filter((b) => b.type === 'traf')) {
        const tfhd = find(buf, traf, 'tfhd');
        let sampleDefault = defaultDuration;
        if (tfhd) {
          const flags = buf.readUInt32BE(tfhd.start + tfhd.header) & 0xffffff;
          let p = tfhd.start + tfhd.header + 8; // version/flags + track_ID
          if (flags & 0x01) p += 8; // base_data_offset
          if (flags & 0x02) p += 4; // sample_description_index
          if (flags & 0x08) sampleDefault = buf.readUInt32BE(p);
        }
        for (const trun of children(buf, traf.start + traf.header, traf.start + traf.size).filter((b) => b.type === 'trun')) {
          const flags = buf.readUInt32BE(trun.start + trun.header) & 0xffffff;
          const count = buf.readUInt32BE(trun.start + trun.header + 4);
          let p = trun.start + trun.header + 8;
          if (flags & 0x01) p += 4; // data_offset
          if (flags & 0x04) p += 4; // first_sample_flags
          if (!(flags & 0x100)) { total += count * sampleDefault; continue; }
          const per = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0) + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
          for (let i = 0; i < count; i++, p += per) total += buf.readUInt32BE(p);
        }
      }
    }
    pos += box.size;
  }
  return total;
}

/** Sets a full box's duration field (version 0: u32, version 1: u64) at the given offset from the box body. */
function setDuration(buf: Buffer, box: Box, offsetV0: number, offsetV1: number, value: number) {
  const body = box.start + box.header;
  if (buf[body] === 1) buf.writeBigUInt64BE(BigInt(Math.round(value)), body + offsetV1);
  else buf.writeUInt32BE(Math.min(0xffffffff, Math.round(value)), body + offsetV0);
}

/**
 * Rewrites the file in place with its duration filled in. Returns the
 * duration in milliseconds, or undefined when the file is not a fragmented
 * MP4 it understands (the file is then left as it was).
 */
export async function fixFragmentedMp4Duration(file: string): Promise<number | undefined> {
  const fd = openSync(file, 'r');
  let moovBox: Box | undefined;
  let moov: Buffer;
  let mediaDuration = 0;
  let mediaScale = 1000;
  let fileSize = 0;
  try {
    fileSize = fstatSync(fd).size;
    for (let pos = 0; pos < fileSize;) {
      const box = readBoxAt(fd, pos, fileSize);
      if (!box) break;
      if (box.type === 'moov') { moovBox = box; break; }
      pos += box.size;
    }
    if (!moovBox || moovBox.header !== 8) return undefined;
    moov = Buffer.alloc(moovBox.size);
    readSync(fd, moov, 0, moovBox.size, moovBox.start);
    const root: Box = { ...moovBox, start: 0 };
    const mvhd = find(moov, root, 'mvhd');
    const trak = find(moov, root, 'trak');
    const mvex = find(moov, root, 'mvex');
    const mdia = trak && find(moov, trak, 'mdia');
    const mdhd = mdia && find(moov, mdia, 'mdhd');
    const tkhd = trak && find(moov, trak, 'tkhd');
    if (!mvhd || !mvex || !mdhd || !tkhd || mvex.header !== 8) return undefined;
    const trex = find(moov, mvex, 'trex');
    const defaultDuration = trex ? moov.readUInt32BE(trex.start + trex.header + 12) : 0;
    mediaDuration = fragmentDuration(fd, fileSize, defaultDuration);
    if (!mediaDuration) return undefined;

    const v1 = (b: Box) => moov[b.start + b.header] === 1;
    const movieScale = moov.readUInt32BE(mvhd.start + mvhd.header + (v1(mvhd) ? 20 : 12));
    mediaScale = moov.readUInt32BE(mdhd.start + mdhd.header + (v1(mdhd) ? 20 : 12));
    const movieDuration = (mediaDuration * movieScale) / mediaScale;
    setDuration(moov, mvhd, 16, 24, movieDuration);
    setDuration(moov, mdhd, 16, 24, mediaDuration);
    setDuration(moov, tkhd, 20, 28, movieDuration); // tkhd: track_ID and reserved come first

    // mehd (movie extends header): fragment_duration in the movie timescale.
    const mehd = find(moov, mvex, 'mehd');
    if (mehd) {
      setDuration(moov, mehd, 4, 4, movieDuration);
    } else {
      const box = Buffer.alloc(20);
      box.writeUInt32BE(20, 0);
      box.write('mehd', 4, 'latin1');
      box[8] = 1; // version 1: 64-bit duration
      box.writeBigUInt64BE(BigInt(Math.round(movieDuration)), 12);
      const at = mvex.start + mvex.header;
      moov = Buffer.concat([moov.subarray(0, at), box, moov.subarray(at)]);
      moov.writeUInt32BE(mvex.size + 20, mvex.start);
      moov.writeUInt32BE(moovBox.size + 20, 0);
    }
  } finally {
    closeSync(fd);
  }

  // ftyp … moov(new) … fragments, copied through a temporary file.
  const tmp = `${file}.tmp`;
  const out = createWriteStream(tmp);
  if (moovBox.start > 0) await pipeline(createReadStream(file, { start: 0, end: moovBox.start - 1 }), out, { end: false });
  await new Promise<void>((r, j) => out.write(moov, (e) => (e ? j(e) : r())));
  const after = moovBox.start + moovBox.size;
  if (after < fileSize) await pipeline(createReadStream(file, { start: after }), out);
  else await new Promise<void>((r) => out.end(r));
  renameSync(tmp, file);
  return Math.round((mediaDuration / mediaScale) * 1000);
}
