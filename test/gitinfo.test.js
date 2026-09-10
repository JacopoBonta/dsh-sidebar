import test from "node:test";
import assert from "node:assert/strict";
import { parseWorktreeList, repoInfo } from "../lib/index.js";

const TWO_WORKTREES = [
	"worktree /repo/main",
	"HEAD 7632a49e81f241a586cbf258f38b69f82553d22b",
	"branch refs/heads/main",
	"",
	"worktree /repo/feature",
	"HEAD dae426950a6b7a7844d175ea9e458d5c70f34302",
	"branch refs/heads/feature-x",
	"",
].join("\n");

test("parseWorktreeList locates the current row by exact path", () => {
	const parsed = parseWorktreeList(TWO_WORKTREES, "/repo/feature");
	assert.equal(parsed.worktrees.length, 2);
	assert.equal(parsed.current.branch, "feature-x");
	assert.equal(parsed.current.head, "dae426950a6b7a7844d175ea9e458d5c70f34302");
	assert.equal(parsed.worktrees[0].isCurrent, false);
	assert.equal(parsed.worktrees[1].isCurrent, true);
});

test("parseWorktreeList matches a workspace inside a worktree by prefix", () => {
	const parsed = parseWorktreeList(TWO_WORKTREES, "/repo/feature/packages/app");
	assert.equal(parsed.current.branch, "feature-x");
	assert.equal(parsed.current.path, "/repo/feature");
});

test("parseWorktreeList marks detached HEAD (no branch line)", () => {
	const text = [
		"worktree /repo/main",
		"HEAD 7632a49e81f241a586cbf258f38b69f82553d22b",
		"branch refs/heads/main",
		"",
		"worktree /repo/detached",
		"HEAD dae426950a6b7a7844d175ea9e458d5c70f34302",
		"",
	].join("\n");
	const parsed = parseWorktreeList(text, "/repo/detached");
	assert.equal(parsed.current.branch, null);
	assert.equal(parsed.current.head, "dae426950a6b7a7844d175ea9e458d5c70f34302");
});

test("parseWorktreeList tolerates a fresh repo (missing HEAD line)", () => {
	const text = "worktree /repo/fresh\nbranch refs/heads/main\n";
	const parsed = parseWorktreeList(text, "/repo/fresh");
	assert.equal(parsed.current.branch, "main");
	assert.equal(parsed.current.head, null);
});

test("parseWorktreeList parses a bare entry", () => {
	const text = [
		"worktree /srv/repo.git",
		"bare",
		"",
		"worktree /srv/checkout",
		"HEAD 7632a49e81f241a586cbf258f38b69f82553d22b",
		"branch refs/heads/main",
		"",
	].join("\n");
	const parsed = parseWorktreeList(text, "/srv/checkout");
	assert.equal(parsed.worktrees[0].bare, true);
	assert.equal(parsed.worktrees[0].branch, null);
	assert.equal(parsed.current.branch, "main");
});

test("parseWorktreeList ignores trailing slashes when matching", () => {
	const parsed = parseWorktreeList(TWO_WORKTREES, "/repo/feature/");
	assert.equal(parsed.current.branch, "feature-x");
});

test("parseWorktreeList returns no current row for a foreign path", () => {
	const parsed = parseWorktreeList(TWO_WORKTREES, "/somewhere/else");
	assert.equal(parsed.current, null);
	assert.equal(parsed.worktrees.length, 2);
});

test("parseWorktreeList handles empty output", () => {
	const parsed = parseWorktreeList("", "/repo/main");
	assert.deepEqual(parsed.worktrees, []);
	assert.equal(parsed.current, null);
});

test("repoInfo derives name, worktree state, and branch from probe output", () => {
	const info = repoInfo("/repo/feature", "/repo/main/.git", TWO_WORKTREES, "/repo/feature");
	assert.equal(info.name, "main");
	assert.equal(info.root, "/repo/feature");
	assert.equal(info.mainRoot, "/repo/main");
	assert.equal(info.isWorktree, true);
	assert.equal(info.branch, "feature-x");
	assert.equal(info.detached, false);
	assert.equal(info.worktrees.length, 2);
});

test("repoInfo reports the main worktree as not-a-worktree", () => {
	const info = repoInfo("/repo/main", "/repo/main/.git", TWO_WORKTREES, "/repo/main");
	assert.equal(info.isWorktree, false);
	assert.equal(info.branch, "main");
	assert.equal(info.name, "main");
});

test("repoInfo handles a detached current worktree", () => {
	const text = "worktree /repo/main\nHEAD 7632a49e81f241a586cbf258f38b69f82553d22b\n";
	const info = repoInfo("/repo/main", "/repo/main/.git", text, "/repo/main");
	assert.equal(info.detached, true);
	assert.equal(info.branch, null);
	assert.equal(info.sha, "7632a49e81f241a586cbf258f38b69f82553d22b");
});

test("repoInfo strips the bare-repo .git suffix for the name", () => {
	const text = [
		"worktree /srv/repo.git",
		"bare",
		"",
		"worktree /srv/checkout",
		"HEAD 7632a49e81f241a586cbf258f38b69f82553d22b",
		"branch refs/heads/main",
		"",
	].join("\n");
	const info = repoInfo("/srv/checkout", "/srv/repo.git", text, "/srv/checkout");
	assert.equal(info.name, "repo");
	assert.equal(info.mainRoot, "/srv/repo");
	assert.equal(info.isWorktree, true);
});
