import { deflateSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

/** A valid PNG of the given size (grayscale, all black). */
export function pngBytes(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 0;
	const rows = height <= 2000 && width <= 2000 ? Buffer.alloc((width + 1) * height) : Buffer.alloc(1);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A JPEG header with a start-of-frame segment (not decodable, enough for probing). */
export function jpegBytes(width: number, height: number): Buffer {
	const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
	const sof = Buffer.from([
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		height >> 8,
		height & 0xff,
		width >> 8,
		width & 0xff,
		3,
		1,
		0x22,
		0,
		2,
		0x11,
		1,
		3,
		0x11,
		1,
	]);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

export function gifBytes(width: number, height: number): Buffer {
	const b = Buffer.from("GIF89a\0\0\0\0\0\0\0", "binary");
	b.writeUInt16LE(width, 6);
	b.writeUInt16LE(height, 8);
	return b;
}

/** A 2x2 GIF with `frames` one-pixel-colour frames; `loop` adds the NETSCAPE2.0 loop block before them. */
export function animatedGifBytes(frames: number, loop = false): Buffer {
	const header = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 2, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]);
	const netscape = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0]);
	const control = Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]);
	const image = Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2, 2, 0x44, 0x01, 0]);
	const parts: Buffer[] = [header];
	if (loop) parts.push(netscape);
	for (let index = 0; index < frames; index += 1) parts.push(control, image);
	parts.push(Buffer.from([0x3b]));
	return Buffer.concat(parts);
}

export function webpBytes(width: number, height: number): Buffer {
	const b = Buffer.alloc(30);
	b.write("RIFF", 0, "ascii");
	b.writeUInt32LE(22, 4);
	b.write("WEBP", 8, "ascii");
	b.write("VP8X", 12, "ascii");
	b.writeUInt32LE(10, 16);
	b.writeUIntLE(width - 1, 24, 3);
	b.writeUIntLE(height - 1, 27, 3);
	return b;
}
