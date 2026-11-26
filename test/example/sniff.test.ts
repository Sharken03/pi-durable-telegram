import assert from "node:assert/strict";
import { test } from "node:test";
import { heifBrand, isOle, isPdf, isZip } from "../../src/media/sniff.ts";

function ftyp(major: string, compatible: string[] = []): Buffer {
	const size = 16 + 4 * compatible.length;
	const box = Buffer.alloc(size + 8);
	box.writeUInt32BE(size, 0);
	box.write(`ftyp${major}`, 4, "latin1");
	compatible.forEach((brand, index) => box.write(brand, 16 + 4 * index, "latin1"));
	return box;
}

test("sniff: formats by content, never by name", () => {
	assert.equal(isPdf(Buffer.from("%PDF-1.4\n")), true);
	assert.equal(isPdf(Buffer.concat([Buffer.alloc(500, 0x20), Buffer.from("%PDF-1.7")])), true, "junk before the header");
	assert.equal(isPdf(Buffer.concat([Buffer.alloc(1100, 0x20), Buffer.from("%PDF-1.7")])), false);
	assert.equal(isPdf(Buffer.from("PDF-1.4")), false);
	assert.equal(heifBrand(ftyp("heic")), "heic");
	assert.equal(heifBrand(ftyp("avif")), "avif");
	assert.equal(heifBrand(ftyp("isom", ["mp41", "mif1"])), "mif1", "a compatible brand counts");
	assert.equal(heifBrand(ftyp("isom", ["mp41", "avc1"])), undefined, "an MP4 video is not HEIF");
	assert.equal(heifBrand(Buffer.from("....ftyp")), undefined);
	assert.equal(isZip(Buffer.from("PK\x03\x04rest", "latin1")), true);
	assert.equal(isZip(Buffer.from("PK\x05\x06", "latin1")), false);
	assert.equal(isOle(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])), true);
	assert.equal(isOle(Buffer.from([0xd0, 0xcf, 0x11])), false);
});
