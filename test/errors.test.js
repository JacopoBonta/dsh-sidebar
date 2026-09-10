import test from "node:test";
import assert from "node:assert/strict";
import { SidebarError, errorRecord } from "../lib/index.js";

test("SidebarError carries the name and optional details", () => {
	const error = new SidebarError("boom", { path: "/tmp/x" });
	assert.ok(error instanceof Error);
	assert.equal(error.name, "SidebarError");
	assert.equal(error.message, "boom");
	assert.deepEqual(error.details, { path: "/tmp/x" });
});

test("SidebarError details default to undefined", () => {
	const error = new SidebarError("boom");
	assert.equal(error.details, undefined);
});

test("errorRecord normalizes Error values to a JSON-safe record", () => {
	const record = errorRecord(new SidebarError("escaped the root"));
	assert.deepEqual(record, { code: "dsh-sidebar/error", message: "escaped the root" });
	assert.equal(JSON.stringify(record).includes("escaped the root"), true);
});

test("errorRecord normalizes non-Error thrown values", () => {
	assert.deepEqual(errorRecord("plain string"), { code: "dsh-sidebar/error", message: "plain string" });
	assert.deepEqual(errorRecord(42), { code: "dsh-sidebar/error", message: "42" });
});
