// dsh-hdc-panel browser bundle — official client-plugin shape, registered as
// a right-sidebar tab type with a Start-page (guide) entry, modeled on the
// platform's own sidebar plugins (ui-sidebar-browser, ui-sidebar-files):
//   * entry: a guide card on the Start page via ctx.sidebarRightTabs.register
//     (kind 'hdcPanel'); picking it calls openTab(kind, { replaceTab: true })
//     so the Start page gives way to the panel tab
//   * surface: the panel body registered under the keyed
//     'sidebar.right.pane.tab' seat — a full-height page on --dsw-alias-bg-base,
//     the same chrome as the platform's own sidebar pages (38px toolbar, 28px
//     icon buttons, official StateDot / Tag / font / radius tokens)
//   * fallback: when sidebarRightTabs/sidebarRight are unavailable, a legacy
//     floating-portal panel keeps the panel reachable
// Data comes from the host half's read-only REST routes (/api2/hdc-panel/*).
// Polling: 8s/20s while the tab is open, 60s otherwise.
// Boot diagnostics: surface any factory/apply error as a visible banner so a
// failed activation is readable without opening DevTools.
function __hdcReport(stage, e) {
  try {
    var msg = '[hdc-panel ' + stage + '] ' + (e && e.stack || e);
    console.error(msg);
    if (typeof document !== 'undefined') {
      var b = document.createElement('pre');
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b3261e;color:#fff;font:11px/1.4 ui-monospace,monospace;padding:6px 10px;margin:0;white-space:pre-wrap;max-height:40vh;overflow:auto';
      b.textContent = msg;
      (document.body || document.documentElement).appendChild(b);
    }
  } catch (_) {}
}
window.__ModuleLoader__.load({
  id: 'dsh-hdc-panel',
  factory: (require) => {
    try { return __hdcFactory(require); }
    catch (e) { __hdcReport('factory', e); throw e; }
  },
});
function __hdcFactory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    var ReactDOM = require('react-dom');
    var NL = String.fromCharCode(10);
    var PLUGIN_ID = '@dsh-hdc-panel/sidebar';
    var TAB_KIND = 'hdcPanel';
    // Captured at apply(): lets panel components reach the host's root services
    // (conversation / sessions) to stage a screenshot as a composer draft
    // attachment — the same intake the official drop handler uses.
    var rootCtx = null;
    var POLL_FAST = 8000;
    var POLL_SLOW = 20000;
    var POLL_CLOSED = 60000;
    // Leave/return persistence: the pane-tab seat unmounts inactive tab
    // bodies, so a returning panel would otherwise blank out until the first
    // poll lands. The last good panel-state is kept in localStorage and
    // hydrated synchronously on mount; whether the tab was open is remembered
    // so a page reload restores the panel without a Start-page detour.
    var LS_STATE_KEY = 'dsh-hdc-panel:state';
    var LS_OPEN_KEY = 'dsh-hdc-panel:open';
    function loadCachedState() {
      try {
        var raw = localStorage.getItem(LS_STATE_KEY);
        if (!raw) return null;
        var v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
      } catch (e) { return null; }
    }
    function saveCachedState(s) {
      try { if (s && typeof s === 'object') localStorage.setItem(LS_STATE_KEY, JSON.stringify(s)); } catch (e) { /* quota/private mode: skip */ }
    }

    // Visual language ported from the platform's own modules
    // (Browser.module.css / StateDot / Tag in dsh-client-ui-primitives):
    // full-bleed bg-base page, 38px toolbar with 28px icon tools, 0.5px
    // border-l3 separators, --dsw-radius-* corners, --dsw-font-* sizes, and
    // the official 11px capsule Tag + 10px StateDot layouts.
    var CSS = [
      // ---- panel page chrome (mirrors .qWvkEq_root / .qWvkEq_toolbar) ----
      '.hdcp-root{height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);flex-direction:column;flex:auto;display:flex;font:var(--dsw-font-xxs-12,12px/1.5 system-ui);}',
      '.hdcp-toolbar{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;align-items:center;gap:4px;height:38px;padding:5px 6px;display:flex;}',
      '.hdcp-tool{width:28px;height:28px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm,6px);cursor:pointer;background:0 0;border:0;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex;}',
      '.hdcp-tool:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
      '.hdcp-tool:disabled{color:var(--dsw-alias-label-quaternary);cursor:default;}',
      // refresh spinner: icon spins while the refresh request is in flight
      '.hdcp-spin-slot{display:inline-flex;justify-content:center;align-items:center;}',
      '.hdcp-spin-slot.busy svg{animation:hdcp-spin .8s linear infinite;}',
      '@keyframes hdcp-spin{to{transform:rotate(360deg);}}',
      '.hdcp-title{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;font:var(--dsw-font-xs-13,13px/1.4 system-ui);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.hdcp-toolbar > img{width:16px;height:16px;border-radius:4px;object-fit:cover;display:block;flex:none;}',
      '.hdcp-title img{width:16px;height:16px;border-radius:4px;object-fit:cover;display:block;flex:none;}',
      '.hdcp-sub{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12,12px);font-weight:400;overflow:hidden;text-overflow:ellipsis;}',
      // official StateDot geometry: 10px slot, 6px currentColor core
      '.hdcp-dot{position:relative;display:inline-block;flex:none;width:10px;height:10px;}',
      '.hdcp-dot::after{content:"";position:absolute;inset:20%;border-radius:50%;background:currentColor;}',
      '.hdcp-dot[data-state="done"]{color:var(--dsw-alias-state-success-primary);}',
      '.hdcp-dot[data-state="warning"]{color:var(--dsw-alias-state-warn-primary);}',
      '.hdcp-dot[data-state="error"]{color:var(--dsw-alias-state-error-primary);}',
      '.hdcp-dot[data-state="idle"]{color:var(--dsw-alias-state-idle-primary,var(--dsw-alias-label-quaternary));}',
      // ---- content area: sectioned scroll, no nested cards ----
      '.hdcp-body{flex:1 1 auto;min-height:0;overflow:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);}',
      '.hdcp-section{padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);}',
      '.hdcp-section:last-child{border-bottom:none;}',
      '.hdcp-section-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11,11px);font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;}',
      '.hdcp-section-head svg{flex:none;}',
      '.hdcp-empty{color:var(--dsw-alias-label-tertiary);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px 12px;text-align:center;}',
      '.hdcp-empty svg{opacity:.5;color:var(--dsw-alias-label-quaternary);}',
      // ---- device rows: official 28px-hover list-row language ----
      '.hdcp-dev{display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;}',
      '.hdcp-dev:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.hdcp-dev[data-selected="true"]{background:var(--dsw-alias-interactive-bg-selected,rgba(128,160,255,.10));}',
      '.hdcp-dev-main{flex:1 1 auto;min-width:0;}',
      '.hdcp-dev-state{color:var(--dsw-alias-label-quaternary);margin-top:4px;}',
      '.hdcp-dev-state.on{color:var(--dsw-alias-state-success-primary);}',
      '.hdcp-dev-name{display:flex;align-items:center;gap:6px;overflow:hidden;}',
      '.hdcp-dev-name span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.hdcp-dev-id{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-quaternary);font-size:11px;flex:none;}',
      '.hdcp-dev-sub{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;}',
      // official Tag capsule geometry (11px/17px, 1px 8px, radius 999)
      '.hdcp-tag{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-tsp-secondary,rgba(127,127,127,.12));}',
      '.hdcp-tag svg{flex:none;}',
      '.hdcp-tag[data-tone="outline"]{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);background:transparent;}',
      '.hdcp-tag[data-tone="accent"]{color:var(--dsw-alias-state-business-primary,#7aa7ff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#7aa7ff) 12%,transparent);}',
      '.hdcp-tag[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);}',
      '.hdcp-tag[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);}',
      // ---- screenshot / log surfaces ----
      // Thumbnail in the flow: capped height, centered on a dark stage, so a
      // tall phone capture does not push the rest of the panel out of view.
      // Clicking opens the full-size lightbox (official ImageLightbox mood:
      // dim overlay, click anywhere to dismiss).
      '.hdcp-shot{margin-top:8px;}',
      '.hdcp-shot-stage{background:var(--dsw-alias-bg-layer-1,#16171c);border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l3);padding:8px;display:flex;justify-content:center;cursor:zoom-in;}',
      '.hdcp-shot-stage img{max-width:100%;max-height:220px;width:auto;border-radius:4px;display:block;}',
      '.hdcp-shot-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:2px;display:flex;align-items:center;gap:4px;}',
      '.hdcp-lightbox{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:48px;cursor:zoom-out;}',
      '.hdcp-lightbox img{max-width:100%;max-height:100%;border-radius:var(--dsw-radius-md,8px);box-shadow:0 12px 48px rgba(0,0,0,.5);}',
      '.hdcp-lightbox-close{position:fixed;top:16px;right:16px;width:32px;height:32px;border:none;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;}',
      '.hdcp-lightbox-close:hover{background:rgba(255,255,255,.26);}',
      // ---- context menu on the screenshot (official Menu surface mood) ----
      '.hdcp-ctx{position:fixed;z-index:2147483600;min-width:132px;padding:4px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,#23252c);box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;flex-direction:column;}',
      '.hdcp-ctx-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12,12px);cursor:pointer;text-align:left;}',
      '.hdcp-ctx-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.hdcp-ctx-item svg{color:var(--dsw-alias-label-secondary);flex:none;}',
      '.hdcp-ctx-sep{height:.5px;background:var(--dsw-alias-border-l3);margin:4px 2px;}',
      // inline "copy" affordance next to the screenshot label
      '.hdcp-shot-actions{display:flex;align-items:center;gap:2px;margin-left:auto;}',
      '.hdcp-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483700;padding:6px 14px;border-radius:999px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground,#fff);font:var(--dsw-font-xxs-12,12px);box-shadow:0 6px 18px rgba(0,0,0,.3);}',
      '.hdcp-shot-close{display:none;}',
      '.hdcp-pre{margin:0;max-height:160px;overflow:auto;background:var(--dsw-alias-markdown-code-block,#16171c);padding:8px;border-radius:var(--dsw-radius-md,8px);font:10px/1.45 ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-all;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);}',
      '.hdcp-sys{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;color:var(--dsw-alias-label-secondary);font-size:11px;}',
      '.hdcp-sys span{display:flex;align-items:center;gap:5px;}',
      '.hdcp-sys svg{color:var(--dsw-alias-label-quaternary);flex:none;}',
      '.hdcp-foot{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-quaternary);font-size:11px;}',
      '.hdcp-err{display:flex;align-items:flex-start;gap:6px;color:var(--dsw-alias-state-error-primary);font-size:11px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);}',
      // ---- legacy floating fallback surface (no sidebar tab API) ----
      '.hdcp-float{position:fixed;top:70px;right:16px;z-index:1000;width:340px;max-width:calc(100vw - 32px);pointer-events:auto;height:auto;max-height:calc(100vh - 100px);}',
      '.hdcp-float .hdcp-root{box-shadow:0 8px 24px rgba(0,0,0,.38);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);overflow:hidden;background:var(--dsw-alias-bg-base);}',
      '.hdcp-tool:focus-visible,.hdcp-dev:focus-visible,.hdcp-shot-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '@media (prefers-reduced-motion:reduce){.hdcp-tool{transition:none;}}',
    ].join('');

    // Official CSS-injection convention: idempotent <style data-plugin-css>.
    function injectStyles() {
      var tagId = 'dsh-hdc-panel/panel.css';
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
        var tag = document.createElement('style');
        tag.setAttribute('data-plugin-css', tagId);
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
    }

    function fmtTime(ms) {
      var d = new Date(ms);
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    }

    // ---- icons: official stroke conventions (16 viewBox, strokeWidth 1,
    //      currentColor), paths hand-drawn to the primitives' line style ----
    function Svg(props, kids) {
      return React.createElement('svg', {
        width: (props && props.size) || 16,
        height: (props && props.size) || 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        className: props && props.className,
        style: props && props.style,
      }, kids);
    }
    function IconPhone() {
      return Svg(null, [
        React.createElement('rect', { x: 4.5, y: 1.5, width: 7, height: 13, rx: 1.5, stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round' }),
        React.createElement('line', { x1: 6.75, y1: 12.25, x2: 9.25, y2: 12.25, stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
      ]);
    }
    function IconPhoneArtwork() {
      // Guide artwork variant: filled handset on a rounded brand tile,
      // matching the platform guide artworks' filled, self-contained style.
      return React.createElement('svg', { width: 36, height: 36, viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('rect', { width: 36, height: 36, rx: 8, fill: 'url(#hdcpGuideGrad)' }),
        React.createElement('defs', null,
          React.createElement('linearGradient', { id: 'hdcpGuideGrad', x1: 0, y1: 0, x2: 36, y2: 36, gradientUnits: 'userSpaceOnUse' },
            React.createElement('stop', { stopColor: '#5a7bfa' }),
            React.createElement('stop', { offset: '1', stopColor: '#8a5afa' })
          )
        ),
        React.createElement('rect', { x: 11, y: 5, width: 14, height: 26, rx: 3, fill: '#fff', fillOpacity: .95 }),
        React.createElement('rect', { x: 15.5, y: 26.5, width: 5, height: 1.6, rx: .8, fill: '#5a7bfa' })
      );
    }
    function IconRefresh() {
      return Svg(null, [
        React.createElement('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }
    function IconCamera() {
      return Svg(null, [
        React.createElement('path', { d: 'M2.5 5.5h2l1.2-2h4.6l1.2 2h2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round' }),
        React.createElement('circle', { cx: 8, cy: 9.5, r: 2.25, stroke: 'currentColor', strokeWidth: 1 }),
      ]);
    }
    function IconClose() {
      return Svg({ size: 12 }, [
        React.createElement('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      ]);
    }
    function IconChip() {
      return Svg(null, [
        React.createElement('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.5, stroke: 'currentColor', strokeWidth: 1 }),
        React.createElement('path', { d: 'M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
      ]);
    }
    function IconBattery() {
      return Svg(null, [
        React.createElement('rect', { x: 1.5, y: 5, width: 11, height: 6, rx: 1.5, stroke: 'currentColor', strokeWidth: 1 }),
        React.createElement('path', { d: 'M14 7v2', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
        React.createElement('rect', { x: 3, y: 6.5, width: 5, height: 3, rx: .75, fill: 'currentColor' }),
      ]);
    }
    function IconThermo() {
      return Svg(null, [
        React.createElement('path', { d: 'M8 2.5a1.5 1.5 0 0 1 1.5 1.5v4.3a3 3 0 1 1-3 0V4A1.5 1.5 0 0 1 8 2.5z', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round' }),
      ]);
    }
    function IconMemory() {
      return Svg(null, [
        React.createElement('rect', { x: 1.5, y: 4.5, width: 13, height: 7, rx: 1.5, stroke: 'currentColor', strokeWidth: 1 }),
        React.createElement('path', { d: 'M4.5 4.5v-2M8 4.5v-2M11.5 4.5v-2M4.5 11.5v2M8 11.5v2M11.5 11.5v2', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
      ]);
    }
    function IconStorage() {
      return Svg(null, [
        React.createElement('ellipse', { cx: 8, cy: 4, rx: 5.5, ry: 2.2, stroke: 'currentColor', strokeWidth: 1 }),
        React.createElement('path', { d: 'M2.5 4v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V4', stroke: 'currentColor', strokeWidth: 1 }),
        React.createElement('path', { d: 'M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2', stroke: 'currentColor', strokeWidth: 1 }),
      ]);
    }
    function IconDisplay() {
      return Svg(null, [
        React.createElement('rect', { x: 1.5, y: 2.5, width: 13, height: 9, rx: 1.5, stroke: 'currentColor', strokeWidth: 1 }),
        React.createElement('path', { d: 'M6 14h4M8 11.5V14', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
      ]);
    }
    function IconTerminal() {
      return Svg(null, [
        React.createElement('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5, stroke: 'currentColor', strokeWidth: 1 }),
        React.createElement('path', { d: 'M4.5 6l2 2-2 2M8 10.5h3.5', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }
    function IconLog() {
      return Svg(null, [
        React.createElement('path', { d: 'M3 2.5h8.5L14 5v8.5H3z', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round' }),
        React.createElement('path', { d: 'M5.5 6.5h5M5.5 9h5M5.5 11.5h3', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
      ]);
    }
    function IconWarn() {
      return Svg({ size: 14 }, [
        React.createElement('path', { d: 'M8 2L14.5 13.5h-13L8 2z', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round' }),
        React.createElement('path', { d: 'M8 6.5v3.2', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
        React.createElement('circle', { cx: 8, cy: 11.6, r: .6, fill: 'currentColor' }),
      ]);
    }
    function IconClock() {
      return Svg({ size: 12 }, [
        React.createElement('circle', { cx: 8, cy: 8, r: 5.75, stroke: 'currentColor', strokeWidth: 1 }),
        React.createElement('path', { d: 'M8 5v3.2l2.2 1.3', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }
    function IconToolchain() {
      return Svg(null, [
        React.createElement('path', { d: 'M9.5 5.5L13 2M6.5 6.5l-4 4a1.8 1.8 0 1 0 2.6 2.6l4-4', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
        React.createElement('path', { d: 'M10.2 1.2l4.6 4.6-1.2 1.2-4.6-4.6z', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round' }),
      ]);
    }
    function IconCopy() {
      return Svg({ size: 14 }, [
        React.createElement('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5, stroke: 'currentColor', strokeWidth: 1 }),
        React.createElement('path', { d: 'M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2', stroke: 'currentColor', strokeWidth: 1 }),
      ]);
    }
    function IconSave() {
      return Svg({ size: 14 }, [
        React.createElement('path', { d: 'M8 2v8M5 7.5L8 10.5l3-3', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        React.createElement('path', { d: 'M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11', stroke: 'currentColor', strokeWidth: 1 }),
      ]);
    }
    function IconAI() {
      // four-point sparkle — the platform's AI marker
      return Svg({ size: 14 }, [
        React.createElement('path', {
          d: 'M8 1.5c.6 3.2 2.3 4.9 5.5 5.5-3.2.6-4.9 2.3-5.5 5.5C7.4 9.3 5.7 7.6 2.5 7 5.7 6.4 7.4 4.7 8 1.5Z',
          stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round',
        }),
      ]);
    }
    function IconCheck() {
      return Svg({ size: 14 }, [
        React.createElement('path', { d: 'M3 8.5l3.2 3.2L13 5', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }

    // Guide artwork: keep the DevEco CLI icon (assets/devecocli-icon.png,
    // served by the host at /api2/hdc-panel/icon.png), sized to the capsule.
    function GuideArtworkPhone(props) {
      var size = (props && props.size) || 36;
      var className = props && props.className;
      return React.createElement('img', {
        src: '/api2/hdc-panel/icon.png',
        width: size,
        height: size,
        alt: '',
        className: className,
        draggable: false,
        style: { width: size, height: size, borderRadius: Math.round(size * 0.22), objectFit: 'cover', display: 'block' },
      });
    }

    // ---- data hook: poll the host REST state (open = fast, closed = slow) ----
    function usePanelData(open) {
      var state = React.useState(loadCachedState);
      var setState = state[1];
      var hydrated = React.useRef(!!state[0]);
      var errPair = React.useState('');
      var err = errPair[0];
      var setErr = errPair[1];
      var shotPair = React.useState(false);
      var shotBusy = shotPair[0];
      var setShotBusy = shotPair[1];
      var busyPair = React.useState(false);
      var refreshBusy = busyPair[0];
      var setRefreshBusy = busyPair[1];
      var devCount = state[0] && state[0].devices ? state[0].devices.length : 0;
      React.useEffect(function () {
        var dead = false;
        function poll() {
          fetch('/api2/hdc-panel/panel-state')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (s) {
              if (dead) return;
              setErr(''); setState(s); hydrated.current = true;
              // Cache only healthy states: an error/empty snapshot must not
              // become the next mount's starting view.
              if (s && s.ok !== false) saveCachedState(s);
            })
            .catch(function (e) { if (!dead) setErr(String(e && e.message ? e.message : e)); });
        }
        poll();
        var interval = open ? (devCount > 0 ? POLL_FAST : POLL_SLOW) : POLL_CLOSED;
        var t = setInterval(poll, interval);
        return function () { dead = true; clearInterval(t); };
      }, [open, devCount]);
      function refresh(shot, target) {
        if (shot) setShotBusy(true);
        setRefreshBusy(true);
        fetch('/api2/hdc-panel/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shot: !!shot, target: target || '' }) })
          .then(function (r) { return r.json(); })
          .then(function (s) { setErr(''); setState(s); })
          .catch(function (e) { setErr(String(e && e.message ? e.message : e)); })
          .finally(function () { setShotBusy(false); setRefreshBusy(false); });
      }
      function select(id) {
        fetch('/api2/hdc-panel/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: id }) })
          .then(function (r) { return r.json(); })
          .then(function (s) { setErr(''); setState(s); })
          .catch(function () { /* next poll heals */ });
      }
      return { state: state[0], err: err, shotBusy: shotBusy, refreshBusy: refreshBusy, refresh: refresh, select: select };
    }

    // ---- tags: official Tag capsule, palette via data-tone ----
    function Tag(props) {
      return React.createElement('span', { className: 'hdcp-tag', 'data-tone': props.tone || undefined, title: props.title }, props.children);
    }

    // ---- screenshot clipboard / save helpers ----
    // The host serves captures as JPEG over /api2/hdc-panel/screenshot.jpeg;
    // fetch it as a blob, then either write it to the OS image clipboard
    // (ClipboardItem PNG promise, supported in the Electron renderer) or hand
    // it to the browser's download path.
    function fetchShotBlob(url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      });
    }
    // Chromium's ClipboardItem only reliably accepts image/png; captures are
    // JPEG, so decode → repaint on a canvas → encode PNG before writing.
    function blobToPng(blob) {
      if (blob.type === 'image/png') return Promise.resolve(blob);
      return new Promise(function (resolve, reject) {
        var img = new Image();
        var objURL = URL.createObjectURL(blob);
        img.onload = function () {
          try {
            var c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            c.toBlob(function (png) {
              URL.revokeObjectURL(objURL);
              if (png) resolve(png); else reject(new Error('PNG 编码失败'));
            }, 'image/png');
          } catch (e) { URL.revokeObjectURL(objURL); reject(e); }
        };
        img.onerror = function () { URL.revokeObjectURL(objURL); reject(new Error('图片解码失败')); };
        img.src = objURL;
      });
    }
    function copyImageToClipboard(url) {
      return fetchShotBlob(url).then(function (blob) {
        if (!blob || blob.type.indexOf('image/') !== 0) throw new Error('非图片内容');
        if (typeof ClipboardItem !== 'function' || !navigator.clipboard || !navigator.clipboard.write) {
          throw new Error('当前环境不支持图片剪贴板');
        }
        return blobToPng(blob).then(function (png) {
          var item = new ClipboardItem({ 'image/png': png });
          return navigator.clipboard.write([item]);
        });
      });
    }
    function saveImageAs(url) {
      return fetchShotBlob(url).then(function (blob) {
        var objURL = URL.createObjectURL(blob);
        var a = document.createElement('a');
        var stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        a.href = objURL;
        a.download = 'hdc-shot-' + stamp + '.' + (blob.type === 'image/png' ? 'png' : 'jpg');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(objURL); }, 4000);
      });
    }

    // ---- 发送到AI: stage the capture as a composer draft attachment ----
    // Walks the platform's own intake (ConversationController.createDrafts +
    // SessionInputShell.addAttachments), so the image lands in the chat input
    // as an official attachment chip — identical to dragging the file onto the
    // composer. Auto-submits only when asked for (empty draft + plain phase).
    // sessionId comes from the session-scoped tab props (the pane-tab slot
    // dispatches with the active session bound).
    function sendShotToAI(url, sessionId, autoSubmit) {
      var conversation = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('conversation') : null;
      var sessions = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('sessions') : null;
      if (!conversation || !sessions) throw new Error('会话服务不可用');
      if (!sessionId) throw new Error('没有打开的会话');
      var binding = sessions.binding(sessionId);
      if (!binding) throw new Error('会话未就绪');
      return fetchShotBlob(url).then(function (blob) {
        if (!blob || blob.type.indexOf('image/') !== 0) throw new Error('非图片内容');
        var ext = blob.type === 'image/png' ? 'png' : 'jpg';
        var stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        var file;
        try { file = new File([blob], 'hdc-shot-' + stamp + '.' + ext, { type: blob.type }); }
        catch (_) {
          file = blob; // some builds accept a plain Blob too
          try { if (!file.name) Object.defineProperty(file, 'name', { value: 'hdc-shot-' + stamp + '.' + ext }); } catch (_e) {}
        }
        var drafts = conversation.createDrafts(sessionId, [file]);
        if (!drafts || !drafts.length) throw new Error('创建附件草稿失败');
        var shell = conversation.input && conversation.input.shell
          ? conversation.input.shell(sessionId)
          : null;
        if (!shell) throw new Error('输入框不可用');
        var ok = shell.addAttachments(drafts.map(function (d) { return d.id; }));
        if (!ok) throw new Error('输入框正在处理中，请稍后再试');
        if (autoSubmit) shell.submit('queue');
        return true;
      });
    }

    // ---- context menu for the screenshot (copy / save) ----
    // The toast lives in PanelBody (passed via onNotify) so it survives this
    // menu unmounting itself right after a click.
    function ShotMenu(props) {
      var x = props.x, y = props.y, url = props.url;
      var close = props.onClose;
      var notify = props.onNotify || function () {};
      var sessionId = props.sessionId;
      React.useEffect(function () {
        function onDoc(e) { if (!e.target || !e.target.closest || !e.target.closest('.hdcp-ctx')) close(); }
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey);
        return function () {
          document.removeEventListener('mousedown', onDoc, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [close]);
      function run(fn, okMsg) {
        return function () {
          close();
          Promise.resolve().then(function () { return fn(); })
            .then(function () { notify(okMsg); })
            .catch(function (e) { notify('失败：' + (e && e.message ? e.message : e)); });
        };
      }
      var canSend = typeof sessionId === 'string' && sessionId !== '';
      var style = {
        left: Math.min(x, (window.innerWidth || 1200) - 150),
        top: Math.min(y, (window.innerHeight || 800) - 130),
      };
      return React.createElement('div', { className: 'hdcp-ctx', style: style, role: 'menu' },
        canSend ? React.createElement('button', {
          className: 'hdcp-ctx-item', role: 'menuitem',
          onClick: run(function () { return sendShotToAI(url, sessionId, false); }, '已添加到聊天输入框'),
        },
          React.createElement(IconAI), '发送到AI') : null,
        canSend ? React.createElement('div', { className: 'hdcp-ctx-sep' }) : null,
        React.createElement('button', { className: 'hdcp-ctx-item', role: 'menuitem', onClick: run(function () { return copyImageToClipboard(url); }, '已复制到剪贴板') },
          React.createElement(IconCopy), '复制图片'),
        React.createElement('div', { className: 'hdcp-ctx-sep' }),
        React.createElement('button', { className: 'hdcp-ctx-item', role: 'menuitem', onClick: run(function () { return saveImageAs(url); }, '已开始保存') },
          React.createElement(IconSave), '另存为…')
      );
    }

    // ---- lightbox: full-size screenshot viewer, click anywhere to dismiss ----
    function Lightbox(props) {
      var close = props.onClose;
      React.useEffect(function () {
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);
        return function () { document.removeEventListener('keydown', onKey); };
      }, [close]);
      return React.createElement('div', {
        className: 'hdcp-lightbox',
        onClick: close,
        onContextMenu: props.onContextMenu,
        role: 'dialog', 'aria-label': '截图查看',
      },
        React.createElement('img', {
          src: props.url,
          alt: '设备截图',
          draggable: false,
          onContextMenu: props.onContextMenu,
          onClick: function (e) { e.stopPropagation(); },
        }),
        React.createElement('button', {
          className: 'hdcp-lightbox-close',
          onClick: close, title: '关闭', 'aria-label': '关闭',
        }, React.createElement(IconClose))
      );
    }

    // ---- section: labeled block with an icon, the page's rhythm unit ----
    function Section(props) {
      return React.createElement('div', { className: 'hdcp-section' },
        props.title ? React.createElement('div', { className: 'hdcp-section-head' },
          props.icon,
          React.createElement('span', null, props.title)
        ) : null,
        props.children
      );
    }

    // ---- panel body (shared by the sidebar tab and the floating fallback) ----
    function PanelBody(props) {
      var data = props.data;
      var floating = !!props.floating;
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      var s = data.state || {};
      var shotPair = React.useState(false);
      var shotHidden = shotPair[0];
      var setShotHidden = shotPair[1];
      var zoomPair = React.useState(false);
      var zoomed = zoomPair[0];
      var setZoomed = zoomPair[1];
      var menuPair = React.useState(null);
      var shotMenu = menuPair[0];
      var setShotMenu = menuPair[1];
      var toastPair = React.useState('');
      var toast = toastPair[0];
      var setToast = toastPair[1];
      var toastTimer = React.useRef(null);
      function notify(msg) {
        setToast(msg);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(function () { setToast(''); }, 2000);
      }
      function openShotMenu(url) {
        return function (e) {
          e.preventDefault();
          e.stopPropagation();
          setShotMenu({ url: url, x: e.clientX, y: e.clientY });
        };
      }

      function onDevClick(e) {
        var shotEl = e.target && e.target.closest ? e.target.closest('.hdcp-dev-shot') : null;
        if (shotEl) {
          var shotId = shotEl.getAttribute('data-shot');
          if (shotId) { setShotHidden(false); data.refresh(true, shotId); }
          return;
        }
        var row = e.target && e.target.closest ? e.target.closest('.hdcp-dev') : null;
        if (!row) return;
        var id = row.getAttribute('data-id');
        if (id) data.select(id);
      }

      var pref = s.preferred || (s.devices && s.devices[0] && s.devices[0].id) || '';
      var devList = (s.devices || []).slice().sort(function (a, b) {
        if (a.id === s.preferred) return -1;
        if (b.id === s.preferred) return 1;
        return 0;
      });

      var tc = s.toolchain || {};
      var toolTags = [];
      if (s.version) toolTags.push(React.createElement(Tag, { key: 'v' }, 'CLI v' + s.version));
      if (tc.studio) toolTags.push(React.createElement(Tag, { key: 'studio' }, 'Studio ' + tc.studio));
      if (tc.sdk) toolTags.push(React.createElement(Tag, { key: 'sdk' }, 'SDK API ' + tc.sdk));
      toolTags.push(React.createElement(Tag, {
        key: 'devecocli',
        tone: tc.devecocli ? 'ok' : 'warn',
        title: !tc.devecocli && tc.devecocliError ? String(tc.devecocliError) : undefined,
      }, tc.devecocli ? 'devecocli 可用' : 'devecocli 缺失'));
      if (tc.knowledge) toolTags.push(React.createElement(Tag, { key: 'kb', tone: 'outline' }, '离线知识 ' + tc.knowledge + ' 篇'));

      var sys = s.system || {};
      var kv = [];
      if (sys.mem && sys.mem.availMB) kv.push(React.createElement('span', { key: 'mem' }, React.createElement(IconMemory), '内存可用 ' + sys.mem.availMB + '/' + (sys.mem.totalMB || '?') + ' MB'));
      if (sys.storage) kv.push(React.createElement('span', { key: 'sto' }, React.createElement(IconStorage), '存储已用 ' + sys.storage.usePct));
      if (sys.display) kv.push(React.createElement('span', { key: 'disp' }, React.createElement(IconDisplay), '分辨率 ' + sys.display.w + '×' + sys.display.h));
      var prefDev = s.devices && s.devices.length ? (s.devices.find(function (x) { return x.id === pref; }) || s.devices[0]) : null;
      var osVer = (prefDev && prefDev.softwareVersion) || '';
      if (osVer) kv.push(React.createElement('span', { key: 'os' }, React.createElement(IconChip), 'OS ' + osVer));

      var shot = s.screenshot && s.screenshot.available && !shotHidden ? s.screenshot : null;
      var logLines = s.hilog && s.hilog.available && s.hilog.lines ? s.hilog.lines : [];

      // Toolbar: platform tab chrome — icon button group + centered title.
      var dotState = data.err ? 'warning' : (s.devices && s.devices.length ? 'done' : 'error');
      var head = React.createElement('div', { className: 'hdcp-toolbar' },
        React.createElement('span', { className: 'hdcp-dot', 'data-state': dotState, title: data.err ? data.err : (s.devices && s.devices.length ? '设备已连接' : '无设备') }),
        React.createElement('img', { src: '/api2/hdc-panel/icon.png', alt: '', draggable: false }),
        React.createElement('span', { className: 'hdcp-title' },
          '鸿蒙开发面板',
          s.hdc ? React.createElement('span', { className: 'hdcp-sub' }, s.hdc) : null
        ),
        React.createElement('button', {
          className: 'hdcp-tool', title: '截取当前设备屏幕', 'aria-label': '截取当前设备屏幕',
          disabled: data.shotBusy,
          onClick: function () { setShotHidden(false); data.refresh(true, ''); },
        }, data.shotBusy ? React.createElement(IconRefresh) : React.createElement(IconCamera)),
        React.createElement('button', {
          className: 'hdcp-tool', title: '刷新设备与状态', 'aria-label': '刷新设备与状态',
          disabled: data.refreshBusy,
          onClick: function () { data.refresh(false, ''); },
        }, React.createElement('span', { className: 'hdcp-spin-slot' + (data.refreshBusy ? ' busy' : '') }, React.createElement(IconRefresh)))
      );
      if (floating) {
        head = React.cloneElement(head, null,
          head.props.children.concat(React.createElement('button', { key: 'close', className: 'hdcp-tool', onClick: props.onClose, title: '关闭', 'aria-label': '关闭' }, React.createElement(IconClose)))
        );
      }

      var bodyKids = [];
      if (s.devices && s.devices.length) {
        // Devices section
        var devRows = devList.map(function (d) {
          var isPref = s.preferred === d.id;
          var sub = [];
          if (d.model) sub.push(React.createElement(Tag, { key: 'm' }, d.model));
          if (d.apiVersion) sub.push(React.createElement(Tag, { key: 'api', tone: 'outline' }, 'API ' + d.apiVersion));
          if (d.battery) {
            var b = d.battery;
            sub.push(React.createElement(Tag, { key: 'bat', tone: b.capacity <= 20 ? 'warn' : 'outline' }, React.createElement(IconBattery), b.capacity + '%'));
            if (b.charging) sub.push(React.createElement(Tag, { key: 'chg', tone: 'ok' }, '充电中'));
            if (b.temperature !== null && b.temperature !== undefined) sub.push(React.createElement(Tag, { key: 'temp', tone: 'outline' }, React.createElement(IconThermo), b.temperature + '°C'));
          }
          if (isPref) sub.push(React.createElement(Tag, { key: 'pref', tone: 'accent' }, '默认'));
          return React.createElement('div', {
            key: d.id,
            className: 'hdcp-dev',
            'data-id': d.id,
            'data-selected': isPref ? 'true' : 'false',
            title: '点击设为默认设备',
            role: 'button', tabIndex: 0,
            onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); data.select(d.id); } },
          },
            React.createElement('span', { className: 'hdcp-dev-state hdcp-dot' + (/connected/i.test(d.state) ? ' on' : ''), 'data-state': /connected/i.test(d.state) ? 'done' : 'idle' }),
            React.createElement('div', { className: 'hdcp-dev-main' },
              React.createElement('div', { className: 'hdcp-dev-name' },
                React.createElement('span', null, d.name || d.model || d.id),
                React.createElement('span', { className: 'hdcp-dev-id' }, d.id)
              ),
              React.createElement('div', { className: 'hdcp-dev-sub' }, sub)
            ),
            React.createElement('button', { className: 'hdcp-tool hdcp-dev-shot', 'data-shot': d.id, title: '截取此设备屏幕', 'aria-label': '截取此设备屏幕' }, React.createElement(IconCamera))
          );
        });
        bodyKids.push(React.createElement('div', { className: 'hdcp-section', onClick: onDevClick, onKeyDown: undefined },
          React.createElement('div', { className: 'hdcp-section-head' }, React.createElement(IconPhone), React.createElement('span', null, '设备 ' + devList.length)),
          React.createElement('div', null, devRows)
        ));
        // System section
        if (kv.length) bodyKids.push(React.createElement(Section, { key: 'sys', title: '系统信息', icon: React.createElement(IconChip) },
          React.createElement('div', { className: 'hdcp-sys' }, kv)
        ));
        // Screenshot: inline thumbnail; click opens the full-size lightbox.
        if (shot) bodyKids.push(React.createElement(Section, { key: 'shot', title: '截图 · ' + shot.target, icon: React.createElement(IconCamera) },
          React.createElement('div', { className: 'hdcp-shot' },
            React.createElement('div', {
              className: 'hdcp-shot-stage',
              onClick: function () { setZoomed(true); },
              onContextMenu: openShotMenu(shot.url),
              title: '点击查看原图，右键复制或保存',
            }, React.createElement('img', { src: shot.url, alt: '设备截图', draggable: false, onContextMenu: openShotMenu(shot.url) }))
          )
        ));
        // hilog
        if (logLines.length) bodyKids.push(React.createElement(Section, { key: 'log', title: 'hilog', icon: React.createElement(IconTerminal) },
          React.createElement('pre', { className: 'hdcp-pre' }, logLines.join(NL))
        ));
        bodyKids.push(React.createElement('div', { key: 'foot', className: 'hdcp-section' },
          React.createElement('div', { className: 'hdcp-foot' }, React.createElement(IconClock), '更新于 ' + fmtTime(s.updatedAt || Date.now()))
        ));
      } else {
        bodyKids.push(React.createElement('div', { className: 'hdcp-empty' },
          React.createElement(IconPhoneArtwork),
          React.createElement('div', null, s.error || data.err || '无已连接设备'),
          React.createElement('div', { style: { fontSize: 11 } }, '连接指引：hdc_connect 127.0.0.1:5555')
        ));
      }
      if (s.lastError || data.err) bodyKids.push(React.createElement('div', { className: 'hdcp-err' }, React.createElement(IconWarn), React.createElement('span', null, s.lastError || data.err || '')));

      return React.createElement('div', { className: 'hdcp-root' + (floating ? ' hdcp-float' : '') },
        head,
        React.createElement('div', { className: 'hdcp-body' },
          React.createElement('div', { className: 'hdcp-section', style: { borderBottom: 'none' } },
            React.createElement('div', { className: 'hdcp-section-head' }, React.createElement(IconToolchain), React.createElement('span', null, '本地工具链')),
            React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, toolTags)
          ),
          bodyKids
        ),
        zoomed && shot ? React.createElement(Lightbox, { url: shot.url, onClose: function () { setZoomed(false); }, onContextMenu: openShotMenu(shot.url) }) : null,
        shotMenu ? React.createElement(ShotMenu, { url: shotMenu.url, x: shotMenu.x, y: shotMenu.y, sessionId: sessionId, onNotify: notify, onClose: function () { setShotMenu(null); } }) : null,
        toast ? React.createElement('div', { className: 'hdcp-toast' }, React.createElement(IconCheck), ' ' + toast) : null
      );
    }

    // ---- sidebar tab body: registered under the keyed pane-tab seat ----
    // The pane-tab seat is session-scoped; the owner dispatches standardProps
    // including sessionId (active session) — forward it for 发送到AI.
    function SidebarTabBody(props) {
      var data = usePanelData(true);
      // Open-state memory: a mount means this tab is the active sidebar tab;
      // remember it so a page reload reopens the panel instead of dropping
      // back to the Start page. Cleared on unmount (user switched away or
      // closed the tab) so reload respects the last visible state.
      React.useEffect(function () {
        try { localStorage.setItem(LS_OPEN_KEY, '1'); } catch (e) { /* storage unavailable */ }
        return function () {
          try { localStorage.removeItem(LS_OPEN_KEY); } catch (e) { /* ignore */ }
        };
      }, []);
      return React.createElement(PanelBody, { data: data, floating: false, sessionId: props && props.sessionId });
    }

    var inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];
    function apply(ctx) {
      try { __hdcApply(ctx); }
      catch (e) { __hdcReport('apply', e); throw e; }
    }
    function __hdcApply(ctx) {
      rootCtx = ctx; // for sendShotToAI service lookups (ctx.get('conversation'))
      injectStyles();

      // Official tab-type registration: Start-page (guide) entry + panel body
      // + tab title, following the ui-sidebar-browser shape.
      var hasTabs = ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function';
      if (hasTabs) {
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: PLUGIN_ID,
            kind: TAB_KIND,
            multiple: false,
            priority: 'extension',
            title: function () { return '鸿蒙开发面板'; },
            guide: [{
              id: 'new',
              commandId: 'hdcPanel.open',
              order: 40,
              title: function () { return '鸿蒙开发面板'; },
              description: function () { return '设备调试 · 截图 · hilog'; },
              icon: GuideArtworkPhone,
            }],
          });
        }, 'hdc-panel: tab type');
        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: PLUGIN_ID },
              SidebarTabBody
            );
          });
        }, 'hdc-panel: tab panel');
        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
            return ctx.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: PLUGIN_ID },
              // Icon + label, same shape as the platform's own plan tab title
              // (title slots render full React nodes, icon included).
              function () {
                return React.createElement(React.Fragment, null,
                  React.createElement('img', {
                    src: '/api2/hdc-panel/icon.png',
                    width: 16,
                    height: 16,
                    alt: '',
                    draggable: false,
                    style: { width: 16, height: 16, borderRadius: 4, objectFit: 'cover', display: 'inline-block', verticalAlign: '-3px', marginRight: 6 },
                  }),
                  '鸿蒙开发面板'
                );
              }
            );
          });
        }, 'hdc-panel: tab title');

        // Restore-on-reload: if the panel tab was open when the page last
        // went away, reopen it once this plugin's tab type is registered.
        // The tab system may not have applied the register effects yet, so
        // retry briefly instead of a single tick; the marker is only consumed
        // by the mounted body (re-set on mount, cleared on unmount), so a
        // failed restore keeps it until the next reload.
        try {
          if (localStorage.getItem(LS_OPEN_KEY) === '1' &&
              ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function') {
            var tries = 0;
            var attempt = function () {
              try {
                ctx.sidebarRight.openTab(TAB_KIND, {});
                return; // success: the mounted body re-arms the marker
              } catch (e) { /* not ready yet */ }
              if (++tries < 20) setTimeout(attempt, 250);
            };
            setTimeout(attempt, 0);
          }
        } catch (e) { /* storage unavailable */ }
      }

      function openPanelTab() {
        if (hasTabs && ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function') {
          try { ctx.sidebarRight.openTab(TAB_KIND, {}); return; } catch (e) { /* fall through */ }
        }
      }
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
}
