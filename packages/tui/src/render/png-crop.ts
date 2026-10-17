import * as zlib from "node:zlib";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface Chunk {
	type: string;
	data: Uint8Array;
}

function readChunks(png: Uint8Array): Chunk[] | null {
	if (png.byteLength < 8 || PNG_SIGNATURE.some((byte, i) => png[i] !== byte)) return null;
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const chunks: Chunk[] = [];
	let offset = 8;
	while (offset + 12 <= png.byteLength) {
		const length = view.getUint32(offset);
		const end = offset + 12 + length;
		if (end > png.byteLength) return null;
		const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
		chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
		offset = end;
		if (type === "IEND") return chunks;
	}
	return null;
}

function writeChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.byteLength);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.byteLength);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.byteLength, Bun.hash.crc32(out.subarray(4, 8 + data.byteLength)) >>> 0);
	return out;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * `png` with its first `skipRows` pixel rows removed, or `null` when the input
 * is not a non-interlaced PNG this can rewrite or nothing would remain.
 * Scanlines are unfiltered (each depends on the row above) and re-emitted
 * unfiltered; ancillary chunks before the image data are kept.
 */
export function cropPngTop(png: Uint8Array, skipRows: number): Uint8Array | null {
	const chunks = readChunks(png);
	const header = chunks?.[0];
	if (!chunks || header?.type !== "IHDR" || header.data.byteLength !== 13) return null;
	const ihdr = new DataView(header.data.buffer, header.data.byteOffset, 13);
	const width = ihdr.getUint32(0);
	const height = ihdr.getUint32(4);
	const bitDepth = header.data[8]!;
	const channels = CHANNELS[header.data[9]!];
	if (channels === undefined || header.data[12] !== 0) return null;
	const skip = Math.trunc(skipRows);
	if (skip <= 0) return png;
	if (skip >= height) return null;

	const bitsPerPixel = channels * bitDepth;
	const bpp = Math.max(1, bitsPerPixel >> 3);
	const stride = Math.ceil((width * bitsPerPixel) / 8);
	let raw: Uint8Array;
	try {
		raw = zlib.inflateSync(Buffer.concat(chunks.filter(c => c.type === "IDAT").map(c => c.data)));
	} catch {
		return null;
	}
	if (raw.byteLength < height * (stride + 1)) return null;

	const keptRows = height - skip;
	const out = new Uint8Array(keptRows * (stride + 1));
	let previous = new Uint8Array(stride);
	let current = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const base = y * (stride + 1);
		const filter = raw[base]!;
		for (let x = 0; x < stride; x++) {
			const value = raw[base + 1 + x]!;
			const left = x >= bpp ? current[x - bpp]! : 0;
			const up = previous[x]!;
			const upLeft = x >= bpp ? previous[x - bpp]! : 0;
			switch (filter) {
				case 0:
					current[x] = value;
					break;
				case 1:
					current[x] = value + left;
					break;
				case 2:
					current[x] = value + up;
					break;
				case 3:
					current[x] = value + ((left + up) >> 1);
					break;
				case 4:
					current[x] = value + paeth(left, up, upLeft);
					break;
				default:
					return null;
			}
		}
		if (y >= skip) out.set(current, (y - skip) * (stride + 1) + 1);
		[previous, current] = [current, previous];
	}

	// Copy, not `slice()`: on a Buffer that is a view into a shared pool.
	const newHeader = new Uint8Array(header.data);
	new DataView(newHeader.buffer, newHeader.byteOffset, newHeader.byteLength).setUint32(4, keptRows);
	const parts: Uint8Array[] = [PNG_SIGNATURE, writeChunk("IHDR", newHeader)];
	for (const chunk of chunks) {
		if (chunk.type === "IDAT") break;
		if (chunk.type !== "IHDR") parts.push(writeChunk(chunk.type, chunk.data));
	}
	parts.push(writeChunk("IDAT", zlib.deflateSync(out)), writeChunk("IEND", new Uint8Array(0)));
	return Buffer.concat(parts);
}
