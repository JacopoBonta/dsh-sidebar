/** dsh-sidebar client half — right-docked panel: tree explorer, diff explorer, integrated terminal. */

window.__ModuleLoader__.load({
  id: "dsh-sidebar",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useLayoutEffect, useRef, useCallback, useSyncExternalStore } = react;
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
      ".dsh-sb-panel{position:fixed;top:0;right:0;bottom:0;width:var(--dsh-sidebar-panel-width,420px);z-index:940;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:13px}",
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
      ".dsh-sb-repo{flex:none;display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;min-width:0}",
      ".dsh-sb-repoic{flex:none;display:flex;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sb-reponame{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sb-repochip{flex:none;display:inline-flex;align-items:center;gap:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;padding:1px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sb-meta .dsh-sb-spacer{margin-left:auto}",
      ".dsh-sb-btn{font:inherit;font-size:11px;padding:3px 10px;border-radius:6px;cursor:pointer;background:none;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);display:inline-flex;align-items:center;gap:5px}",
      ".dsh-sb-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-sb-btn:disabled{opacity:.4;cursor:default}",
      ".dsh-sb-scroll{flex:1;min-height:0;overflow:auto;padding:8px 12px}",
      ".dsh-sb-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:8px 12px;white-space:pre-wrap;word-break:break-word}",
      ".dsh-sb-empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:12px}",
      ".dsh-sb-row{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary);white-space:nowrap}",
      ".dsh-sb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-sb-rowname{overflow:hidden;text-overflow:ellipsis}",
      ".dsh-sb-rowsize{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;flex:none}",
      ".dsh-sb-twisty{flex:none;display:flex;align-items:center;color:var(--dsw-alias-label-tertiary);width:12px}",
      ".dsh-sb-fileic{flex:none;display:flex;color:var(--dsw-alias-label-secondary)}",
      ".dsh-sb-loading{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:2px 6px}",
      ".dsh-sb-preview{flex:none;height:42%;min-height:120px;border-top:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column}",
      ".dsh-sb-previewhead{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
      ".dsh-sb-previewhead .dsh-sb-x{margin-left:auto;width:22px;height:22px}",
      ".dsh-sb-previewbody{flex:1;min-height:0;overflow:auto;margin:0;padding:8px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;white-space:pre;color:var(--dsw-alias-label-primary)}",
      ".dsh-sb-status{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px}",
      ".dsh-sb-chip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;padding:1px 7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sb-chip-a{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
      ".dsh-sb-chip-d{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".dsh-sb-chip-m{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l1))}",
      ".dsh-sb-diffwrap{flex:1;min-height:0;overflow:auto}",
      ".dsh-sb-diffpre{margin:0;padding:8px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;white-space:pre;color:var(--dsw-alias-label-primary)}",
      ".dsh-sb-dl-add{color:var(--dsw-alias-state-success-primary)}",
      ".dsh-sb-dl-del{color:var(--dsw-alias-state-error-primary)}",
      ".dsh-sb-dl-meta{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sb-dl-hdr{font-weight:600}",
      ".dsh-sb-term{flex:1;min-height:0;display:flex;flex-direction:column}",
      ".dsh-sb-termpre{flex:1;min-height:0;overflow:auto;margin:0;padding:8px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary);outline:none;cursor:text}",
      ".dsh-sb-termpre:focus{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);border-radius:4px}",
      ".dsh-sb-termmotd{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sb-termbar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}",
      ".dsh-sb-banner{margin:8px 12px;padding:8px 10px;border:1px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l1));border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;align-items:center;gap:10px}",
      "@media (prefers-reduced-motion:reduce){.dsh-sb-panel{transition:none}.dsh-sb-resize:after{transition:none}}",
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

    // --- diff tab ---
    function DiffTab(props) {
      const wsPath = props.wsPath;
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [tick, setTick] = useState(0);

      useEffect(() => {
        if (!wsPath) return undefined;
        let cancelled = false;
        setLoading(true);
        setError(null);
        rpc("diff", { workspacePath: wsPath }).then((res) => {
          if (cancelled) return;
          setData(res);
          setLoading(false);
        }, (err) => {
          if (cancelled) return;
          setError(err.message || String(err));
          setLoading(false);
        });
        return () => { cancelled = true; };
      }, [wsPath, tick]);

      const status = data && Array.isArray(data.status) ? data.status : [];
      const diffText = data && typeof data.diff === "string" ? data.diff : "";
      const lines = diffText.length > 0 ? diffText.split("\n") : [];
      const repo = data && data.repo;
      // branch chip label: branch name, or "detached @ <short sha>"
      const shaShort = repo && repo.sha ? String(repo.sha).slice(0, 8) : null;
      const branchLabel = repo ? (repo.branch ? repo.branch : repo.detached ? "detached" + (shaShort ? " @ " + shaShort : "") : "no commits") : "";
      // hidden details: worktree list in the branch chip tooltip
      const worktreeTitle = repo && repo.isWorktree && Array.isArray(repo.worktrees)
        ? repo.worktrees.map((wt) => (wt.path + (wt.branch ? " [" + wt.branch + "]" : " (detached)") + (wt.isCurrent ? " ← current" : ""))).join("\n")
        : null;

      return h("div", { className: "dsh-sb-body" },
        repo
          ? h("div", { className: "dsh-sb-repo" },
              h("span", { className: "dsh-sb-repoic" }, h(BranchSvg, { size: 13 })),
              h("span", { className: "dsh-sb-repochip", title: worktreeTitle || branchLabel },
                h(BranchSvg, { size: 10 }), branchLabel),
              repo.isWorktree ? h("span", { className: "dsh-sb-repochip", title: "main worktree: " + (repo.mainRoot || "?") }, "worktree") : null,
              h("span", { className: "dsh-sb-reponame", title: repo.mainRoot || repo.root }, repo.name))
          : null,
        h("div", { className: "dsh-sb-meta" },
          h("button", { className: "dsh-sb-btn", onClick: () => setTick((v) => v + 1), disabled: !wsPath || loading },
            h(RefreshSvg), "refresh"),
          h("span", null, loading ? "loading…" : data && data.isGit ? status.length + " changed file(s)" : ""),
          data && data.truncated ? h("span", { className: "dsh-sb-chip dsh-sb-chip-m", title: "diff capped at 256 KiB" }, "truncated") : null),
        !wsPath
          ? h("div", { className: "dsh-sb-empty" }, "no registered workspace")
          : error
            ? h("div", { className: "dsh-sb-err" }, error)
            : data && !data.isGit
              ? h("div", { className: "dsh-sb-empty" }, "not a git repository (or git failed) — nothing to diff")
              : h("div", { className: "dsh-sb-diffwrap" },
                  status.length > 0
                    ? h("div", { className: "dsh-sb-status" }, status.map((row) => {
                        const code = (row.code || "").trim();
                        const kind = code.startsWith("A") ? "a" : code.startsWith("D") ? "d" : code.startsWith("?") ? "" : "m";
                        return h("span", { key: row.path, className: "dsh-sb-chip" + (kind ? " dsh-sb-chip-" + kind : ""), title: row.code + " " + row.path },
                          code + " " + row.path);
                      }))
                    : data && data.isGit ? h("div", { className: "dsh-sb-empty" }, "working tree clean") : null,
                  lines.length > 0
                    ? h("pre", { className: "dsh-sb-diffpre" }, lines.map((line, i) => {
                        let cls = "";
                        if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++ ") || line.startsWith("--- ")) cls = "dsh-sb-dl-hdr";
                        else if (line.startsWith("@@")) cls = "dsh-sb-dl-meta";
                        else if (line.startsWith("+")) cls = "dsh-sb-dl-add";
                        else if (line.startsWith("-")) cls = "dsh-sb-dl-del";
                        return h("span", { key: i, className: cls }, line + "\n");
                      }))
                    : null));
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
        // workspace swapping is automatic (session-follow below); this call only
        // surfaces gateway errors and seeds a fallback path when no session cwd
        // is known yet
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
      // the host sidebar highlights from. When the selection changes, swap the
      // panel to the session's workspace (cwd → registered workspace path).
      const sessionsFace = hostCtx ? hostCtx.sessions : null;
      useEffect(() => {
        if (!open || !sessionsFace || typeof sessionsFace.list?.subscribe !== "function") return undefined;
        const pick = () => {
          const state = sessionsFace.list.getSnapshot();
          const id = state && state.current;
          if (!id) return;
          // client list rows: items is the runtime array shape; byId the typed record
          const row = Array.isArray(state && state.items)
            ? (state.items.find((item) => item.sessionId === id || item.id === id) || null)
            : (state && state.byId ? state.byId[id] || null : null);
          const cwd = row && row.cwd;
          if (!cwd) return;
          setWsPath(cwd);
        };
        pick();
        return sessionsFace.list.subscribe(pick);
      }, [open, sessionsFace]);

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
          }, h(t.icon), t.label))),
        wsError ? h("div", { className: "dsh-sb-err" }, wsError) : null,
        tab === "tree" ? h(TreeTab, { wsPath }) : null,
        tab === "diff" ? h(DiffTab, { wsPath }) : null,
        tab === "terminal" ? h(TermTab, { wsPath }) : null);

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
    return module.exports;
  },
});
