/** dsh-sidebar client half — right-docked panel: tree explorer, diff explorer, integrated terminal. */

window.__ModuleLoader__.load({
  id: "dsh-sidebar",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useSyncExternalStore } = react;
    let reactDom = null;
    try { reactDom = require("react-dom"); } catch { reactDom = null; }

    const inject = ["slots", "connection", "sessions"];

    // --- shared open/closed store: one panel, two slot entries (footer toggle + overlay) ---
    let panelOpen = false;
    const listeners = new Set();
    function setPanelOpen(value) {
      panelOpen = !!value;
      for (const fn of listeners) fn();
    }
    function subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    }
    function getSnapshot() {
      return panelOpen;
    }

    // --- context bridge (set in apply) and gateway RPC helper ---
    let hostCtx = null;
    async function rpc(method, args) {
      const res = await hostCtx.connection.rpc.call("/api", "sidebarFs/" + method, { args });
      if (res && res.ok) return res.value;
      const message = res && res.error && res.error.message ? res.error.message : "unknown gateway failure";
      throw new Error("dsh-sidebar: " + message);
    }

    const encoder = new TextEncoder();
    function byteLength(text) {
      return encoder.encode(text).length;
    }

    // --- agent active directory: pure path helpers (test-fixture covered) ---
    /**
     * Trailing-slash-insensitive path equality. The filesystem root stays
     * itself ("/" never collapses to ""), so an agent cwd of "/" is not
     * equal to an absent workspace.
     */
    function samePath(a, b) {
      return trimTrailing(String(a)) === trimTrailing(String(b));
    }

    /** Strip trailing separators, preserving the filesystem root ("/" -> "/"). */
    function trimTrailing(path) {
      return path.replace(/(?!^)\/+$/, "");
    }

    /**
     * Containment check for one directory under one root, separator-agnostic:
     * POSIX paths join with "/", Windows (backslash) roots with "\\" — a pwsh
     * worktree root must still contain its child directories. Comparison only;
     * display paths keep their authored separators.
     */
    function pathContains(root, target) {
      const base = trimTrailing(String(root));
      if (base === "") return false;
      return target.startsWith(base + "/") || target.startsWith(base + "\\");
    }

    /**
     * Collapse `.` and `..` segments so a joined path names the directory the
     * command actually ran in. A `..` at the top of a rooted path is dropped
     * the way a filesystem drops one; without a root it is kept, since it stays
     * meaningful against a cwd this function cannot see. Windows paths are
     * returned opaque: the panel only ever displays them, and a backslash-only
     * string has no POSIX join this layer can trust.
     * @param path - absolute or relative path, possibly carrying `.`/`..` segments.
     * @returns the collapsed path (POSIX), or the input unchanged for Windows paths.
     */
    function normalizeSegments(path) {
      if (typeof path !== "string" || path.length === 0) return path;
      // backslash-only: a Windows path (POSIX paths may contain none)
      if (path.includes("\\") && !path.includes("/")) return path;
      if (!/(?:^|\/)\.\.?(?:\/|$)/.test(path)) {
        return path.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
      }
      const rooted = path.startsWith("/");
      const kept = [];
      for (const segment of path.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
          if (kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
          else if (!rooted) kept.push(segment);
          continue;
        }
        kept.push(segment);
      }
      return (rooted ? "/" : "") + kept.join("/") || (rooted ? "/" : ".");
    }

    /**
     * Resolve a shell call's workdir into the directory the command ran in:
     * an omitted workdir is the session workspace, a relative one joins under
     * it, and an absolute one (POSIX or drive-letter) is used as-is. Without a
     * session cwd a relative path stays as authored (collapsed) and an omitted
     * one stays absent. Mirrors the host tool-card's workdir resolution.
     * @param workdir - the raw call's workdir, if any.
     * @param sessionCwd - the session workspace root, if known.
     * @returns the resolved working directory, or null when neither is known.
     */
    function resolveShellCwd(workdir, sessionCwd) {
      // the filesystem root stays itself ("/" -> "/"): an omitted workdir in
      // a root session resolves to "/", not to nothing
      const session = typeof sessionCwd === "string" && sessionCwd !== "" ? trimTrailing(sessionCwd) : "";
      if (workdir === void 0 || workdir === "") return session || null;
      if (typeof workdir !== "string") return session || null;
      // absolute POSIX or drive-letter path: used as-is (collapsed)
      if (workdir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(workdir)) return normalizeSegments(workdir);
      // relative: joins under the session workspace when one is known; a
      // Windows (backslash) session cwd joins with its own separator and
      // keeps the joined path opaque (a backslash-only string has no POSIX
      // segment collapse this layer can trust — matching separators is what
      // pathContains needs, and the value is display-only beyond that)
      if (session) {
        const windows = session.includes("\\") && !session.includes("/");
        const joined = session + (windows ? "\\" : "/") + workdir;
        return windows ? joined : normalizeSegments(joined);
      }
      return normalizeSegments(workdir);
    }

    /**
     * Locate the worktree row containing one directory: exact path match
     * first, then a path-prefix match so a directory inside a worktree
     * subdirectory still lands. The most specific (longest) root wins when
     * worktrees nest, and containment is separator-agnostic so a pwsh
     * worktree still contains its child directories. Rows come from the diff
     * payload's `repo.worktrees` (`worktree list --porcelain` paths).
     * @param worktrees - worktree rows (path/branch/head), or any non-array.
     * @param cwd - directory path to locate ("" never matches).
     * @returns the matched row, or null.
     */
    function matchWorktree(worktrees, cwd) {
      if (!Array.isArray(worktrees) || typeof cwd !== "string" || cwd === "") return null;
      const target = trimTrailing(cwd);
      if (target === "") return null;
      for (const row of worktrees) {
        if (!row || typeof row.path !== "string") continue;
        if (samePath(row.path, target)) return row;
      }
      let best = null;
      let bestLength = -1;
      for (const row of worktrees) {
        if (!row || typeof row.path !== "string") continue;
        const root = row.path;
        if (root !== "" && pathContains(root, target) && root.length > bestLength) {
          best = row;
          bestLength = root.length;
        }
      }
      return best;
    }

    /**
     * Agent-row segment: where the agent's directory sits relative to the
     * diffed workspace. Shared by the repo bar's agent row and the tests.
     * @param repo - repo identity (its worktrees locate the branch), or null.
     * @param wsPath - the panel's diffed workspace path.
     * @param agentCwd - the agent's active directory (latest shell call's
     *   workdir), or null/"".
     * @returns `{ isHere, worktree }`, or null when no agent directory.
     */
    function agentSegment(repo, wsPath, agentCwd) {
      if (typeof agentCwd !== "string" || agentCwd === "") return null;
      return {
        isHere: samePath(agentCwd, typeof wsPath === "string" ? wsPath : ""),
        worktree: matchWorktree(repo && repo.worktrees, agentCwd),
      };
    }

    /**
     * Compact display path for the agent row: relative to the repo's main
     * root (the common dir, so a worktree renders as `.worktrees/agent-cwd`)
     * or the plain root when the repo has no worktree. Falls back to null
     * when the directory belongs to an unrelated repo — the caller keeps
     * the absolute path (the row's title always carries the full path).
     * Shared by the repo bar and the tests.
     */
    function agentDisplayPath(repo, agentCwd) {
      if (typeof agentCwd !== "string" || agentCwd === "") return null;
      const target = trimTrailing(agentCwd);
      if (target === "") return null;
      const candidates = repo && typeof repo.mainRoot === "string" && repo.mainRoot !== ""
        ? [repo.mainRoot, repo.root]
        : [repo && typeof repo.root === "string" ? repo.root : null];
      for (const candidate of candidates) {
        if (typeof candidate !== "string" || candidate === "" || !pathContains(candidate, target)) continue;
        const relative = target.slice(trimTrailing(candidate).length + 1);
        if (relative !== "") return relative;
      }
      return null;
    }

    function formatSize(size) {
      if (!Number.isFinite(size)) return "";
      if (size < 1024) return size + " B";
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
      return (size / (1024 * 1024)).toFixed(1) + " MB";
    }

    function sortRows(rows) {
      return rows.slice().sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    // --- inline icon set (one weight, no emoji) ---
    function PanelSvg(props) {
      const size = props && props.size ? props.size : 16;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2, stroke: "currentColor", strokeWidth: 1.6 }),
        h("path", { d: "M15 4v16", stroke: "currentColor", strokeWidth: 1.6 }),
        h("path", { d: "M17.5 9.5h1M17.5 12.5h1", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }));
    }
    function CloseSvg(props) {
      const size = props && props.size ? props.size : 16;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M6 6l12 12M18 6L6 18", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }));
    }
    function FolderSvg(props) {
      const size = props && props.size ? props.size : 14;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", stroke: "currentColor", strokeWidth: 1.6 }));
    }
    function FileSvg(props) {
      const size = props && props.size ? props.size : 14;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M7 3h7l4 4v14H7z", stroke: "currentColor", strokeWidth: 1.6 }),
        h("path", { d: "M14 3v4h4", stroke: "currentColor", strokeWidth: 1.6 }));
    }
    function ChevronSvg(props) {
      const size = props && props.size ? props.size : 12;
      const down = !!(props && props.down);
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("path", { d: down ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }));
    }
    function RefreshSvg(props) {
      const size = props && props.size ? props.size : 14;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M20 12a8 8 0 1 1-2.3-5.6", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }),
        h("path", { d: "M20 3.5V8h-4.5", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }));
    }
    function BranchSvg(props) {
      const size = props && props.size ? props.size : 12;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("circle", { cx: 6, cy: 6, r: 2.4, stroke: "currentColor", strokeWidth: 1.6 }),
        h("circle", { cx: 6, cy: 18, r: 2.4, stroke: "currentColor", strokeWidth: 1.6 }),
        h("circle", { cx: 18, cy: 8, r: 2.4, stroke: "currentColor", strokeWidth: 1.6 }),
        h("path", { d: "M6 8.4v7.2M18 10.4c0 3-2.5 4.6-6.5 4.6", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }));
    }
    function TermSvg(props) {
      const size = props && props.size ? props.size : 14;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2, stroke: "currentColor", strokeWidth: 1.6 }),
        h("path", { d: "M7 9l3 3-3 3", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }),
        h("path", { d: "M13 15h4", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }));
    }
    function DiffSvg(props) {
      const size = props && props.size ? props.size : 14;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M12 3v18", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }),
        h("path", { d: "M5 8h4M7 6v4M15 16h4", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }));
    }

    // --- stylesheet, host data-plugin-css convention, token palette only ---
    const CSS_TAG = "dsh-sidebar/panel.css";
    const css = [
      ".dsh-sb-footentry{display:contents}",
      ".dsh-sb-trigger{background:none;border:none;cursor:pointer;color:var(--dsw-alias-label-secondary);width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;padding:0;flex:none}",
      ".dsh-sb-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-sb-trigger-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-sb-panel{position:fixed;top:0;right:0;bottom:0;width:var(--dsh-sidebar-panel-width,420px);z-index:940;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:13px;--sb-mono:var(--dsw-alias-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}",
      ".dsh-sb-resize{position:absolute;left:0;top:0;bottom:0;width:8px;transform:translateX(-4px);cursor:col-resize;touch-action:none;z-index:2}",
      ".dsh-sb-resize:after{content:\"\";box-sizing:border-box;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:3px;height:32px;border-radius:10px;background:var(--dsw-alias-border-l2);opacity:0;transition:opacity .15s var(--ds-ease-in-out, ease)}",
      ".dsh-sb-panel:hover .dsh-sb-resize:after{opacity:.6}",
      ".dsh-sb-resize:hover:after,.dsh-sb-resize[data-dragging]:after{opacity:1;background:var(--dsw-alias-label-tertiary,var(--dsw-alias-border-l3))}",
      ".dsh-sb-panel[data-dragging]{transition:none}",
      "@media (prefers-reduced-motion:reduce){.dsh-sb-resize:after{transition:none}}",
      ".dsh-sb-head{flex:none;display:flex;align-items:center;gap:10px;height:48px;padding:0 8px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".dsh-sb-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;white-space:nowrap}",
      ".dsh-sb-x{background:none;border:none;cursor:pointer;padding:0;color:var(--dsw-alias-label-secondary);width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex:none}",
      ".dsh-sb-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-sb-tabs{flex:none;display:flex;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".dsh-sb-tab{flex:1;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);padding:9px 0;display:flex;align-items:center;justify-content:center;gap:6px}",
      ".dsh-sb-tab:hover{color:var(--dsw-alias-label-primary)}",
      ".dsh-sb-tab-on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-primary)}",
      ".dsh-sb-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".dsh-sb-meta{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:12px;min-height:20px}",
      ".dsh-sb-repobar{flex:none;display:flex;align-items:center;gap:8px;padding:7px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;min-width:0}",
      ".dsh-sb-repoic{flex:none;display:flex;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sb-reponame{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sb-repochip{flex:none;display:inline-flex;align-items:center;gap:4px;font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sb-reporefresh{margin-left:auto;flex:none}",
      ".dsh-sb-meta .dsh-sb-spacer{margin-left:auto}",
      ".dsh-sb-btn{font:inherit;font-size:12px;min-height:24px;padding:2px 10px;border-radius:6px;cursor:pointer;background:none;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);display:inline-flex;align-items:center;justify-content:center;gap:5px}",
      ".dsh-sb-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-sb-btn:disabled{opacity:.4;cursor:default}",
      ".dsh-sb-btnic{width:24px;padding:2px 0}",
      ".dsh-sb-scroll{flex:1;min-height:0;overflow:auto;padding:8px 12px}",
      ".dsh-sb-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:8px 12px;white-space:pre-wrap;word-break:break-word}",
      ".dsh-sb-empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:12px}",
      ".dsh-sb-row{display:flex;align-items:center;gap:6px;min-height:24px;padding:2px 6px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary);white-space:nowrap}",
      ".dsh-sb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-sb-rowname{overflow:hidden;text-overflow:ellipsis}",
      ".dsh-sb-rowsize{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;flex:none}",
      ".dsh-sb-twisty{flex:none;display:flex;align-items:center;color:var(--dsw-alias-label-tertiary);width:12px}",
      ".dsh-sb-fileic{flex:none;display:flex;color:var(--dsw-alias-label-secondary)}",
      ".dsh-sb-loading{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:2px 6px}",
      ".dsh-sb-preview{flex:none;height:42%;min-height:120px;border-top:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column}",
      ".dsh-sb-previewhead{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}",
      ".dsh-sb-previewhead .dsh-sb-x{margin-left:auto;width:24px;height:24px}",
      ".dsh-sb-previewbody{flex:1;min-height:0;overflow:auto;margin:0;padding:8px 12px;font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;white-space:pre;color:var(--dsw-alias-label-primary)}",
      ".dsh-sb-status{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px}",
      ".dsh-sb-chip{font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;padding:1px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sb-chip-a{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
      ".dsh-sb-chip-d{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".dsh-sb-chip-m{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l1))}",
      ".dsh-sb-diffwrap{flex:1;min-height:0;overflow:auto;font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:1.5}",
      ".dsh-sb-diffpre{margin:0;padding:8px 12px;font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:1.5;white-space:pre;color:var(--dsw-alias-label-primary)}",
      ".dsh-sb-dl-add{color:var(--dsw-alias-state-success-primary)}",
      ".dsh-sb-dl-del{color:var(--dsw-alias-state-error-primary)}",
      ".dsh-sb-dl-meta{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sb-dl-hdr{font-weight:600}",
      // diff tab: file list + per-file sections
      ".dsh-sb-filelist{flex:none;max-height:35%;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l2);padding:4px 6px}",
      ".dsh-sb-filerow{display:flex;align-items:center;gap:7px;width:100%;min-height:26px;padding:2px 8px;border:none;border-radius:6px;background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;text-align:left}",
      ".dsh-sb-filerow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-sb-filerow-on{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-sb-kindbadge{flex:none;width:16px;height:16px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10px;font-weight:600}",
      ".dsh-sb-kindbadge-a{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}",
      ".dsh-sb-kindbadge-d{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}",
      ".dsh-sb-kindbadge-m{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary)) 14%,transparent)}",
      ".dsh-sb-kindbadge-r{color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary)) 14%,transparent)}",
      ".dsh-sb-kindbadge-u{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-sb-filepath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px}",
      ".dsh-sb-filestat{flex:none;font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".dsh-sb-filestat-add{color:var(--dsw-alias-state-success-primary)}",
      ".dsh-sb-filestat-del{color:var(--dsw-alias-state-error-primary)}",
      ".dsh-sb-sidetag{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px;line-height:14px}",
      ".dsh-sb-section{border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".dsh-sb-sechead{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:7px;width:100%;min-height:28px;padding:3px 10px;border:none;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:11px;font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);text-align:left}",
      ".dsh-sb-sechead:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-sb-secbody{display:block}",
      ".dsh-sb-secbody-off{display:none}",
      ".dsh-sb-difftool{flex:none;display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".dsh-sb-diffinput{flex:1;min-width:0;height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}",
      ".dsh-sb-diffinput:focus{border-color:var(--dsw-alias-label-tertiary,var(--dsw-alias-border-l2))}",
      ".dsh-sb-diffinput::placeholder{color:var(--dsw-alias-label-tertiary)}",
      // panel foot: agent active-directory row above the repo identity row
      ".dsh-sb-foot{flex:none;display:flex;flex-direction:column;min-width:0;border-top:1px solid var(--dsw-alias-border-l2)}",
      // diff tab: agent active-directory row (observed shell workdir)
      ".dsh-sb-agentrow{flex:none;display:flex;align-items:center;gap:7px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;min-width:0}",
      ".dsh-sb-agentrow-only{border-bottom:none}",
      ".dsh-sb-agentdot{flex:none;width:7px;height:7px;border-radius:50%}",
      ".dsh-sb-agentdot-here{background:var(--dsw-alias-state-success-primary)}",
      ".dsh-sb-agentdot-away{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary))}",
      ".dsh-sb-agentlabel{flex:none;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sb-agentpath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-primary)}",
      // scrollbars (host tokens, webkit + standard)
      ".dsh-sb-scroll,.dsh-sb-diffwrap,.dsh-sb-filelist,.dsh-sb-previewbody,.dsh-sb-termpre{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,transparent) transparent}",
      ".dsh-sb-scroll::-webkit-scrollbar,.dsh-sb-diffwrap::-webkit-scrollbar,.dsh-sb-filelist::-webkit-scrollbar,.dsh-sb-previewbody::-webkit-scrollbar,.dsh-sb-termpre::-webkit-scrollbar{width:8px;height:8px}",
      ".dsh-sb-scroll::-webkit-scrollbar-thumb,.dsh-sb-diffwrap::-webkit-scrollbar-thumb,.dsh-sb-filelist::-webkit-scrollbar-thumb,.dsh-sb-previewbody::-webkit-scrollbar-thumb,.dsh-sb-termpre::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,transparent);border-radius:4px}",
      ".dsh-sb-scroll::-webkit-scrollbar-thumb:hover,.dsh-sb-diffwrap::-webkit-scrollbar-thumb:hover,.dsh-sb-filelist::-webkit-scrollbar-thumb:hover,.dsh-sb-previewbody::-webkit-scrollbar-thumb:hover,.dsh-sb-termpre::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,var(--dsw-alias-scrollbar-bg-l2,transparent))}",
      // diff tab strip badge (changed-file count)
      ".dsh-sb-tabcount{min-width:16px;height:14px;padding:0 4px;border-radius:7px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:9.5px;line-height:14px;text-align:center}",
      // jump flash on the targeted section
      "@keyframes dsh-sb-flash{0%{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,var(--dsw-alias-border-l2)) 30%,transparent)}100%{background:transparent}}",
      ".dsh-sb-flash{animation:dsh-sb-flash .9s ease-out}",
      ".dsh-sb-term{flex:1;min-height:0;display:flex;flex-direction:column}",
      ".dsh-sb-termpre{flex:1;min-height:0;overflow:auto;margin:0;padding:8px 12px;font-family:var(--sb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary);outline:none;cursor:text}",
      ".dsh-sb-termpre:focus{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);border-radius:6px}",
      ".dsh-sb-termmotd{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sb-termbar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;flex-wrap:wrap}",
      ".dsh-sb-banner{margin:8px 12px;padding:8px 10px;border:1px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l1));border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;align-items:center;gap:10px}",
      "@media (prefers-reduced-motion:reduce){.dsh-sb-panel{transition:none}.dsh-sb-resize:after{transition:none}.dsh-sb-flash{animation:none}}",
    ].join("\n");

    function injectCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-sidebar";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // --- frame reserve: push the app content aside while the panel is docked.
    // The AppFrame is a CSS grid (sidebar|center|details) measured by its own
    // ResizeObserver; setting margin-right on the frame element shrinks its
    // border box, and the observer re-syncs the column math. Found via the
    // stable [data-shell-overlay] ancestor — no hashed class names.
    let reservedFrame = null;
    function applyReserve(width) {
      if (typeof document === "undefined") return;
      // self-heal: if the host remounted the frame, the cached node is stale
      if (reservedFrame !== null && !reservedFrame.isConnected) reservedFrame = null;
      if (width > 0 && reservedFrame === null) {
        const overlay = document.querySelector("[data-shell-overlay]");
        const parent = overlay !== null && typeof overlay.parentElement !== "undefined" ? overlay.parentElement : null;
        // the AppFrame is the overlay's grid parent: match the hashed class or
        // the inline grid-template-columns it always carries (build-resilient)
        const isFrame = parent !== null && (parent.classList.contains("pI_x6G_frame") || (typeof parent.style === "object" && parent.style !== null && typeof parent.style.gridTemplateColumns === "string" && parent.style.gridTemplateColumns.includes("fr")));
        reservedFrame = isFrame ? parent : null;
      }
      if (reservedFrame !== null) reservedFrame.style.marginRight = width > 0 ? width + "px" : "";
    }
    function releaseReserve() {
      if (reservedFrame !== null) reservedFrame.style.marginRight = "";
      reservedFrame = null;
    }
    // while the panel is dragged, silence the frame's grid-template-columns
    // transition so the content follows the edge 1:1 instead of easing behind
    function setReserveTransition(off) {
      if (reservedFrame === null || !reservedFrame.isConnected) return;
      reservedFrame.style.transition = off ? "none" : "";
    }

    const PANEL_MIN = 280;
    const PANEL_MAX = 900;
    const PANEL_DEFAULT = 420;
    const WIDTH_KEY = "dsh-sidebar:panel-width";

    function storedWidth() {
      try {
        const value = Number(window.localStorage.getItem(WIDTH_KEY));
        return Number.isFinite(value) && value >= PANEL_MIN && value <= PANEL_MAX ? value : PANEL_DEFAULT;
      } catch { return PANEL_DEFAULT; }
    }

    let panelWidth = typeof window !== "undefined" ? storedWidth() : PANEL_DEFAULT;

    function setPanelWidth(value) {
      panelWidth = Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(value)));
      for (const fn of widthListeners) fn();
    }
    function persistWidth() {
      try { window.localStorage.setItem(WIDTH_KEY, String(panelWidth)); } catch { /* storage unavailable */ }
    }
    const widthListeners = new Set();
    function subscribeWidth(fn) {
      widthListeners.add(fn);
      return () => { widthListeners.delete(fn); };
    }
    function getWidthSnapshot() {
      return panelWidth;
    }

    // --- footer toggle entry (sidebar.footer.action slot; receives {wide}) ---
    function FooterEntry(props) {
      const wide = !!(props && props.wide);
      const open = useSyncExternalStore(subscribe, getSnapshot);
      return h("div", { className: "dsh-sb-footentry" },
        h("button", {
          type: "button",
          className: "dsh-sb-trigger" + (open ? " dsh-sb-trigger-on" : ""),
          "aria-label": "Toggle sidebar panel",
          "aria-pressed": open ? "true" : "false",
          title: "Sidebar panel",
          onClick: () => setPanelOpen(!open),
        }, h(PanelSvg, { size: wide ? 16 : 18 })));
    }

    // --- tree tab ---
    function collectRows(tree, path, depth, out) {
      const entry = tree[path];
      if (!entry || !entry.open || !entry.rows) return;
      for (const row of entry.rows) {
        out.push({ row, depth });
        if (row.type === "directory") collectRows(tree, row.path, depth + 1, out);
      }
    }

    function TreeTab(props) {
      const wsPath = props.wsPath;
      const treeRef = useRef({});
      const [, setVersion] = useState(0);
      const touch = useCallback(() => setVersion((v) => v + 1), []);
      const [preview, setPreview] = useState(null);

      const loadDir = useCallback(async (path) => {
        const tree = treeRef.current;
        const entry = tree[path];
        if (entry && entry.open && entry.rows) { entry.open = false; touch(); return; }
        if (entry && entry.open && entry.loading) return;
        // cached collapse, cached expand, failed-load retry, or first load
        if (entry) {
          entry.open = true;
          if (!entry.rows) { entry.loading = true; entry.error = null; }
          touch();
          if (entry.rows) return;
          try {
            const rows = await rpc("listDir", { path });
            const current = treeRef.current[path];
            if (current) { current.rows = sortRows(Array.isArray(rows) ? rows : []); current.loading = false; touch(); }
          } catch (err) {
            const current = treeRef.current[path];
            if (current) { current.loading = false; current.error = err.message || String(err); touch(); }
          }
          return;
        }
        tree[path] = { open: true, rows: null, loading: true, error: null };
        touch();
        try {
          const rows = await rpc("listDir", { path });
          const current = treeRef.current[path];
          if (current) { current.rows = sortRows(Array.isArray(rows) ? rows : []); current.loading = false; touch(); }
        } catch (err) {
          const current = treeRef.current[path];
          if (current) { current.loading = false; current.error = err.message || String(err); touch(); }
        }
      }, [touch]);

      useEffect(() => {
        treeRef.current = {};
        setPreview(null);
        touch();
        if (wsPath) loadDir(wsPath);
      }, [wsPath, loadDir, touch]);

      const openFile = useCallback(async (path) => {
        setPreview({ path, loading: true, content: null, truncated: false, size: null, tooLarge: false, error: null });
        try {
          const res = await rpc("readText", { path, maxBytes: 65536 });
          setPreview({
            path,
            loading: false,
            content: res && typeof res.content === "string" ? res.content : "",
            truncated: !!(res && res.truncated),
            size: res && Number.isFinite(res.size) ? res.size : null,
            tooLarge: !!(res && res.tooLarge),
            error: null,
          });
        } catch (err) {
          setPreview({ path, loading: false, content: null, truncated: false, size: null, tooLarge: false, error: err.message || String(err) });
        }
      }, []);

      const out = [];
      if (wsPath) collectRows(treeRef.current, wsPath, 0, out);

      return h("div", { className: "dsh-sb-body" },
        !wsPath
          ? h("div", { className: "dsh-sb-empty" }, "no registered workspace — open one in dsh first")
          : out.length === 0 && treeRef.current[wsPath] && treeRef.current[wsPath].loading
            ? h("div", { className: "dsh-sb-loading" }, "loading…")
            : h("div", { className: "dsh-sb-scroll" },
                out.map((item) => {
                  const row = item.row;
                  const isDir = row.type === "directory";
                  const entry = treeRef.current[row.path];
                  return h("div", {
                    key: row.path,
                    className: "dsh-sb-row",
                    style: { paddingLeft: 6 + item.depth * 14 + "px" },
                    role: isDir ? "treeitem" : "button",
                    onClick: () => (isDir ? loadDir(row.path) : openFile(row.path)),
                  },
                    h("span", { className: "dsh-sb-twisty" }, isDir ? h(ChevronSvg, { down: !!(entry && entry.open) }) : null),
                    h("span", { className: "dsh-sb-fileic" }, isDir ? h(FolderSvg) : h(FileSvg)),
                    h("span", { className: "dsh-sb-rowname", title: row.path }, row.name),
                    !isDir && Number.isFinite(row.size) ? h("span", { className: "dsh-sb-rowsize" }, formatSize(row.size)) : null);
                })),
        wsPath && treeRef.current[wsPath] && treeRef.current[wsPath].error
          ? h("div", { className: "dsh-sb-err" }, treeRef.current[wsPath].error)
          : null,
        wsPath && Object.values(treeRef.current).some((e) => e && e.open && e.loading)
          ? h("div", { className: "dsh-sb-loading" }, "loading…")
          : null,
        preview
          ? h("div", { className: "dsh-sb-preview" },
              h("div", { className: "dsh-sb-previewhead" },
                h("span", { title: preview.path }, preview.path),
                preview.loading ? h("span", null, "loading…") : null,
                h("button", { className: "dsh-sb-x", "aria-label": "Close preview", onClick: () => setPreview(null) }, h(CloseSvg, { size: 12 }))),
              preview.error
                ? h("div", { className: "dsh-sb-err" }, preview.error)
                : preview.tooLarge
                  ? h("div", { className: "dsh-sb-empty" }, "file exceeds the 1 MiB read cap — open it in the terminal instead")
                  : h("pre", { className: "dsh-sb-previewbody" },
                      preview.content,
                      preview.truncated ? "\n\n… truncated (shown: first 64 KiB)" : ""),
            )
          : null);
    }

    // --- diff tab: pure unified-diff parsing (test-fixture covered via the preview harness) ---
    /** Parse a unified diff text into per-file sections with hunk stats. */
    function parseDiffText(text) {
      const sections = [];
      if (typeof text !== "string" || text.length === 0) return sections;
      const lines = text.split("\n");
      let current = null;
      const startSection = (path) => {
        current = { path, oldPath: null, hunks: [], adds: 0, dels: 0, binary: false, kind: null, side: null };
        sections.push(current);
      };
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.startsWith("diff --git ")) {
          const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
          startSection(m ? m[2] : line.slice("diff --git ".length));
          continue;
        }
        if (current === null) continue;
        if (line.startsWith("rename from ")) current.oldPath = line.slice("rename from ".length);
        else if (line.startsWith("rename to ")) { /* path already from b/ side */ }
        else if (line.startsWith("Binary files ")) current.binary = true;
        else if (line.startsWith("new file mode")) current.kind = current.kind === null ? "a" : current.kind;
        else if (line.startsWith("deleted file mode")) current.kind = "d";
        else if (line.startsWith("rename ")) { if (current.kind === null) current.kind = "r"; }
        else if (line.startsWith("@@")) {
          const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
          current.hunks.push({
            head: m ? { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]) } : null,
            lines: []
          });
        } else if (current.hunks.length > 0) {
          const hunk = current.hunks[current.hunks.length - 1];
          if (line.startsWith("+")) { current.adds += 1; hunk.lines.push({ type: "add", text: line.slice(1) }); }
          else if (line.startsWith("-")) { current.dels += 1; hunk.lines.push({ type: "del", text: line.slice(1) }); }
          else if (line.startsWith(" ")) hunk.lines.push({ type: "ctx", text: line.slice(1) });
          else if (line.startsWith("\\ No newline")) hunk.lines.push({ type: "noeol", text: line });
          // unrecognized lines inside a hunk are treated as context verbatim
          else hunk.lines.push({ type: "ctx", text: line });
        }
      }
      return sections;
    }

    /** Merge parsed sections per file path; the first occurrence wins for identity. */
    function mergeSections(byPath, sections, side) {
      for (const section of sections) {
        const key = section.path;
        const existing = byPath.get(key);
        if (existing) {
          existing.hunks.push(...section.hunks);
          existing.adds += section.adds;
          existing.dels += section.dels;
          if (existing.binary || section.binary) existing.binary = true;
          if (side !== null && existing.sides.indexOf(side) < 0) existing.sides.push(side);
          if (existing.kind === null) existing.kind = section.kind;
        } else {
          const merged = { ...section, hunks: section.hunks.slice(), sides: side !== null ? [side] : [] };
          byPath.set(key, merged);
        }
      }
    }

    /** Build the diff-tab model: status rows joined with parsed diff sections. */
    function buildDiffModel(data) {
      if (!data || !data.isGit) return { files: [], sections: [] };
      const byPath = new Map();
      const parts = data.parts && typeof data.parts === "object" ? data.parts : null;
      if (parts && typeof parts.unstaged === "object" && typeof parts.staged === "object") {
        mergeSections(byPath, parseDiffText(parts.unstaged && parts.unstaged.text), "unstaged");
        mergeSections(byPath, parseDiffText(parts.staged && parts.staged.text), "staged");
      } else {
        mergeSections(byPath, parseDiffText(data.diff), null);
      }
      const sections = Array.from(byPath.values());
      const sectionByPath = new Map(sections.map((s) => [s.path, s]));
      const files = (Array.isArray(data.status) ? data.status : []).map((row) => {
        const code = (row.code || "").trim();
        const kind = code.startsWith("A") ? "a" : code.startsWith("D") ? "d" : code.startsWith("R") || code.includes("->") ? "r" : code.startsWith("?") ? "u" : "m";
        const path = row.path.includes(" -> ") ? row.path.split(" -> ").pop() : row.path;
        const section = sectionByPath.get(path) || null;
        return { code, kind, path, staged: code.startsWith("?") ? false : code[0] !== " " && code[0] !== "?", unstaged: code.startsWith("?") ? false : code[1] !== " ", section };
      });
      // sections present in the diff but absent from status (defensive; keeps them reachable)
      const statusPaths = new Set(files.map((f) => f.path));
      for (const section of sections) {
        if (!statusPaths.has(section.path)) files.push({ code: "", kind: section.binary ? "m" : section.kind || "m", path: section.path, staged: false, unstaged: true, section });
      }
      return { files, sections };
    }

    /** Stat spans for one file: adds/dels counts with sign colors. */
    function statSpans(adds, dels) {
      if (adds <= 0 && dels <= 0) return null;
      return h("span", { className: "dsh-sb-filestat" },
        adds > 0 ? h("span", { className: "dsh-sb-filestat-add" }, "+" + adds) : null,
        adds > 0 && dels > 0 ? " " : null,
        dels > 0 ? h("span", { className: "dsh-sb-filestat-del" }, "−" + dels) : null);
    }

    // --- diff tab: shared count badge store + module-level result cache ---
    // one store per module: the Diff tab strip badge survives tab switches,
    // and cached diff results restore instantly without refetching
    const diffCountListeners = new Set();
    const diffCounts = new Map(); // wsPath -> number|null
    function setDiffCount(wsPath, count) {
      const previous = diffCounts.get(wsPath);
      if (previous === count) return;
      if (count === null) diffCounts.delete(wsPath);
      else diffCounts.set(wsPath, count);
      for (const fn of diffCountListeners) fn();
    }
    function subscribeDiffCount(fn) {
      diffCountListeners.add(fn);
      return () => { diffCountListeners.delete(fn); };
    }
    function getDiffCountSnapshot() {
      let total = 0;
      for (const value of diffCounts.values()) if (Number.isFinite(value)) total += value;
      return total;
    }
    function diffCacheRef() {
      return { map: new Map() };
    }

    // --- shared repo-identity store: the panel-foot bar reads it from any tab ---
    // the Diff tab fetch writes it on every visit; when another tab is active
    // the bar fetches itself. Cached per workspace so tab switches and panel
    // reopens restore instantly; a content compare keeps identical re-fetches
    // from notifying and looping renders.
    const repoInfoListeners = new Set();
    const repoInfoByWs = new Map(); // wsPath -> repo object|null
    let repoInfoVersion = 0;
    /** Shallow repo compare: the fields the foot bar renders. */
    function sameRepo(a, b) {
      if (a === b) return true;
      if (!a || !b) return false;
      return a.name === b.name
        && a.branch === b.branch
        && a.detached === b.detached
        && a.sha === b.sha
        && a.isWorktree === b.isWorktree
        && a.mainRoot === b.mainRoot
        && a.root === b.root
        && Array.isArray(a.worktrees) === Array.isArray(b.worktrees)
        && (!Array.isArray(a.worktrees) || a.worktrees.length === b.worktrees.length);
    }
    function setRepoInfo(wsPath, repo) {
      if (!wsPath) return;
      const previous = repoInfoByWs.get(wsPath);
      if (previous === repo || sameRepo(previous, repo)) return;
      if (repo === null) repoInfoByWs.delete(wsPath);
      else repoInfoByWs.set(wsPath, repo);
      repoInfoVersion += 1;
      for (const fn of repoInfoListeners) fn();
    }
    function subscribeRepoInfo(fn) {
      repoInfoListeners.add(fn);
      return () => { repoInfoListeners.delete(fn); };
    }
    function getRepoInfoSnapshot() {
      return repoInfoVersion;
    }

    // --- agent active-directory store: the directory the current session's
    // agent is actually working in (its latest observed shell call's workdir).
    // The Panel's useAgentActiveDir hook feeds it; the Diff tab renders it.
    // One observation at a time keyed by session id: a selection change resets
    // it synchronously so a stale session can never publish.
    let agentObservation = { sessionId: null, cwd: null };
    const agentDirListeners = new Set();
    function setAgentObservation(sessionId, cwd) {
      if (agentObservation.sessionId === sessionId && agentObservation.cwd === cwd) return;
      agentObservation = { sessionId, cwd };
      for (const fn of agentDirListeners) fn();
    }
    function subscribeAgentDir(fn) {
      agentDirListeners.add(fn);
      return () => { agentDirListeners.delete(fn); };
    }
    function getAgentDirSnapshot() {
      return agentObservation;
    }

    /**
     * Extract a shell call's workdir from one raw `tool/call` event:
     * bash/pwsh only, with the call's raw `arguments` JSON parsed for
     * `workdir`. Returns "" when the workdir is omitted (the scanner
     * resolves it against the session cwd, mirroring the host's call
     * resolution), null for other tools and malformed arguments.
     * @param event - a `tool/call` SessionEvent.
     * @returns the raw workdir string ("" when omitted), or null.
     */
    function shellCallWorkdir(event) {
      const data = event && event.type === "tool/call" ? event.data : null;
      if (!data || (data.name !== "bash" && data.name !== "pwsh")) return null;
      if (typeof data.arguments !== "string" || data.arguments === "") return null;
      try {
        const args = JSON.parse(data.arguments);
        if (!args || typeof args !== "object" || Array.isArray(args)) return null;
        const workdir = args.workdir;
        if (workdir === void 0) return "";
        return typeof workdir === "string" ? workdir : null;
      } catch {
        return null;
      }
    }

    /**
     * Session list row for one id: client list rows are a runtime array shape
     * (`items`), typed records the `byId` map. Dual-shape lookup shared by the
     * session-follow effect and the agent-directory scanner.
     * @param state - sessions list snapshot.
     * @param id - session id to locate.
     * @returns the row, or null.
     */
    function sessionRow(state, id) {
      if (!state || !id) return null;
      if (Array.isArray(state.items)) {
        return state.items.find((item) => item && (item.sessionId === id || item.id === id)) || null;
      }
      return state && state.byId ? state.byId[id] || null : null;
    }

    /**
     * Panel hook: track the current session's agent active directory. Follows
     * the sessions list selection; when a session is selected it subscribes to
     * that session's event window and re-scans on every revision, publishing
     * the most recent bash/pwsh call's resolved workdir (null when the window
     * holds no shell call — file-tool-only activity shows no row). Runs while
     * the panel is mounted, not gated on open, so the observation is current
     * the moment the panel reopens.
     */
    function useAgentActiveDir() {
      const observation = useSyncExternalStore(subscribeAgentDir, getAgentDirSnapshot);
      const sessionsFace = hostCtx ? hostCtx.sessions : null;
      useEffect(() => {
        if (!sessionsFace || typeof sessionsFace.list?.subscribe !== "function") return undefined;
        let unsubscribeEvents = null;
        let watched = null;
        let source = null;
        // scan the retained event window for the most recent shell call and
        // publish its workdir resolved against the session cwd (immutable per
        // session, so capturing it per scan call is safe)
        const scan = (sessionCwd) => {
          if (watched === null || !source) return;
          const window = source.getSnapshot();
          const entries = window && Array.isArray(window.entries) ? window.entries : [];
          for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i];
            const event = entry && entry.type === "event" ? entry.event : null;
            const workdir = shellCallWorkdir(event);
            if (workdir === null) continue;
            setAgentObservation(watched, resolveShellCwd(workdir, sessionCwd));
            return;
          }
          setAgentObservation(watched, null);
        };
        const adopt = () => {
          const state = sessionsFace.list.getSnapshot();
          const id = state && state.current;
          if (id !== watched) {
            // selection change: tear down the old subscription first, then
            // reset synchronously so the old session's observation cannot
            // survive the switch
            if (unsubscribeEvents) { unsubscribeEvents(); unsubscribeEvents = null; }
            source = null;
            watched = id || null;
            setAgentObservation(watched, null);
            if (id) {
              const row = sessionRow(state, id);
              const sessionCwd = row && typeof row.cwd === "string" && row.cwd !== "" ? row.cwd : null;
              const binding = typeof sessionsFace.binding === "function" ? sessionsFace.binding(id) : null;
              const next = binding && binding.eventSource;
              if (next && typeof next.getSnapshot === "function" && typeof next.subscribe === "function") {
                source = next;
                scan(sessionCwd);
                // read the CURRENT session row per event: the cwd may arrive
                // after adoption, and a closure over the initial (possibly
                // null) value would resolve every later event incorrectly
                unsubscribeEvents = source.subscribe(() => {
                  const now = sessionsFace.list.getSnapshot();
                  const nowRow = sessionRow(now, watched);
                  scan(nowRow && typeof nowRow.cwd === "string" && nowRow.cwd !== "" ? nowRow.cwd : null);
                });
              }
            }
          } else if (watched !== null) {
            // same session: the row (and its cwd) may have arrived after the
            // first adopt; re-scan against the now-known cwd
            const row = sessionRow(state, watched);
            const sessionCwd = row && typeof row.cwd === "string" && row.cwd !== "" ? row.cwd : null;
            scan(sessionCwd);
          }
        };
        adopt();
        // tear down BOTH subscriptions on cleanup: the list subscription and
        // the event-source subscription a later adopt() call adopted — the
        // bare list unsubscribe would leave the event subscription live, and
        // its scan closure could still publish the old session's workdir
        const unsubscribeList = sessionsFace.list.subscribe(adopt);
        return () => {
          unsubscribeList();
          if (unsubscribeEvents) { unsubscribeEvents(); unsubscribeEvents = null; }
          source = null;
          watched = null;
        };
      }, [sessionsFace]);
      return observation;
    }

    /** Changed-file counter pill on the Diff tab strip button. */
    function DiffTabBadge() {
      const total = useSyncExternalStore(subscribeDiffCount, getDiffCountSnapshot);
      if (total <= 0) return null;
      return h("span", { className: "dsh-sb-tabcount", "aria-label": total + " changed files" }, total > 99 ? "99+" : String(total));
    }

    const DIFF_CACHE_MAX = 8;

    function DiffTab(props) {
      const wsPath = props.wsPath;
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [tick, setTick] = useState(0);
      const [filter, setFilter] = useState("");
      const [collapsed, setCollapsed] = useState({});
      const [jumped, setJumped] = useState(null);
      const [copied, setCopied] = useState(false);
      const wrapRef = useRef(null);
      const copyTimer = useRef(null);

      useEffect(() => {
        if (!wsPath) return undefined;
        let cancelled = false;
        // stale-while-revalidate: an existing result stays visible while refreshing
        setData((current) => current);
        setLoading(true);
        setError(null);
        rpc("diff", { workspacePath: wsPath }).then((res) => {
          if (cancelled) return;
          setData(res);
          setLoading(false);
          // feed the shared store: the panel-foot repo bar updates on any tab
          setRepoInfo(wsPath, res && res.repo ? res.repo : null);
        }, (err) => {
          if (cancelled) return;
          setError(err.message || String(err));
          setLoading(false);
        });
        return () => { cancelled = true; };
      }, [wsPath, tick]);

      // module-level cache keyed by workspace: tab switches restore instantly
      const cacheRef = useRef(null);
      if (cacheRef.current === null) cacheRef.current = diffCacheRef();
      useEffect(() => {
        const cache = cacheRef.current;
        if (!wsPath) return undefined;
        const cached = cache.map.get(wsPath);
        if (cached) {
          setData(cached.data);
          setCollapsed(cached.collapsed || {});
        }
        return () => {
          if (cache.map.get(wsPath) || !cache.map.size) return;
          // prune on leave is not needed; the map is capped below
        };
      }, [wsPath]);
      useEffect(() => {
        if (!wsPath || !data) return;
        const cache = cacheRef.current;
        cache.map.set(wsPath, { data, collapsed });
        while (cache.map.size > DIFF_CACHE_MAX) {
          const oldest = cache.map.keys().next().value;
          cache.map.delete(oldest);
        }
      }, [wsPath, data, collapsed]);

      // keep the tab-strip badge in sync with the changed-file count
      useEffect(() => {
        setDiffCount(wsPath, data && data.isGit && Array.isArray(data.status) ? data.status.length : null);
        return () => setDiffCount(wsPath, null);
      }, [wsPath, data]);

      useEffect(() => () => { if (copyTimer.current !== null) clearTimeout(copyTimer.current); }, []);

      const model = useMemo(() => buildDiffModel(data), [data]);
      const needle = filter.trim().toLowerCase();
      const files = needle
        ? model.files.filter((f) => f.path.toLowerCase().includes(needle))
        : model.files;
      const visibleSections = needle
        ? model.sections.filter((s) => files.some((f) => f.section === s))
        : model.sections;

      const jumpToFile = useCallback((path) => {
        setFilter((current) => (current && !path.toLowerCase().includes(current.trim().toLowerCase()) ? "" : current));
        setCollapsed((current) => ({ ...current, [path]: false }));
        setJumped(path);
        // scroll after the section is expanded
        requestAnimationFrame(() => {
          const wrap = wrapRef.current;
          const target = wrap && wrap.querySelector('[data-secpath="' + CSS.escape(path) + '"]');
          if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
        });
        setTimeout(() => setJumped((current) => (current === path ? null : current)), 950);
      }, []);

      const copyDiff = useCallback(() => {
        const text = data && typeof data.diff === "string" ? data.diff : "";
        if (!text) return;
        const done = () => {
          setCopied(true);
          if (copyTimer.current !== null) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(() => setCopied(false), 1600);
        };
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).then(done, () => {});
        } else {
          // clipboard API unavailable: fall back to a detached textarea copy
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch { /* copy unavailable */ }
          document.body.removeChild(ta);
        }
      }, [data]);

      const status = data && Array.isArray(data.status) ? data.status : [];

      const renderLine = (line, i) => {
        let cls = "";
        let text = line.text;
        if (line.type === "add") cls = "dsh-sb-dl-add";
        else if (line.type === "del") cls = "dsh-sb-dl-del";
        else if (line.type === "noeol") cls = "dsh-sb-dl-meta";
        if (line.type === "noeol") text = line.text;
        return h("div", { key: i, className: cls, style: { whiteSpace: "pre-wrap", wordBreak: "break-all" } }, text);
      };

      const renderHunkHead = (hunk, key) => h("div", { key: key, className: "dsh-sb-dl-meta", style: { padding: "2px 0" } },
        hunk.head
          ? "@@ -" + hunk.head.oldStart + "," + hunk.head.oldLines + " +" + hunk.head.newStart + "," + hunk.head.newLines + " @@"
          : "@@ … @@");

      return h("div", { className: "dsh-sb-body" },
        h("div", { className: "dsh-sb-difftool" },
          h("button", { className: "dsh-sb-btn dsh-sb-btnic", onClick: () => setTick((v) => v + 1), disabled: !wsPath || loading, title: "Refresh diff", "aria-label": "Refresh diff" }, h(RefreshSvg)),
          h("input", {
            className: "dsh-sb-diffinput",
            value: filter,
            placeholder: "filter files…",
            "aria-label": "Filter changed files",
            spellCheck: false,
            onChange: (e) => setFilter(e.target.value),
          }),
          h("button", { className: "dsh-sb-btn dsh-sb-btnic", onClick: copyDiff, disabled: !data || !data.diff, title: "Copy diff", "aria-label": "Copy diff" },
            h("span", { style: { fontSize: "11px" } }, copied ? "✓" : "⧉")),
          data && data.truncated ? h("span", { className: "dsh-sb-chip dsh-sb-chip-m", title: "diff capped at 256 KiB — showing the most recent changes" }, "truncated") : null),
        !wsPath
          ? h("div", { className: "dsh-sb-empty" }, "no registered workspace")
          : error
            ? h("div", { className: "dsh-sb-empty" },
                h("div", { className: "dsh-sb-err" }, error),
                h("button", { className: "dsh-sb-btn", onClick: () => setTick((v) => v + 1) }, h(RefreshSvg), "retry"))
            : data && !data.isGit
              ? h("div", { className: "dsh-sb-empty" },
                  "not a git repository (or git failed)",
                  h("div", { style: { marginTop: "4px" } }, "nothing to diff here"))
              : loading && !data
                ? h("div", { className: "dsh-sb-loading", style: { padding: "8px 12px" } }, "loading diff…")
                : h(react.Fragment, null,
                    status.length > 0
                      ? h("div", { className: "dsh-sb-filelist" },
                          files.length === 0 && needle
                            ? h("div", { className: "dsh-sb-empty" }, "no file matches \"" + filter.trim() + "\"")
                            : files.map((f) => {
                                const isJumped = jumped === f.path;
                                return h("button", {
                                  key: f.code + " " + f.path,
                                  className: "dsh-sb-filerow" + (isJumped ? " dsh-sb-filerow-on" : ""),
                                  onClick: () => jumpToFile(f.path),
                                  title: f.code + "  " + f.path,
                                },
                                  h("span", { className: "dsh-sb-kindbadge dsh-sb-kindbadge-" + f.kind }, f.kind === "u" ? "?" : f.kind === "m" ? "M" : f.kind.toUpperCase()),
                                  h("span", { className: "dsh-sb-filepath" }, f.path),
                                  f.section && f.section.sides.length === 1 ? h("span", { className: "dsh-sb-sidetag" }, f.section.sides[0] === "staged" ? "staged" : "unstaged") : null,
                                  f.section && !f.section.binary ? statSpans(f.section.adds, f.section.dels) : null,
                                  f.section && f.section.binary ? h("span", { className: "dsh-sb-filestat" }, "binary") : null);
                              }))
                      : null,
                    model.sections.length === 0 && status.length === 0
                      ? h("div", { className: "dsh-sb-empty" },
                          "working tree clean",
                          h("div", { style: { marginTop: "4px" } }, "no changes against HEAD"))
                      : h("div", { className: "dsh-sb-diffwrap", ref: wrapRef },
                          visibleSections.map((section) => {
                            const isCollapsed = !!collapsed[section.path];
                            const isJumped = jumped === section.path;
                            return h("div", { key: section.path, className: "dsh-sb-section" + (isJumped ? " dsh-sb-flash" : ""), "data-secpath": section.path },
                              h("button", {
                                className: "dsh-sb-sechead",
                                onClick: () => setCollapsed((current) => ({ ...current, [section.path]: !isCollapsed })),
                                title: isCollapsed ? "Expand " + section.path : "Collapse " + section.path,
                                "aria-expanded": isCollapsed ? "false" : "true",
                              },
                                h("span", { style: { display: "flex", color: "var(--dsw-alias-label-tertiary)", transform: isCollapsed ? "none" : "rotate(90deg)" } }, h(ChevronSvg, { size: 11 })),
                                h("span", { className: "dsh-sb-filepath", style: { flex: "0 1 auto" } }, section.path),
                                statSpans(section.adds, section.dels),
                                section.binary ? h("span", { className: "dsh-sb-filestat" }, "binary") : null,
                                section.sides.length === 1 ? h("span", { className: "dsh-sb-sidetag" }, section.sides[0] === "staged" ? "staged" : "unstaged") : null),
                              h("div", { className: "dsh-sb-secbody" + (isCollapsed ? " dsh-sb-secbody-off" : "") },
                                section.binary
                                  ? h("div", { className: "dsh-sb-empty" }, "binary file — contents not shown")
                                  : section.hunks.map((hunk, hi) => h("div", { key: hi },
                                      renderHunkHead(hunk, hi),
                                      hunk.lines.map(renderLine))),
                                section.hunks.length === 0 && !section.binary
                                  ? h("div", { className: "dsh-sb-empty" }, "no hunks (mode or rename change only)")
                                  : null));
                          }))));
    }

    // --- panel-foot repo bar: visible from every tab (Tree, Diff, Terminal) ---
    // The Diff tab writes the store on its own fetch; when another tab is
    // active this bar fetches repo info itself. Errors are swallowed: the bar
    // keeps the last-known info and never adds noise the Diff tab already
    // surfaces. Above the identity row sits the agent active-directory row:
    // the directory the current session's agent is working in (its latest
    // observed shell call) — the panel follows it automatically, so the row
    // is a status indicator with no switch button.
    function RepoInfoBar(props) {
      const wsPath = props.wsPath;
      const agentCwd = props.agentCwd;
      const open = useSyncExternalStore(subscribe, getSnapshot);
      const version = useSyncExternalStore(subscribeRepoInfo, getRepoInfoSnapshot);
      const [tick, setTick] = useState(0);
      const [refreshing, setRefreshing] = useState(false);
      void version; // re-render trigger only; the map holds the data

      // self-fetch when the Diff tab is not mounted (or a manual refresh fired)
      useEffect(() => {
        if (!open || !wsPath) return undefined;
        let cancelled = false;
        setRefreshing(true);
        rpc("diff", { workspacePath: wsPath }).then((res) => {
          if (cancelled) return;
          setRepoInfo(wsPath, res && res.repo ? res.repo : null);
          setRefreshing(false);
        }, () => {
          if (cancelled) return;
          setRefreshing(false);
        });
        return () => { cancelled = true; };
      }, [open, wsPath, tick]);

      const repo = wsPath ? repoInfoByWs.get(wsPath) : null;
      if (!repo && !agentCwd) return null;
      // branch chip label: branch name, or "detached @ <short sha>"
      const shaShort = repo && repo.sha ? String(repo.sha).slice(0, 8) : null;
      const branchLabel = repo ? (repo.branch ? repo.branch : repo.detached ? "detached" + (shaShort ? " @ " + shaShort : "") : "no commits") : "";
      // hidden details: worktree list in the branch chip tooltip
      const worktreeTitle = repo && repo.isWorktree && Array.isArray(repo.worktrees)
        ? repo.worktrees.map((wt) => (wt.path + (wt.branch ? " [" + wt.branch + "]" : " (detached)") + (wt.isCurrent ? " ← current" : ""))).join("\n")
        : null;

      // agent active-directory row: status dot ("agent working here" vs
      // "agent active" away) and the directory. When the agent works in the
      // diffed repo (the common case) the rows merge into one compact line —
      // the repo's branch chip, name, and refresh button already say the
      // rest, so a second branch chip and the "worktree" chip would be
      // redundant. When the agent is away the two-row layout stays so both
      // directories are visible.
      const seg = agentSegment(repo, wsPath, agentCwd);
      const displayPath = seg ? (agentDisplayPath(repo, agentCwd) || agentCwd) : null;
      const agentRow = seg
        ? h("div", { className: "dsh-sb-agentrow" + (repo ? "" : " dsh-sb-agentrow-only") },
            h("span", { className: "dsh-sb-agentdot" + (seg.isHere ? " dsh-sb-agentdot-here" : " dsh-sb-agentdot-away"), "aria-hidden": "true" }),
            h("span", { className: "dsh-sb-agentlabel" }, seg.isHere ? "agent working here" : "agent active"),
            h("span", { className: "dsh-sb-agentpath", title: agentCwd }, displayPath || agentCwd),
            seg.worktree && !seg.isHere ? h("span", { className: "dsh-sb-repochip", title: "branch: " + (seg.worktree.branch || "detached") }, seg.worktree.branch || "detached") : null)
        : null;

      return h("div", { className: "dsh-sb-foot" },
        agentRow,
        repo
          ? h("div", { className: "dsh-sb-repobar" },
              h("span", { className: "dsh-sb-repoic" }, h(BranchSvg, { size: 13 })),
              h("span", { className: "dsh-sb-repochip", title: worktreeTitle || branchLabel },
                h(BranchSvg, { size: 10 }), branchLabel),
              repo.isWorktree && !(seg && (seg.isHere || seg.worktree)) ? h("span", { className: "dsh-sb-repochip", title: "main worktree: " + (repo.mainRoot || "?") }, "worktree") : null,
              h("span", { className: "dsh-sb-reponame", title: repo.mainRoot || repo.root }, repo.name),
              h("button", {
                className: "dsh-sb-btn dsh-sb-btnic dsh-sb-reporefresh",
                onClick: () => setTick((v) => v + 1),
                disabled: refreshing,
                title: "Refresh repo info",
                "aria-label": "Refresh repo info",
              }, h(RefreshSvg, { size: 12 })))
          : null);
    }

    // --- terminal tab ---
    const POLL_MS = 400;
    const MAX_TERM_TEXT = 200000;
    // batching window for rapid keystrokes: one RPC per burst instead of one per key
    const WRITE_BATCH_MS = 12;

    function TermTab(props) {
      const wsPath = props.wsPath;
      const termsRef = useRef({});
      const [, setVersion] = useState(0);
      const touch = useCallback(() => setVersion((v) => v + 1), []);
      const preRef = useRef(null);
      const pendingWritesRef = useRef({});

      const ensureTerminal = useCallback(async (path) => {
        const existing = termsRef.current[path];
        if (existing) return;
        termsRef.current[path] = { spawning: true, id: null, motd: "", text: "", cursor: 0, exited: false, outcome: null, error: null, reading: false };
        touch();
        try {
          const res = await rpc("termSpawn", { workspacePath: path });
          const entry = termsRef.current[path];
          if (entry) { entry.spawning = false; entry.id = res && res.id ? res.id : null; entry.motd = res && res.motd ? res.motd + "\n" : ""; touch(); }
        } catch (err) {
          const entry = termsRef.current[path];
          if (entry) { entry.spawning = false; entry.error = err.message || String(err); touch(); }
        }
      }, [touch]);

      // spawn on first view of each workspace's terminal
      useEffect(() => {
        if (wsPath) ensureTerminal(wsPath);
      }, [wsPath, ensureTerminal]);

      // long-poll loop: the read blocks host-side until new bytes arrive, so
      // each turn returns as soon as output exists — echo latency is one round
      // trip instead of waiting for the next poll tick. Self-rescheduling; a
      // dead or still-spawning terminal spins on POLL_MS so a respawn resumes
      // the drain without a remount, and transient errors back off and retry.
      useEffect(() => {
        if (!wsPath) return undefined;
        let cancelled = false;
        const wait = () => new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const loop = async () => {
          while (!cancelled) {
            const entry = termsRef.current[wsPath];
            if (!entry) return;
            if (!entry.id || entry.exited || entry.reading) { await wait(); continue; }
            entry.reading = true;
            try {
              const res = await rpc("termRead", { termId: entry.id, fromByte: entry.cursor });
              if (cancelled) return;
              const add = res && typeof res.text === "string" ? res.text : "";
              if (add) {
                entry.text = (entry.text + add).slice(-MAX_TERM_TEXT);
                touch();
              }
              // The host's absolute ring end is the authoritative cursor: when the
              // ring has dropped bytes, `from + text.length` would mis-advance.
              entry.cursor = res && Number.isFinite(res.end) ? res.end : entry.cursor + byteLength(add);
              if (res && res.exited && !entry.exited) {
                entry.exited = true;
                entry.outcome = res.outcome || null;
                touch();
              }
            } catch (err) {
              if (cancelled) return;
              // kill() marks the entry exited before the termKill RPC lands, so
              // an "unknown terminal" for an already-exited entry is expected
              if (!entry.exited) { entry.error = err.message || String(err); touch(); }
              await wait();
            } finally {
              entry.reading = false;
            }
          }
        };
        loop();
        return () => { cancelled = true; };
      }, [wsPath, touch]);

      // pin the scrollback to the bottom only when output actually changed —
      // the unconditional version yanked the view back on every keystroke and
      // forced a reflow on each no-op render
      useEffect(() => {
        const pre = preRef.current;
        if (!pre) return;
        const text = wsPath && termsRef.current[wsPath] ? termsRef.current[wsPath].text : "";
        const last = pre.dataset.sbLen;
        const len = String(text.length);
        if (last !== len) {
          pre.dataset.sbLen = len;
          pre.scrollTop = pre.scrollHeight;
        }
      });

      const onTermKey = useCallback((event) => {
        const entry = termsRef.current[wsPath];
        if (!entry || !entry.id || entry.exited) return;
        const k = event.key;
        let data = null;
        if (k === "Enter") data = "\n";
        else if (k === "Backspace") data = "\u007f";
        else if (k === "Tab") data = "\t";
        else if (k === "Escape") data = "\u001b";
        else if (k === "ArrowUp") data = "\u001b[A";
        else if (k === "ArrowDown") data = "\u001b[B";
        else if (k === "ArrowRight") data = "\u001b[C";
        else if (k === "ArrowLeft") data = "\u001b[D";
        else if (k === "Home") data = "\u001b[H";
        else if (k === "End") data = "\u001b[F";
        else if (event.ctrlKey && !event.altKey && !event.metaKey && k.length === 1) {
          const code = k.toLowerCase().charCodeAt(0);
          if (code >= 97 && code <= 122) data = String.fromCharCode(code - 96);
          else if (k === " ") data = "\u0000";
          else if (k === "@") data = "\u0000";
        } else if (!event.metaKey && k.length === 1) {
          // printable and AltGr (Ctrl+Alt) characters alike — plain text wins
          data = k;
        }
        if (data === null) return;
        event.preventDefault();
        // batch rapid keystrokes per workspace: coalesce into one RPC within a
        // 12ms window so fast typing sends one packet instead of one per key;
        // keyed by wsPath so a mid-window tab switch never cross-wires streams
        const pending = pendingWritesRef.current[wsPath] || (pendingWritesRef.current[wsPath] = []);
        pending.push(data);
        if (pending.length === 1) {
          setTimeout(() => {
            const batch = pending.join("");
            pending.length = 0;
            const live = termsRef.current[wsPath];
            if (batch && live && live.id && !live.exited) {
              rpc("termWrite", { termId: live.id, text: batch }).catch(() => {});
            }
          }, WRITE_BATCH_MS);
        }
      }, [wsPath]);

      const onPaste = useCallback((event) => {
        const entry = termsRef.current[wsPath];
        if (!entry || !entry.id || entry.exited) return;
        const text = event.clipboardData ? event.clipboardData.getData("text") : "";
        if (!text) return;
        event.preventDefault();
        rpc("termWrite", { termId: entry.id, text }).catch(() => {});
      }, [wsPath]);

      const entry = wsPath ? termsRef.current[wsPath] : null;
      // one spawn at a time per workspace: respawn clears the entry first, so a
      // slow termSpawn plus another respawn cannot double-spawn through the guard
      const spawningNow = !!(entry && entry.spawning && !entry.id);

      const kill = useCallback(async () => {
        const current = termsRef.current[wsPath];
        if (!current || !current.id) return;
        // stop the poller first: termKill deletes the terminal host-side, and a
        // termRead in the kill window would fail with "unknown terminal"
        current.exited = true;
        current.outcome = current.outcome || { exitCode: null, signal: "SIGKILL" };
        touch();
        try { await rpc("termKill", { termId: current.id }); } catch { /* already gone */ }
      }, [wsPath, touch]);

      const respawn = useCallback(() => {
        const current = termsRef.current[wsPath];
        if (current && current.id) rpc("termKill", { termId: current.id }).catch(() => {});
        delete termsRef.current[wsPath];
        touch();
        ensureTerminal(wsPath);
      }, [wsPath, touch, ensureTerminal]);

      return h("div", { className: "dsh-sb-body" },
        !wsPath
          ? h("div", { className: "dsh-sb-empty" }, "no registered workspace")
          : h("div", { className: "dsh-sb-term" },
              entry && (entry.exited || entry.error)
                ? h("div", { className: "dsh-sb-banner" },
                    h("span", null, entry.error
                      ? "terminal error: " + entry.error
                      : "terminal exited" + (entry.outcome && Number.isFinite(entry.outcome.exitCode) ? " (exit " + entry.outcome.exitCode + ")" : entry.outcome && entry.outcome.signal ? " (" + entry.outcome.signal + ")" : "")),
                    h("button", { className: "dsh-sb-btn", onClick: respawn, disabled: spawningNow }, "respawn"))
                : null,
              h("pre", {
                ref: preRef,
                className: "dsh-sb-termpre",
                tabIndex: 0,
                "aria-label": "Integrated terminal output; type to send input",
                onKeyDown: onTermKey,
                onPaste: onPaste,
                onClick: (e) => e.currentTarget.focus(),
                spellCheck: false,
              },
                entry
                  ? [
                      entry.motd ? h("span", { key: "motd", className: "dsh-sb-termmotd" }, entry.motd) : null,
                      entry.text,
                    ]
                  : null),
              h("div", { className: "dsh-sb-termbar" },
                h("span", null, entry && entry.id ? entry.id + (entry.spawning ? " · spawning…" : " · click the pane and type; Enter runs, Ctrl+C interrupts") : entry && entry.spawning ? "spawning bash…" : ""),
                h("span", { className: "dsh-sb-spacer" }),
                entry && entry.id && !entry.exited
                  ? h("button", { className: "dsh-sb-btn", onClick: kill }, "stop")
                  : null)));
    }

    // --- the right-docked panel (shell.overlay slot entry) ---
    function Panel() {
      const open = useSyncExternalStore(subscribe, getSnapshot);
      const width = useSyncExternalStore(subscribeWidth, getWidthSnapshot);
      const [tab, setTab] = useState("tree");
      const [wsError, setWsError] = useState(null);
      const [wsPath, setWsPath] = useState(null);
      const [dragging, setDragging] = useState(false);
      // the current session's agent active directory (latest observed shell
      // call's workdir) and its switch callback, rendered by the Diff tab
      const observation = useAgentActiveDir();
      const agentCwd = observation && typeof observation.cwd === "string" ? observation.cwd : null;

      // the Panel stays mounted while closed (renders null), so the reserve
      // effect owns both states: apply on open/width change (drag included,
      // layout timing so the margin lands the same frame as the edge), release
      // on close. No cleanup-on-width: release only happens on the closed branch.
      useLayoutEffect(() => {
        if (!open) {
          releaseReserve();
          return undefined;
        }
        applyReserve(width);
        return undefined;
      }, [open, width]);

      const onStartDrag = useCallback((event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        setReserveTransition(true);
      }, []);
      const onMoveDrag = useCallback((event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        // right-docked: dragging left grows the panel
        setPanelWidth(window.innerWidth - event.clientX);
      }, []);
      const onEndDrag = useCallback((event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        setReserveTransition(false);
        persistWidth();
      }, []);
      const onCancelDrag = useCallback((event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        setReserveTransition(false);
        setPanelWidth(width); // snap back to the last committed width
        persistWidth();
      }, [width]);
      // keyboard resizing (ARIA separator pattern): same write path as drag
      const onKeyDown = useCallback((event) => {
        let next = null;
        if (event.key === "ArrowLeft") next = width + 12; // left grows a right-docked panel
        else if (event.key === "ArrowRight") next = width - 12;
        else if (event.key === "Home") next = PANEL_MIN;
        else if (event.key === "End") next = PANEL_MAX;
        if (next === null) return;
        event.preventDefault();
        setPanelWidth(next);
        persistWidth();
      }, [width]);

      useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        // workspace swapping is automatic (session-follow + agent-follow
        // below); this call only surfaces gateway errors and seeds a fallback
        // path when no session cwd is known yet
        rpc("workspaces", {}).then((res) => {
          if (cancelled) return;
          const rows = Array.isArray(res) ? res : res && Array.isArray(res.workspaces) ? res.workspaces : [];
          setWsError(null);
          setWsPath((current) => current !== null ? current : rows.length > 0 ? rows[0].path : null);
        }, (err) => {
          if (cancelled) return;
          setWsError(err.message || String(err));
        });
        return () => { cancelled = true; };
      }, [open]);

      // follow the current session: the sessions face is the same fact source
      // the host sidebar highlights from. Only a selection CHANGE swaps the
      // panel (cwd → registered workspace path): swapping on every list
      // notification would clobber a manual workspace choice — including the
      // Diff tab's agent-directory switch — on unrelated refreshes (a running
      // session's job frames arrive as list updates).
      const sessionsFace = hostCtx ? hostCtx.sessions : null;
      const followedRef = useRef(null);
      useEffect(() => {
        if (!open || !sessionsFace || typeof sessionsFace.list?.subscribe !== "function") return undefined;
        const pick = () => {
          const state = sessionsFace.list.getSnapshot();
          const id = state && state.current;
          if (!id || id === followedRef.current) return;
          // client list rows: items is the runtime array shape; byId the typed record
          const row = sessionRow(state, id);
          const cwd = row && row.cwd;
          // assign the tracker only after a usable cwd: a row that arrives
          // later (id published before its row) must stay eligible, or
          // selecting that chat would never move the panel to its workspace
          if (!cwd) return;
          followedRef.current = id;
          setWsPath(cwd);
        };
        pick();
        return sessionsFace.list.subscribe(pick);
      }, [open, sessionsFace]);
      // a selection change re-arms follow even when the effect re-runs for the
      // same session (panel reopen): drop the stale watched id on unmount
      useEffect(() => () => { followedRef.current = null; }, []);

      // auto-follow the agent's active directory: the observation store only
      // notifies on a real change, so each notification is one distinct
      // directory. Following a registered workspace re-points the whole panel
      // with no user action; an unregistered one (a scratch dir, home) is
      // skipped — the row shows the away state instead, and no error flashes.
      // Sidebar chat selection still moves the panel first (session-follow
      // above sets its cwd); the agent's latest shell workdir then takes over
      // when that session has one. Own ref: the session-follow effect tracks
      // the session ID in followedRef — sharing this tracker would corrupt it
      // (a path where an id belongs) and the next list notification would
      // re-swap the panel back to the session cwd, clobbering the follow.
      const agentFollowedRef = useRef(null);
      const registeredRef = useRef(null);
      // containment check against the registered workspace set: one
      // boundary-aware predicate for every probe (cached, fresh, success)
      const registeredContains = (set, target) => set.has(target)
        || (typeof target === "string" && target !== "" && [...set].some((p) => pathContains(p, target)));
      useEffect(() => {
        // Gated on open: while closed the session-follow effect is dormant, so
        // a follow landed here would be clobbered by its first pick() at open
        // (the never-set followedRef reads as a selection change) and the
        // panel would flip back to the session cwd. Firing at open keeps the
        // order: session-follow swaps first, the agent follow lands after it
        // in the same batch and wins. While closed the observation keeps
        // tracking (hook above), so reopen always follows the latest dir.
        if (!open) return undefined;
        const cwd = observation && observation.cwd;
        if (!cwd) { agentFollowedRef.current = null; return undefined; }
        if (agentFollowedRef.current === cwd) return undefined;
        agentFollowedRef.current = cwd;
        const registered = registeredRef.current;
        if (registered && registered.size > 0) {
          if (registeredContains(registered, cwd)) setWsPath(cwd);
          return undefined;
        }
        // registry not loaded yet: fetch it once, then follow if eligible
        let cancelled = false;
        rpc("workspaces", {}).then((res) => {
          if (cancelled) return;
          const rows = Array.isArray(res) ? res : res && Array.isArray(res.workspaces) ? res.workspaces : [];
          const set = new Set(rows.map((r) => r && r.path).filter((p) => typeof p === "string" && p !== ""));
          registeredRef.current = set;
          if (registeredContains(set, cwd)) setWsPath(cwd);
        }, () => {
          // RPC failed: leave the workspace unchanged — following blindly
          // could repoint the panel at an unregistered directory (/tmp, home)
          // and every tab request would then fail host-side; the next
          // distinct directory retries the lookup
          if (cancelled) return;
          registeredRef.current = null;
        });
        return () => { cancelled = true; };
      }, [open, observation]);

      // Escape closes the panel — unless the terminal pane owns the key
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key !== "Escape") return;
          const target = event.target;
          if (target && typeof target.closest === "function" && target.closest(".dsh-sb-termpre")) return;
          setPanelOpen(false);
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [open]);

      if (!open) return null;

      const tabs = [
        { id: "tree", label: "Tree", icon: FolderSvg },
        { id: "diff", label: "Diff", icon: DiffSvg },
        { id: "terminal", label: "Terminal", icon: TermSvg },
      ];

      const tree = h("div", {
        className: "dsh-sb-panel",
        style: { width: width + "px" },
        "data-dragging": dragging || void 0,
        role: "complementary",
        "aria-label": "dsh sidebar panel",
      },
        h("div", {
          className: "dsh-sb-resize",
          "data-dragging": dragging || void 0,
          "aria-label": "Resize sidebar panel",
          role: "separator",
          "aria-orientation": "vertical",
          onPointerDown: onStartDrag,
          onPointerMove: onMoveDrag,
          onPointerUp: onEndDrag,
          onPointerCancel: onCancelDrag,
          onKeyDown,
          tabIndex: 0,
        }),
        h("div", { className: "dsh-sb-head" },
          h("span", { className: "dsh-sb-title" }, h(PanelSvg, { size: 16 }), "Sidebar"),
          h("button", { className: "dsh-sb-x", "aria-label": "Close sidebar panel", onClick: () => setPanelOpen(false) }, h(CloseSvg))),
        h("div", { className: "dsh-sb-tabs" }, tabs.map((t) =>
          h("button", {
            key: t.id,
            type: "button",
            className: "dsh-sb-tab" + (tab === t.id ? " dsh-sb-tab-on" : ""),
            "aria-selected": tab === t.id ? "true" : "false",
            role: "tab",
            onClick: () => setTab(t.id),
          }, h(t.icon), t.label, t.id === "diff" ? h(DiffTabBadge) : null))),
        wsError ? h("div", { className: "dsh-sb-err" }, wsError) : null,
        tab === "tree" ? h(TreeTab, { wsPath }) : null,
        tab === "diff" ? h(DiffTab, { wsPath }) : null,
        tab === "terminal" ? h(TermTab, { wsPath }) : null,
        h(RepoInfoBar, { wsPath, agentCwd }));

      // Portal to body: a fixed dock can be clipped by transformed ancestors
      // inside the app frame (mneme's verified pattern).
      if (reactDom && typeof document !== "undefined") return reactDom.createPortal(tree, document.body);
      return tree;
    }

    function apply(ctx) {
      // No hooks here: apply() is a plain setup function, not a React
      // component — the hook dispatcher is null at apply time. All state
      // lives in the slot components above.
      hostCtx = ctx;
      injectCss();
      ctx.slots.inject("sidebar.footer.action", () => {
        return ctx.slots.register({
          name: "sidebar.footer.action",
          id: "dsh-sidebar",
          order: 20,
          label: "Sidebar",
        }, FooterEntry);
      });
      ctx.slots.inject("shell.overlay", () => {
        return ctx.slots.register({
          name: "shell.overlay",
          id: "dsh-sidebar-panel",
          order: 100,
        }, Panel);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = "dsh-sidebar";
    // test seam: pure path/matching helpers, exercised by test/agentcwd.test.js
    exports.internals = { samePath, normalizeSegments, resolveShellCwd, matchWorktree, agentSegment, agentDisplayPath, shellCallWorkdir, sessionRow };
    return module.exports;
  },
});




