import test from "node:test";
import assert from "node:assert/strict";
import { SidebarGateway } from "../lib/index.js";

const DESCRIPTOR_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";

test("gateway prototype carries a version-1 remote-method descriptor", () => {
	const descriptor = Object.getOwnPropertyDescriptor(SidebarGateway.prototype, DESCRIPTOR_KEY);
	assert.ok(descriptor, "descriptor property missing");
	const value = descriptor.value;
	assert.equal(value.version, 1);
	assert.ok(Array.isArray(value.methods));
});

test("descriptor lists every gateway method with direct invocation", () => {
	const descriptor = Object.getOwnPropertyDescriptor(SidebarGateway.prototype, DESCRIPTOR_KEY).value;
	const names = descriptor.methods.map((entry) => entry.method);
	assert.deepEqual(names, [
		"listDir",
		"readText",
		"diff",
		"termSpawn",
		"termRead",
		"termWrite",
		"termKill",
		"workspaces",
	]);
	for (const entry of descriptor.methods) {
		assert.equal(entry.invocation.kind, "direct");
	}
});

test("every declared remote method exists on the prototype", () => {
	const descriptor = Object.getOwnPropertyDescriptor(SidebarGateway.prototype, DESCRIPTOR_KEY).value;
	for (const entry of descriptor.methods) {
		assert.equal(typeof SidebarGateway.prototype[entry.method], "function", `${entry.method} missing`);
	}
});

test("the descriptor is frozen (immutable discovery surface)", () => {
	const descriptor = Object.getOwnPropertyDescriptor(SidebarGateway.prototype, DESCRIPTOR_KEY).value;
	assert.equal(Object.isFrozen(descriptor), true);
	assert.equal(Object.isFrozen(descriptor.methods), true);
});
