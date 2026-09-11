import test from "node:test";
import assert from "node:assert/strict";

// window.__ModuleLoader__ stub, then import the client half
globalThis.window = { __ModuleLoader__: { load(def) { globalThis.__captured = def; } } };
await import("../lib/client.js");

const def = globalThis.__captured;
assert.ok(def, "client.js must register with the module loader");
const shim = new Proxy({}, { get: () => () => null });
const exports = def.factory((name) => { if (name === "react") return shim; throw new Error("no module " + name); });
const { samePath, normalizeSegments, resolveShellCwd, matchWorktree, shellCallWorkdir, sessionRow } = exports.internals;
assert.ok(exports.internals, "factory must expose the test seam");

// --- samePath ---

test("samePath ignores trailing slashes", () => {
	assert.equal(samePath("/repo/feature/", "/repo/feature"), true);
	assert.equal(samePath("/repo/feature", "/repo/feature/"), true);
	assert.equal(samePath("/repo/feature", "/repo/main"), false);
});

test("samePath is exact otherwise", () => {
	assert.equal(samePath("/repo/feat", "/repo/feature"), false);
	assert.equal(samePath("/a/b", "/a/b/c"), false);
});

// --- normalizeSegments ---

test("normalizeSegments drops dot segments", () => {
	assert.equal(normalizeSegments("/w/app/./src"), "/w/app/src");
	assert.equal(normalizeSegments("/w/./app"), "/w/app");
});

test("normalizeSegments pops .. against the root like a filesystem", () => {
	assert.equal(normalizeSegments("/w/app/.."), "/w");
	assert.equal(normalizeSegments("/w/app/../.."), "/");
	assert.equal(normalizeSegments("/w/app/../../src"), "/src");
});

test("normalizeSegments keeps unrooted .. (meaningful against an unseen cwd)", () => {
	assert.equal(normalizeSegments("../sibling"), "../sibling");
	assert.equal(normalizeSegments("a/../../b"), "../b");
});

test("normalizeSegments handles root and trailing slashes", () => {
	assert.equal(normalizeSegments("/"), "/");
	assert.equal(normalizeSegments("/w/"), "/w");
	assert.equal(normalizeSegments("/w//app///"), "/w/app");
	assert.equal(normalizeSegments("/w//app"), "/w/app");
});

test("normalizeSegments passes clean paths through", () => {
	assert.equal(normalizeSegments("/w/app/src"), "/w/app/src");
	assert.equal(normalizeSegments("relative/path"), "relative/path");
});

test("normalizeSegments returns Windows paths opaque", () => {
	assert.equal(normalizeSegments("C:\\repo\\app\\.."), "C:\\repo\\app\\..");
	assert.equal(normalizeSegments("\\\\server\\share\\x"), "\\\\server\\share\\x");
});

test("normalizeSegments guards non-strings", () => {
	assert.equal(normalizeSegments(void 0), void 0);
	assert.equal(normalizeSegments(""), "");
});

// --- resolveShellCwd ---

test("resolveShellCwd: omitted workdir is the session workspace", () => {
	assert.equal(resolveShellCwd(void 0, "/w/app"), "/w/app");
	assert.equal(resolveShellCwd("", "/w/app/"), "/w/app");
});

test("resolveShellCwd: omitted workdir without a session cwd is null", () => {
	assert.equal(resolveShellCwd(void 0, void 0), null);
	assert.equal(resolveShellCwd("", ""), null);
});

test("resolveShellCwd joins a relative workdir under the session workspace", () => {
	assert.equal(resolveShellCwd("packages/app", "/w/repo"), "/w/repo/packages/app");
	assert.equal(resolveShellCwd("./lib", "/w/repo"), "/w/repo/lib");
});

test("resolveShellCwd resolves .. inside the joined path", () => {
	assert.equal(resolveShellCwd("sub/../lib", "/w/repo"), "/w/repo/lib");
	assert.equal(resolveShellCwd("..", "/w/repo/pkg"), "/w/repo");
});

test("resolveShellCwd uses an absolute workdir as-is", () => {
	assert.equal(resolveShellCwd("/repo/.worktrees/feature", "/w/app"), "/repo/.worktrees/feature");
	assert.equal(resolveShellCwd("/repo/.worktrees/feature/", "/w/app"), "/repo/.worktrees/feature");
});

test("resolveShellCwd uses a drive-letter absolute path as-is", () => {
	assert.equal(resolveShellCwd("C:\\repo\\wt", "/w/app"), "C:\\repo\\wt");
});

test("resolveShellCwd: relative workdir without a session cwd stays as authored", () => {
	assert.equal(resolveShellCwd("packages/app", void 0), "packages/app");
	assert.equal(resolveShellCwd("../up", void 0), "../up");
});

test("resolveShellCwd guards non-string workdirs", () => {
	assert.equal(resolveShellCwd(null, "/w/app"), "/w/app");
	assert.equal(resolveShellCwd(42, "/w/app"), "/w/app");
});

// --- matchWorktree ---

const WORKTREES = [
	{ path: "/repo/main", branch: "main", head: "aaa", isCurrent: false },
	{ path: "/repo/.worktrees/feature", branch: "feat/x", head: "bbb", isCurrent: false },
];

test("matchWorktree finds the exact row", () => {
	const row = matchWorktree(WORKTREES, "/repo/.worktrees/feature");
	assert.equal(row.branch, "feat/x");
});

test("matchWorktree ignores trailing slashes", () => {
	assert.equal(matchWorktree(WORKTREES, "/repo/main/").branch, "main");
});

test("matchWorktree matches a directory inside a worktree by prefix", () => {
	const row = matchWorktree(WORKTREES, "/repo/.worktrees/feature/packages/app");
	assert.equal(row.branch, "feat/x");
});

test("matchWorktree returns null outside every worktree", () => {
	assert.equal(matchWorktree(WORKTREES, "/somewhere/else"), null);
	assert.equal(matchWorktree(WORKTREES, ""), null);
});

test("matchWorktree guards non-array input", () => {
	assert.equal(matchWorktree(null, "/repo/main"), null);
	assert.equal(matchWorktree("nope", "/repo/main"), null);
	assert.equal(matchWorktree(undefined, "/repo/main"), null);
});

test("matchWorktree skips malformed rows", () => {
	const rows = [null, { branch: "nope" }, ...WORKTREES];
	assert.equal(matchWorktree(rows, "/repo/main").branch, "main");
});

test("matchWorktree prefers exact over prefix", () => {
	const rows = [
		{ path: "/repo", branch: "parent" },
		{ path: "/repo/main", branch: "child" },
	];
	assert.equal(matchWorktree(rows, "/repo/main").branch, "child");
});

// --- shellCallWorkdir ---

test("shellCallWorkdir parses the bash call's workdir", () => {
	const event = { type: "tool/call", data: { name: "bash", arguments: JSON.stringify({ command: "ls", workdir: "/repo/wt" }) } };
	assert.equal(shellCallWorkdir(event), "/repo/wt");
});

test("shellCallWorkdir returns null when workdir is omitted", () => {
	const event = { type: "tool/call", data: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } };
	assert.equal(shellCallWorkdir(event), null);
});

test("shellCallWorkdir returns null for other tools", () => {
	const event = { type: "tool/call", data: { name: "read", arguments: JSON.stringify({ file_path: "/x" }) } };
	assert.equal(shellCallWorkdir(event), null);
});

test("shellCallWorkdir returns null for malformed arguments", () => {
	assert.equal(shellCallWorkdir({ type: "tool/call", data: { name: "bash", arguments: "{not json" } }), null);
	assert.equal(shellCallWorkdir({ type: "tool/call", data: { name: "bash", arguments: "" } }), null);
	assert.equal(shellCallWorkdir({ type: "tool/call", data: { name: "bash", arguments: "[1,2]" } }), null);
});

test("shellCallWorkdir returns null for non-string workdir values", () => {
	const event = { type: "tool/call", data: { name: "bash", arguments: JSON.stringify({ workdir: 42 }) } };
	assert.equal(shellCallWorkdir(event), null);
});

test("shellCallWorkdir guards malformed events", () => {
	assert.equal(shellCallWorkdir(null), null);
	assert.equal(shellCallWorkdir({ type: "other" }), null);
});

// --- sessionRow ---

test("sessionRow finds rows in the array shape", () => {
	const state = { items: [{ sessionId: "s1", cwd: "/a" }, { sessionId: "s2", cwd: "/b" }] };
	assert.equal(sessionRow(state, "s2").cwd, "/b");
	assert.equal(sessionRow(state, "missing"), null);
});

test("sessionRow finds rows in the byId shape", () => {
	const state = { byId: { s1: { cwd: "/a" } } };
	assert.equal(sessionRow(state, "s1").cwd, "/a");
	assert.equal(sessionRow(state, "missing"), null);
});

test("sessionRow guards malformed input", () => {
	assert.equal(sessionRow(null, "s1"), null);
	assert.equal(sessionRow({}, null), null);
	assert.equal(sessionRow({}, "s1"), null);
});
