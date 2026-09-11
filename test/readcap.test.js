import test from "node:test";
import assert from "node:assert/strict";
import { SidebarGateway, SidebarError } from "../lib/index.js";

/** One stub workspace row for the registry stub. */
function workspaceRow(id, path) {
	return { id, path, title: id };
}

/** Build a stub ctx: registry with one workspace, fs resolving to real host paths, injectable readBytes behavior. */
function makeCtx({ registered = "/ws", readBytesImpl }) {
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
				// mimic the host: realpath-derived key; anything under registered stays
				const inside = path === registered || path.startsWith(registered + "/");
				if (!inside) throw new Error(`cannot resolve "${path}"`);
				return { targetKey: path, displayPath: path };
			},
			lstat: async (path) => (path === registered + "/data.txt" ? { type: "file", size: 10 } : { type: "file", size: 0 }),
			readBytes: readBytesImpl,
		},
	};
	return ctx;
}

/** Instantiate a gateway against a stub ctx. */
function gateway(ctx) {
	return new SidebarGateway(ctx);
}

test("readText clamps to the caller cap with a truncation flag", async () => {
	const ctx = makeCtx({
		readBytesImpl: async (target, signal, maxBytes) => Buffer.alloc(maxBytes, 0x61),
	});
	const gw = gateway(ctx);
	const res = await gw.readText("/ws/data.txt", 64);
	assert.equal(res.content.length, 64);
	assert.equal(res.truncated, true);
	assert.equal(res.size, 10);
	assert.equal(res.tooLarge, undefined);
});

test("readText bounds the read at the readBytes seam before buffering", async () => {
	let observedBound = null;
	let observedMax = null;
	const ctx = makeCtx({
		readBytesImpl: async (target, signal, maxBytes) => {
			observedBound = target.targetKey;
			observedMax = maxBytes;
			return Buffer.alloc(64, 0x62);
		},
	});
	const gw = gateway(ctx);
	await gw.readText("/ws/data.txt", 64);
	assert.equal(observedBound, "/ws/data.txt");
	assert.equal(observedMax, 1024 * 1024, "the read bound must be the full read cap, not the caller's tail cap");
});

// A file that grows between lstat and read (or a symlink whose target outgrew
// its link) is the race the capped seam closes: the host readBytes throws
// FS_TOO_LARGE and the gateway maps it to the panel's tooLarge result instead
// of buffering unbounded content.
test("readText maps an FS_TOO_LARGE failure to the tooLarge result", async () => {
	const ctx = makeCtx({
		readBytesImpl: async () => {
			const error = new Error('cannot read "/ws/data.txt": content exceeds the 1048576-byte limit');
			error.code = "FS_TOO_LARGE";
		 throw error;
		},
	});
	const gw = gateway(ctx);
	const res = await gw.readText("/ws/data.txt", 64);
	assert.equal(res.content, "");
	assert.equal(res.truncated, true);
	assert.equal(res.tooLarge, true);
});

test("readText rethrows non-FS_TOO_LARGE readBytes failures", async () => {
	const ctx = makeCtx({
		readBytesImpl: async () => {
			const error = new Error("permission denied");
			error.code = "FS_PERMISSION_DENIED";
			throw error;
		},
	});
	const gw = gateway(ctx);
	await assert.rejects(gw.readText("/ws/data.txt", 64), (err) => err.code === "FS_PERMISSION_DENIED");
});

test("readText rejects a path outside every registered workspace", async () => {
	const ctx = makeCtx({
		readBytesImpl: async () => Buffer.alloc(8, 0x63),
	});
	const gw = gateway(ctx);
	await assert.rejects(gw.readText("/etc/passwd", 64), (err) => err.message.includes("/etc/passwd"));
});

test("readText rejects binary content with a NUL byte in the leading sample", async () => {
	const ctx = makeCtx({
		readBytesImpl: async (target, signal, maxBytes) => {
			const buffer = Buffer.alloc(maxBytes, 0x41);
			buffer[100] = 0x00;
			return buffer;
		},
	});
	const gw = gateway(ctx);
	await assert.rejects(gw.readText("/ws/data.txt", 64), (err) => err.message.includes("binary file"));
});
