import test from "node:test";
import assert from "node:assert/strict";
import { tail } from "../lib/index.js";

test("tail passes through short buffers without truncation", () => {
	const result = tail(Buffer.from("hello", "utf8"), 16);
	assert.equal(result.text, "hello");
	assert.equal(result.truncated, false);
});

test("tail keeps the last maxBytes when the buffer overflows", () => {
	const result = tail(Buffer.from("abcdefgh", "utf8"), 4);
	assert.equal(result.text, "efgh");
	assert.equal(result.truncated, true);
});

test("tail drops a partial leading UTF-8 sequence", () => {
	// "é" = 0xC3 0xA9, "héllo" = 68 C3 A9 6C 6C 6F. A 5-byte tail starting mid-
	// sequence would begin with 0xA9; the helper must skip it.
	const buffer = Buffer.from("héllo", "utf8");
	const result = tail(buffer, 5);
	assert.equal(result.text, "éllo");
	assert.equal(result.truncated, true);
});

test("tail decodes four-byte emoji cleanly at the boundary", () => {
	const buffer = Buffer.from("x👍y", "utf8"); // 1 + 4 + 1 bytes
	const result = tail(buffer, 4);
	// tail starts inside the emoji: the partial sequence is dropped, "y" remains
	assert.equal(result.text, "y");
	assert.equal(result.truncated, true);
});

test("tail with zero maxBytes returns empty text", () => {
	const result = tail(Buffer.from("abc", "utf8"), 0);
	assert.equal(result.text, "");
	assert.equal(result.truncated, true);
});
