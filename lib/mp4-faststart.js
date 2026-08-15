import { getCache } from '@vercel/functions';

const HEAD_PROBE_BYTES = 64 * 1024;
const INITIAL_TAIL_PROBE_BYTES = 256 * 1024;
const MAX_TAIL_PROBE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 96;
const RUNTIME_CACHE_TTL_SECONDS = 6 * 60 * 60;
const RUNTIME_CACHE_MAX_VALUE_BYTES = 1900 * 1024;

const CONTAINER_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta', 'mvex']);
const UNSUPPORTED_OFFSET_TYPES = new Set(['saio', 'iloc', 'sidx', 'tfra']);
const indexCache = new Map();
let runtimeCache;

function defaultSharedCache() {
  if (!process.env.RUNTIME_CACHE_ENDPOINT || !process.env.RUNTIME_CACHE_HEADERS) return null;
  if (!runtimeCache) runtimeCache = getCache({ namespace: 'tgcloner-mp4-faststart-v1' });
  return runtimeCache;
}

function serializeIndex(index) {
  if (!index || !Number.isSafeInteger(index.size) || index.size <= 0) return null;
  const value = index.mode === 'virtual-faststart'
    ? {
        version: 1,
        mode: index.mode,
        size: index.size,
        ftypEnd: index.ftypEnd,
        moovStart: index.moovStart,
        moovEnd: index.moovEnd,
        prefix: Buffer.from(index.prefix).toString('base64'),
        moov: Buffer.from(index.moov).toString('base64'),
        patchedOffsets: index.patchedOffsets
      }
    : {
        version: 1,
        mode: 'passthrough',
        size: index.size,
        reason: String(index.reason || 'unknown')
      };
  return Buffer.byteLength(JSON.stringify(value)) <= RUNTIME_CACHE_MAX_VALUE_BYTES ? value : null;
}

function deserializeIndex(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.size) || value.size <= 0) return null;
  if (value.mode === 'passthrough') return passthrough(value.size, String(value.reason || 'cached_passthrough'));
  if (value.mode !== 'virtual-faststart') return null;
  const prefix = Buffer.from(String(value.prefix || ''), 'base64');
  const moov = Buffer.from(String(value.moov || ''), 'base64');
  if (!prefix.length || !moov.length) return null;
  if (![value.ftypEnd, value.moovStart, value.moovEnd, value.patchedOffsets].every(Number.isSafeInteger)) return null;
  return {
    mode: value.mode,
    size: value.size,
    ftypEnd: value.ftypEnd,
    moovStart: value.moovStart,
    moovEnd: value.moovEnd,
    prefix,
    moov,
    patchedOffsets: value.patchedOffsets,
    cacheSource: 'runtime'
  };
}

function ascii(buffer, start, length) {
  return buffer.toString('ascii', start, start + length);
}

function boxHeader(buffer, offset, limit = buffer.length) {
  if (offset < 0 || offset + 8 > limit) return null;
  let size = buffer.readUInt32BE(offset);
  const type = ascii(buffer, offset + 4, 4);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const large = buffer.readBigUInt64BE(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerSize || offset + size > limit) return null;
  return { offset, size, type, headerSize, end: offset + size };
}

function findMdat(head, totalSize) {
  let offset = 0;
  while (offset + 8 <= head.length) {
    let size = head.readUInt32BE(offset);
    const type = ascii(head, offset + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > head.length) return null;
      const large = head.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      size = totalSize - offset;
    }
    if (size < headerSize || offset + size > totalSize) return null;
    if (type === 'mdat') return { start: offset, end: offset + size, headerSize };
    if (offset + size > head.length) return null;
    offset += size;
  }
  return null;
}

function validMoovChildren(buffer, header) {
  let offset = header.headerSize;
  let children = 0;
  while (offset < header.size) {
    const child = boxHeader(buffer, offset, header.size);
    if (!child) return false;
    children += 1;
    offset = child.end;
  }
  return offset === header.size && children > 0;
}

function findMoovInTail(tail, tailStart, totalSize, minimumStart) {
  for (let i = 4; i + 4 <= tail.length; i += 1) {
    if (ascii(tail, i, 4) !== 'moov') continue;
    const localStart = i - 4;
    const header = boxHeader(tail, localStart, tail.length);
    if (!header || header.type !== 'moov') continue;
    const absoluteStart = tailStart + localStart;
    const absoluteEnd = absoluteStart + header.size;
    if (absoluteStart < minimumStart || absoluteEnd > totalSize) continue;
    const moov = tail.subarray(localStart, localStart + header.size);
    const localHeader = boxHeader(moov, 0, moov.length);
    if (!localHeader || !validMoovChildren(moov, localHeader)) continue;
    return { start: absoluteStart, end: absoluteEnd, buffer: Buffer.from(moov) };
  }
  return null;
}

function patchOffsets(moov, delta, mediaEnd) {
  const output = Buffer.from(moov);
  let patched = 0;

  function walk(start, end, parentType) {
    let offset = start;
    while (offset < end) {
      const header = boxHeader(output, offset, end);
      if (!header) throw new Error('invalid_mp4_box_tree');
      if (UNSUPPORTED_OFFSET_TYPES.has(header.type)) throw new Error(`unsupported_mp4_box_${header.type}`);

      if (header.type === 'stco') {
        const payload = offset + header.headerSize;
        if (payload + 8 > header.end) throw new Error('invalid_stco');
        const count = output.readUInt32BE(payload + 4);
        if (payload + 8 + count * 4 > header.end) throw new Error('invalid_stco_entries');
        for (let i = 0; i < count; i += 1) {
          const entry = payload + 8 + i * 4;
          const oldOffset = output.readUInt32BE(entry);
          if (oldOffset >= mediaEnd) throw new Error('unexpected_stco_offset');
          const nextOffset = oldOffset + delta;
          if (nextOffset > 0xffffffff) throw new Error('stco_overflow');
          output.writeUInt32BE(nextOffset, entry);
          patched += 1;
        }
      } else if (header.type === 'co64') {
        const payload = offset + header.headerSize;
        if (payload + 8 > header.end) throw new Error('invalid_co64');
        const count = output.readUInt32BE(payload + 4);
        if (payload + 8 + count * 8 > header.end) throw new Error('invalid_co64_entries');
        for (let i = 0; i < count; i += 1) {
          const entry = payload + 8 + i * 8;
          const oldOffset = output.readBigUInt64BE(entry);
          if (oldOffset >= BigInt(mediaEnd)) throw new Error('unexpected_co64_offset');
          output.writeBigUInt64BE(oldOffset + BigInt(delta), entry);
          patched += 1;
        }
      } else if (CONTAINER_TYPES.has(header.type)) {
        const fullBoxPrefix = header.type === 'meta' ? 4 : 0;
        walk(offset + header.headerSize + fullBoxPrefix, header.end, header.type);
      }
      offset = header.end;
    }
    if (offset !== end) throw new Error(`invalid_${parentType || 'root'}_boundary`);
  }

  const root = boxHeader(output, 0, output.length);
  if (!root || root.type !== 'moov') throw new Error('invalid_moov');
  walk(root.headerSize, root.end, 'moov');
  if (!patched) throw new Error('mp4_chunk_offsets_missing');
  return { buffer: output, patched };
}

function passthrough(size, reason) {
  return { mode: 'passthrough', size, reason };
}

export function parseByteRange(rangeHeader, size) {
  const raw = String(rangeHeader || '').trim();
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (!raw) return { partial: false, start: 0, end: size - 1 };
  if (!raw.startsWith('bytes=') || raw.includes(',')) return null;
  const match = /^(\d*)-(\d*)$/.exec(raw.slice(6).trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
    end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
    if (!Number.isSafeInteger(end) || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { partial: true, start, end };
}

export function isMp4ProbeRange(range) {
  return Boolean(range?.partial && range.start === 0 && range.end <= 1);
}

export async function buildFastStartIndex({ size, readRange }) {
  if (!Number.isSafeInteger(size) || size < 16) return passthrough(size, 'invalid_size');
  const headEnd = Math.min(size - 1, HEAD_PROBE_BYTES - 1);
  const initialProbeSize = Math.min(size, INITIAL_TAIL_PROBE_BYTES);
  const initialTailStart = size - initialProbeSize;
  const [headBytes, initialTailBytes] = await Promise.all([
    readRange(0, headEnd),
    readRange(initialTailStart, size - 1)
  ]);
  const head = Buffer.from(headBytes);
  if (head.length !== headEnd + 1) return passthrough(size, 'short_head_probe');
  const first = boxHeader(head, 0, head.length);
  if (!first || first.type !== 'ftyp') return passthrough(size, 'ftyp_missing');
  const mdat = findMdat(head, size);
  if (!mdat) return passthrough(size, 'mdat_missing');

  let probeSize = initialProbeSize;
  let tail = Buffer.from(initialTailBytes);
  if (tail.length !== probeSize) return passthrough(size, 'short_tail_probe');
  let located = findMoovInTail(tail, initialTailStart, size, mdat.end);
  while (!located && probeSize <= Math.min(size, MAX_TAIL_PROBE_BYTES)) {
    if (located || probeSize === size || probeSize === MAX_TAIL_PROBE_BYTES) break;
    probeSize = Math.min(size, MAX_TAIL_PROBE_BYTES, probeSize * 2);
    const tailStart = size - probeSize;
    tail = Buffer.from(await readRange(tailStart, size - 1));
    if (tail.length !== probeSize) return passthrough(size, 'short_tail_probe');
    located = findMoovInTail(tail, tailStart, size, mdat.end);
  }
  if (!located) return passthrough(size, 'tail_moov_missing');
  if (located.start < mdat.end) return passthrough(size, 'already_faststart');

  try {
    const patched = patchOffsets(located.buffer, located.buffer.length, located.start);
    return {
      mode: 'virtual-faststart',
      size,
      ftypEnd: first.end,
      moovStart: located.start,
      moovEnd: located.end,
      prefix: Buffer.from(head.subarray(0, first.end)),
      moov: patched.buffer,
      patchedOffsets: patched.patched
    };
  } catch (error) {
    return passthrough(size, error?.message || 'patch_failed');
  }
}

export function virtualRangeParts(index, start, end) {
  if (!index || index.mode !== 'virtual-faststart') {
    return [{ kind: 'original', start, end }];
  }
  const parts = [];
  const moovSize = index.moov.length;
  const virtualMoovStart = index.ftypEnd;
  const virtualMoovEnd = virtualMoovStart + moovSize;
  const shiftedOriginalEnd = index.moovEnd;

  function addBuffer(segmentStart, segmentEnd, buffer) {
    const from = Math.max(start, segmentStart);
    const to = Math.min(end, segmentEnd);
    if (from <= to) parts.push({ kind: 'buffer', buffer, start: from - segmentStart, end: to - segmentStart });
  }
  function addOriginal(segmentStart, segmentEnd, offsetDelta) {
    const from = Math.max(start, segmentStart);
    const to = Math.min(end, segmentEnd);
    if (from <= to) parts.push({ kind: 'original', start: from + offsetDelta, end: to + offsetDelta });
  }

  addBuffer(0, index.ftypEnd - 1, index.prefix);
  addBuffer(virtualMoovStart, virtualMoovEnd - 1, index.moov);
  addOriginal(virtualMoovEnd, shiftedOriginalEnd - 1, -moovSize);
  addOriginal(index.moovEnd, index.size - 1, 0);
  return parts;
}

export async function streamIndexedRange({ index, start, end, streamOriginal, onChunk }) {
  const parts = virtualRangeParts(index, start, end);
  let buffered = [];
  let bufferedBytes = 0;
  async function flushBuffered() {
    if (!bufferedBytes) return;
    const chunk = buffered.length === 1 ? buffered[0] : Buffer.concat(buffered, bufferedBytes);
    buffered = [];
    bufferedBytes = 0;
    await onChunk(chunk);
  }
  for (const part of parts) {
    if (part.kind === 'buffer') {
      const chunk = part.buffer.subarray(part.start, part.end + 1);
      buffered.push(chunk);
      bufferedBytes += chunk.length;
    } else {
      await flushBuffered();
      await streamOriginal(part.start, part.end, onChunk);
    }
  }
  await flushBuffered();
}

export async function cachedFastStartIndex(cacheKey, builder, { sharedCache = defaultSharedCache() } = {}) {
  const now = Date.now();
  const cached = indexCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = (async () => {
    if (sharedCache) {
      try {
        const shared = deserializeIndex(await sharedCache.get(cacheKey));
        if (shared) return shared;
      } catch (error) {
        console.warn('[mp4-faststart] runtime cache read failed', error?.message || error);
      }
    }

    const built = await Promise.resolve().then(builder).catch((error) => passthrough(0, error?.message || 'index_failed'));
    const serialized = serializeIndex(built);
    if (sharedCache && serialized) {
      try {
        await sharedCache.set(cacheKey, serialized, {
          ttl: RUNTIME_CACHE_TTL_SECONDS,
          tags: ['telegram-mp4-faststart'],
          name: 'telegram-mp4-faststart-index'
        });
      } catch (error) {
        console.warn('[mp4-faststart] runtime cache write failed', error?.message || error);
      }
    }
    return built;
  })();
  indexCache.set(cacheKey, { promise, expiresAt: now + CACHE_TTL_MS });
  if (indexCache.size > CACHE_MAX_ENTRIES) {
    const oldest = indexCache.keys().next().value;
    if (oldest !== undefined) indexCache.delete(oldest);
  }
  return promise;
}

export function clearFastStartIndexCache() {
  indexCache.clear();
}
