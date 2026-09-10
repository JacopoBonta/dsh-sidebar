import test from "node:test";
import assert from "node:assert/strict";
import { TerminalBuffer } from "../lib/index.js";

test("push/read round-trips appended bytes from offset 0", () => {
	const buffer = new TerminalBuffer(1024);
	buffer.push(Buffer.from("hello "));
	buffer.push(Buffer.from("world"));
	const read = buffer.read(0);
	assert.equal(read.text, "hello world");
	assert.equal(read.truncated, false);
	assert.equal(buffer.end, 11);
});

test("read(from) drains only bytes after the caller cursor", () => {
	const buffer = new TerminalBuffer(1024);
	buffer.push(Buffer.from("abcdefgh"));
	assert.equal(buffer.read(3).text, "defgh");
	assert.equal(buffer.read(8).text, "");
	buffer.push(Buffer.from("ij"));
	assert.equal(buffer.read(8).text, "ij");
	assert.equal(buffer.end, 10);
});

test("multi-byte UTF-8 splits land on the right code point", () => {
	const buffer = new TerminalBuffer(1024);
	buffer.push(Buffer.from("héllo", "utf8"));
	// "é" is two bytes: read mid-sequence
	assert.equal(buffer.read(1).text, "éllo");
	assert.equal(buffer.read(3).text, "llo");
});

test("ring evicts oldest chunks and counts dropped bytes", () => {
	const buffer = new TerminalBuffer(8);
	buffer.push(Buffer.from("1234"));
	buffer.push(Buffer.from("5678"));
	assert.equal(buffer.read(0).text, "12345678");
	buffer.push(Buffer.from("9abc"));
	// ring holds the most recent 8 bytes: "56789abc"
	const read = buffer.read(0);
	assert.equal(read.text, "56789abc");
	assert.equal(read.truncated, true);
	assert.equal(buffer.dropped, 4);
	assert.equal(buffer.end, 12);
});

test("read offset inside evicted bytes clamps to the oldest kept byte", () => {
	const buffer = new TerminalBuffer(8);
	buffer.push(Buffer.from("1234"));
	buffer.push(Buffer.from("5678"));
	buffer.push(Buffer.from("9abc"));
	// byte 2 was dropped; read must not throw and must return kept bytes only
	const read = buffer.read(2);
	assert.equal(read.text, "56789abc");
	assert.equal(read.truncated, true);
});

test("read offset beyond the end returns empty text", () => {
	const buffer = new TerminalBuffer(64);
	buffer.push(Buffer.from("abc"));
	assert.equal(buffer.read(100).text, "");
	assert.equal(buffer.read(100).truncated, false);
});

test("a single chunk larger than the whole ring keeps only its tail", () => {
	const buffer = new TerminalBuffer(8);
	buffer.push(Buffer.from("abcdefghijklmnop"));
	const read = buffer.read(0);
	assert.equal(read.text, "ijklmnop");
	assert.equal(read.truncated, true);
	assert.equal(buffer.dropped, 8);
});

test("empty pushes are ignored", () => {
	const buffer = new TerminalBuffer(8);
	buffer.push(Buffer.from(""));
	assert.equal(buffer.end, 0);
	assert.equal(buffer.read(0).text, "");
});

test("push wakes a pending long-poll read", async () => {
	const buffer = new TerminalBuffer(64);
	buffer.push(Buffer.from("first"));
	const pending = buffer.read(5);
	// read(5) returns "" immediately (nothing new) — wake only matters for termRead
	assert.equal(pending.text, "");
	let released = false;
	buffer.wake = () => { released = true; };
	buffer.push(Buffer.from("second"));
	assert.equal(released, true);
	assert.equal(buffer.wake, null);
	assert.equal(buffer.read(5).text, "second");
});

test("wake is consumed exactly once", async () => {
	const buffer = new TerminalBuffer(64);
	let wakeCount = 0;
	buffer.wake = () => { wakeCount += 1; };
	buffer.push(Buffer.from("a"));
	buffer.push(Buffer.from("b"));
	assert.equal(wakeCount, 1);
});
