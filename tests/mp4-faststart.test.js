import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFastStartIndex,
  cachedFastStartIndex,
  clearFastStartIndexCache,
  parseByteRange,
  streamIndexedRange,
  virtualRangeParts
} from '../lib/mp4-faststart.js';

function box(type, payload = Buffer.alloc(0)) {
  const output = Buffer.alloc(8 + payload.length);
  output.writeUInt32BE(output.length, 0);
  output.write(type, 4, 4, 'ascii');
  payload.copy(output, 8);
  return output;
}

function container(type, children) {
  return box(type, Buffer.concat(children));
}

function fixture({ faststart = false } = {}) {
  const ftyp = box('ftyp', Buffer.from('isom0000'));
  const mediaPayload = Buffer.from(Array.from({ length: 180 }, (_, i) => (i * 13) % 251));
  const mdat = box('mdat', mediaPayload);
  const originalChunkOffset = ftyp.length + 8 + 23;
  const stcoPayload = Buffer.alloc(12);
  stcoPayload.writeUInt32BE(1, 4);
  stcoPayload.writeUInt32BE(originalChunkOffset, 8);
  const moov = container('moov', [container('trak', [container('mdia', [container('minf', [container('stbl', [box('stco', stcoPayload)])])])])]);
  const file = faststart ? Buffer.concat([ftyp, moov, mdat]) : Buffer.concat([ftyp, mdat, moov]);
  return { file, ftyp, mdat, moov, originalChunkOffset, marker: file[originalChunkOffset] };
}

function reader(file, calls = []) {
  return async (start, end) => {
    calls.push([start, end]);
    return file.subarray(start, end + 1);
  };
}

async function reconstruct(index, original) {
  const chunks = [];
  await streamIndexedRange({
    index,
    start: 0,
    end: original.length - 1,
    streamOriginal: async (start, end, onChunk) => onChunk(original.subarray(start, end + 1)),
    onChunk: async chunk => chunks.push(Buffer.from(chunk))
  });
  return Buffer.concat(chunks);
}

test('builds a virtual fast-start MP4 and keeps media bytes addressable', async () => {
  const source = fixture();
  const index = await buildFastStartIndex({ size: source.file.length, readRange: reader(source.file) });
  assert.equal(index.mode, 'virtual-faststart');
  assert.equal(index.patchedOffsets, 1);

  const output = await reconstruct(index, source.file);
  assert.equal(output.length, source.file.length);
  assert.equal(output.toString('ascii', 4, 8), 'ftyp');
  assert.equal(output.toString('ascii', source.ftyp.length + 4, source.ftyp.length + 8), 'moov');

  const patchedStco = index.moov.readUInt32BE(index.moov.length - 4);
  assert.equal(patchedStco, source.originalChunkOffset + source.moov.length);
  assert.equal(output[patchedStco], source.marker);
});

test('maps ranges across cached header, moved moov and Telegram media', async () => {
  const source = fixture();
  const index = await buildFastStartIndex({ size: source.file.length, readRange: reader(source.file) });
  const parts = virtualRangeParts(index, 0, source.file.length - 1);
  assert.deepEqual(parts.map(part => part.kind), ['buffer', 'buffer', 'original']);
  assert.equal(parts[2].start, source.ftyp.length);
  assert.equal(parts[2].end, source.ftyp.length + source.mdat.length - 1);
});

test('coalesces ftyp and moov into one first response chunk', async () => {
  const source = fixture();
  const index = await buildFastStartIndex({ size: source.file.length, readRange: reader(source.file) });
  const chunks = [];
  await streamIndexedRange({
    index,
    start: 0,
    end: source.file.length - 1,
    streamOriginal: async (start, end, onChunk) => onChunk(source.file.subarray(start, end + 1)),
    onChunk: async chunk => chunks.push(Buffer.from(chunk))
  });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, source.ftyp.length + source.moov.length);
  assert.equal(chunks[0].toString('ascii', source.ftyp.length + 4, source.ftyp.length + 8), 'moov');
});

test('leaves an already-fast-start file on the safe passthrough path', async () => {
  const source = fixture({ faststart: true });
  const index = await buildFastStartIndex({ size: source.file.length, readRange: reader(source.file) });
  assert.equal(index.mode, 'passthrough');
});

test('parses browser byte ranges including suffix ranges', () => {
  assert.deepEqual(parseByteRange('', 100), { partial: false, start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { partial: true, start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { partial: true, start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { partial: true, start: 90, end: 99 });
  assert.equal(parseByteRange('bytes=100-', 100), null);
  assert.equal(parseByteRange('bytes=0-1,4-5', 100), null);
});

test('deduplicates concurrent index probes in one warm function instance', async () => {
  clearFastStartIndexCache();
  let builds = 0;
  const build = async () => {
    builds += 1;
    return { mode: 'passthrough', size: 10 };
  };
  const [first, second] = await Promise.all([
    cachedFastStartIndex('same-video', build),
    cachedFastStartIndex('same-video', build)
  ]);
  assert.equal(builds, 1);
  assert.equal(first, second);
});
