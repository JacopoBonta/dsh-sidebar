import test from "node:test";
import assert from "node:assert/strict";
import { SidebarGateway, SidebarError } from "../lib/index.js";
import { setTimeout as delay } from "node:timers/promises";

/** One stub workspace row for the registry stub. */
function workspaceRow(id, path) {
	return { id, path, title: id };
}

/** Build a stub ctx with an injectable, counting spawnTerminal. */
function makeTermCtx({ registered = "/ws", spawnImpl, sandboxMode = "danger-full-access" } = {}) {
	const spawned = [];
	const ctx = {
		// cordis Service constructor seams
		reflect: { provide: () => {} },
		effect: (fn) => fn(),
		workspaceRegistry: {
			list: () => [workspaceRow("ws", registered)],
		},
		fs: {
			contains: (parent, child) => {
				const root = parent.targetKey;
				return child.targetKey === root || child.targetKey.startsWith(root + "/");
			},
			resolve: async (path) => {
				const inside = path === registered || path.startsWith(registered + "/");
				if (!inside) throw new Error(`cannot resolve "${path}"`);
				return { targetKey: path, displayPath: path };
			},
		},
		sandboxPolicy: { resolve: () => ({ mode: sandboxMode }) },
		get: () => void 0,
		subprocess: {
			spawnTerminal: async (options) => {
				spawned.push(options);
				return spawnImpl
					? await spawnImpl(options, spawned.length)
					: {
							pid: 1000 + spawned.length,
							done: new Promise(() => {}),
							output: { on() {}, off() {} },
							write: async () => {},
							terminate: async () => {},
						};
			},
		},
	};
	return { ctx, spawned };
}

test("termSpawn serializes concurrent spawns for one workspace into one PTY", async () => {
	// A spawn that stays in flight long enough for a second RPC to interleave.
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const { ctx, spawned } = makeTermCtx({
		spawnImpl: async () => {
			await gate;
			return {
				pid: 4242,
				done: new Promise(() => {}),
				output: { on() {}, off() {} },
				write: async () => {},
				terminate: async () => {},
			};
		},
	});
	const gw = new SidebarGateway(ctx);
	// two overlapping spawns for the same workspace, like a double-click
	const first = gw.termSpawn("/ws");
	const second = gw.termSpawn("/ws");
	await delay(5); // let the second RPC reach the pending check
	release();
	const [a, b] = await Promise.all([first, second]);
	assert.equal(spawned.length, 1, "exactly one PTY must be spawned for concurrent requests");
	assert.equal(a.id, b.id, "both callers must land on the same terminal");
});

test("termSpawn sequential spawns after an in-flight one reuse the same terminal", async () => {
	const { ctx, spawned } = makeTermCtx();
	const gw = new SidebarGateway(ctx);
	const a = await gw.termSpawn("/ws");
	const b = await gw.termSpawn("/ws");
	assert.equal(spawned.length, 1);
	assert.equal(a.id, b.id);
	// pending map is drained after the spawn settles
	assert.equal(gw.pendingSpawns.size, 0);
});

test("termSpawn after a killed terminal respawns fresh", async () => {
	const { ctx, spawned } = makeTermCtx();
	const gw = new SidebarGateway(ctx);
	const a = await gw.termSpawn("/ws");
	await gw.termKill(a.id);
	const b = await gw.termSpawn("/ws");
	assert.equal(spawned.length, 2);
	assert.notEqual(a.id, b.id);
});

test("termWrite rejects a missing text argument instead of typing 'undefined'", async () => {
	const { ctx } = makeTermCtx();
	const gw = new SidebarGateway(ctx);
	const { id } = await gw.termSpawn("/ws");
	await assert.rejects(gw.termWrite(id), (err) => {
		assert.ok(err instanceof SidebarError);
		assert.match(err.message, /no argument/);
		return true;
	});
});

test("termWrite rejects non-string text instead of typing '[object Object]'", async () => {
	const { ctx } = makeTermCtx();
	const gw = new SidebarGateway(ctx);
	const { id } = await gw.termSpawn("/ws");
	await assert.rejects(gw.termWrite(id, {}), (err) => {
		assert.ok(err instanceof SidebarError);
		assert.match(err.message, /object/);
		return true;
	});
	await assert.rejects(gw.termWrite(id, 42), SidebarError);
});

test("termWrite still accepts control and printable strings", async () => {
	const { ctx } = makeTermCtx();
	const gw = new SidebarGateway(ctx);
	const { id } = await gw.termSpawn("/ws");
	assert.deepEqual(await gw.termWrite(id, "echo hi\n"), { ok: true });
	assert.deepEqual(await gw.termWrite(id, "\u001b[A"), { ok: true });
});
