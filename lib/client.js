// dsh-hdc-panel browser bundle — official client-plugin shape, registered as
// a right-sidebar tab type with a Start-page (guide) entry, modeled on the
// platform's own sidebar plugins (ui-sidebar-browser, ui-sidebar-files):
//   * entry: a guide card on the Start page via ctx.sidebarRightTabs.register
//     (kind 'hdcPanel'); picking it calls openTab(kind, { replaceTab: true })
//     so the Start page gives way to the panel tab
//   * surface: the panel body registered under the keyed
//     'sidebar.right.pane.tab' seat — a normal in-sidebar page, no portal
//   * status: the old sidebar-foot button stays as a status entry (status dot
//     + device-count badge); clicking it opens the same tab
//   * fallback: when sidebarRightTabs/sidebarRight are unavailable, the foot
//     entry keeps the legacy floating-portal panel behavior
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
    var POLL_FAST = 8000;
    var POLL_SLOW = 20000;
    var POLL_CLOSED = 60000;

    var CSS = [
      // ---- sidebar footer status entry (rail = icon, wide = icon + label) ----
      '.hdcp-entry{position:relative;width:36px;height:36px;flex:none;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--dsw-alias-label-secondary,#9ba0ab);cursor:pointer;background:transparent;border:none;border-radius:50%;padding:0;transition:background-color .12s,color .12s,box-shadow .12s;}',
      '.hdcp-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e9e9ef);}',
      '.hdcp-entry[data-wide]{width:auto;padding:0 10px;border-radius:8px;}',
      '.hdcp-entry-dot{position:absolute;top:2px;right:2px;width:8px;height:8px;border-radius:50%;border:2px solid var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#f9fafb));background:var(--dsw-alias-label-quaternary,#8a8f99);}',
      '.hdcp-dot-ok{background:var(--dsw-alias-state-success-primary,#34c759);}',
      '.hdcp-dot-err{background:var(--dsw-alias-state-error-primary,#ff5252);}',
      '.hdcp-dot-warn{background:var(--dsw-alias-state-warn-primary,#ffb020);}',
      '.hdcp-entry-label{font:12px/1 system-ui,-apple-system,Segoe UI,sans-serif;}',
      '.hdcp-entry-count{min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-brand-primary,#3d7bfd);color:var(--dsw-alias-label-primary-inverted,#fff);font:10px/16px system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;}',
      '.hdcp-entry:not([data-wide]) .hdcp-entry-count{position:absolute;bottom:-3px;right:-3px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;font:9px/14px system-ui,-apple-system,Segoe UI,sans-serif;}',
      '.hdcp-entry-host{display:flex;justify-content:center;align-items:center;width:auto;margin-left:6px;}',
      '.hdcp-footer-stack{flex-direction:column;align-items:center;}',
      '.hdcp-footer-stack .hdcp-entry-host{width:100%;margin-left:0;}',
      // ---- in-sidebar panel surface (official tab body) ----
      '.hdcp-root{display:flex;flex-direction:column;height:100%;min-height:0;font:12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--dsw-alias-label-primary,#e9e9ef);}',
      '.hdcp-card{background:var(--dsw-alias-bg-layer-3,#23252c);border:1px solid var(--dsw-alias-border-l2,#3a3d46);border-radius:12px;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden;margin:8px;}',
      '.hdcp-head{display:flex;align-items:center;gap:8px;padding:8px 10px;flex:0 0 auto;flex-wrap:wrap;}',
      '.hdcp-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-quaternary,#8a8f99);}',
      '.hdcp-title{font-weight:600;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}',
      '.hdcp-btn{background:transparent;border:1px solid var(--dsw-alias-border-l2,#3a3d46);border-radius:6px;color:inherit;padding:2px 8px;font:inherit;cursor:pointer;flex:0 0 auto;}',
      '.hdcp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#2c2e37);}',
      '.hdcp-btn:disabled{opacity:.5;cursor:default;}',
      '.hdcp-tools{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l2,#3a3d46);flex:0 0 auto;}',
      '.hdcp-tools-label{color:var(--dsw-alias-label-tertiary,#9ba0ab);font-size:11px;margin-right:2px;}',
      '.hdcp-tool-badge{background:var(--dsw-alias-fill-tsp-secondary,rgba(255,255,255,.08));color:var(--dsw-alias-state-business-primary,#8fb3f5);border-radius:4px;padding:1px 7px;font-size:11px;}',
      '.hdcp-body{padding:10px;border-top:1px solid var(--dsw-alias-border-l2,#3a3d46);flex:1 1 auto;display:flex;flex-direction:column;min-height:0;overflow:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);}',
      '.hdcp-hint{color:var(--dsw-alias-label-tertiary,#9ba0ab);margin:2px 0 6px;}',
      '.hdcp-dev{padding:5px 4px;border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.06));display:flex;align-items:flex-start;gap:6px;cursor:pointer;border-radius:4px;}',
      '.hdcp-dev:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05));}',
      '.hdcp-dev-pref{background:var(--dsw-alias-fill-tsp-secondary,rgba(90,150,255,.10));}',
      '.hdcp-dev-main{flex:1 1 auto;min-width:0;}',
      '.hdcp-dev-state{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-quaternary,#8a8f99);margin-top:4px;}',
      '.hdcp-dev-state.on{background:var(--dsw-alias-state-success-primary,#34c759);}',
      '.hdcp-dev-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.hdcp-dev-id{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-quaternary,#9ba0ab);font-size:11px;}',
      '.hdcp-dev-sub{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;}',
      '.hdcp-dev-shot{flex:0 0 auto;background:transparent;border:1px solid var(--dsw-alias-border-l2,#3a3d46);border-radius:6px;color:inherit;padding:2px 7px;font:inherit;font-size:11px;cursor:pointer;margin-top:1px;}',
      '.hdcp-dev-shot:hover{background:var(--dsw-alias-interactive-bg-hover,#2c2e37);}',
      '.hdcp-badge{background:var(--dsw-alias-fill-tsp-secondary,rgba(90,150,255,.16));color:var(--dsw-alias-state-business-primary,#7aa7ff);border-radius:4px;padding:0 6px;font-size:11px;}',
      '.hdcp-badge-pref{background:var(--dsw-alias-state-success-secondary,rgba(52,199,89,.20));color:var(--dsw-alias-label-primary,#e9e9ef);}',
      '.hdcp-sys{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin:8px 0;padding:6px 8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.03));border-radius:6px;color:var(--dsw-alias-label-secondary,#9ba0ab);font-size:11px;}',
      '.hdcp-shot{margin-top:8px;position:relative;}',
      '.hdcp-shot img{max-width:100%;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#3a3d46);display:block;}',
      '.hdcp-shot-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#9ba0ab);margin-bottom:2px;}',
      '.hdcp-shot-close{position:absolute;top:4px;right:4px;width:22px;height:22px;border:none;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:14px;line-height:1;cursor:pointer;padding:0;}',
      '.hdcp-shot-close:hover{background:rgba(0,0,0,.8);}',
      '.hdcp-pre{flex:0 0 auto;max-height:160px;overflow:auto;background:var(--dsw-alias-markdown-code-block,#16171c);padding:6px;border-radius:6px;font:10px/1.4 ui-monospace,Consolas,monospace;margin:8px 0 0;white-space:pre-wrap;word-break:break-all;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);}',
      '.hdcp-foot{color:var(--dsw-alias-label-tertiary,#9ba0ab);margin-top:6px;}',
      '.hdcp-err{color:var(--dsw-alias-state-error-primary,#ff6b6b);margin-top:4px;}',
      // ---- legacy floating fallback surface (no sidebar tab API) ----
      '.hdcp-float{position:fixed;top:70px;right:16px;z-index:1000;width:330px;max-width:calc(100vw - 32px);pointer-events:auto;}',
      '.hdcp-float .hdcp-card{box-shadow:0 8px 24px rgba(0,0,0,.38);position:relative;max-height:calc(100vh - 100px);}',
      '.hdcp-btn:focus-visible,.hdcp-entry:focus-visible,.hdcp-dev-shot:focus-visible,.hdcp-shot-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3d7bfd);outline-offset:1px;}',
      '@media (prefers-reduced-motion:reduce){.hdcp-entry{transition:none;}}',
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

    function dotClass(state, err) {
      if (err) return 'hdcp-dot-warn';
      if (state && state.devices && state.devices.length) return 'hdcp-dot-ok';
      return 'hdcp-dot-err';
    }

    function fmtTime(ms) {
      var d = new Date(ms);
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    }

    function PhoneIcon() {
      return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('rect', { x: 3.5, y: 1, width: 9, height: 14, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
        React.createElement('line', { x1: 6, y1: 12.5, x2: 10, y2: 12.5, stroke: 'currentColor', strokeWidth: 1.2 })
      );
    }

    // Guide artwork: the DevEco CLI icon (assets/devecocli-icon.png) served
    // by the host at /api2/hdc-panel/icon.png, sized to the 36x36 capsule.
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
      var state = React.useState(null);
      var setState = state[1];
      var errPair = React.useState('');
      var err = errPair[0];
      var setErr = errPair[1];
      var shotPair = React.useState(false);
      var shotBusy = shotPair[0];
      var setShotBusy = shotPair[1];
      var devCount = state[0] && state[0].devices ? state[0].devices.length : 0;
      React.useEffect(function () {
        var dead = false;
        function poll() {
          fetch('/api2/hdc-panel/panel-state')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (s) { if (!dead) { setErr(''); setState(s); } })
            .catch(function (e) { if (!dead) setErr(String(e && e.message ? e.message : e)); });
        }
        poll();
        var interval = open ? (devCount > 0 ? POLL_FAST : POLL_SLOW) : POLL_CLOSED;
        var t = setInterval(poll, interval);
        return function () { dead = true; clearInterval(t); };
      }, [open, devCount]);
      function refresh(shot, target) {
        if (shot) setShotBusy(true);
        fetch('/api2/hdc-panel/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shot: !!shot, target: target || '' }) })
          .then(function (r) { return r.json(); })
          .then(function (s) { setErr(''); setState(s); })
          .catch(function (e) { setErr(String(e && e.message ? e.message : e)); })
          .finally(function () { setShotBusy(false); });
      }
      function select(id) {
        fetch('/api2/hdc-panel/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: id }) })
          .then(function (r) { return r.json(); })
          .then(function (s) { setErr(''); setState(s); })
          .catch(function () { /* next poll heals */ });
      }
      return { state: state[0], err: err, shotBusy: shotBusy, refresh: refresh, select: select };
    }

    // ---- panel body (shared by the sidebar tab and the floating fallback) ----
    function PanelBody(props) {
      var data = props.data;
      var floating = !!props.floating;
      var s = data.state || {};
      var shotPair = React.useState(false);
      var shotHidden = shotPair[0];
      var setShotHidden = shotPair[1];

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

      var title = '鸿蒙开发面板';
      if (s.hdc) title += ' · ' + s.hdc;

      var tc = s.toolchain || {};
      var badges = [];
      if (s.version) badges.push('<span class="hdcp-tool-badge">v' + s.version + '</span>');
      if (tc.studio) badges.push('<span class="hdcp-tool-badge">Studio ' + tc.studio + '</span>');
      if (tc.sdk) badges.push('<span class="hdcp-tool-badge">SDK API ' + tc.sdk + '</span>');
      // 无会话的面板探测可能失败而工具层正常（issue #9 跟进）：把原因挂到徽章提示上
      var devcliAttr = '';
      if (!tc.devecocli && tc.devecocliError) {
        devcliAttr = ' title="' + String(tc.devecocliError).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '"';
      }
      badges.push('<span class="hdcp-tool-badge"' + devcliAttr + '>devecocli ' + (tc.devecocli ? '有' : '无') + '</span>');
      if (tc.knowledge) badges.push('<span class="hdcp-tool-badge">离线知识 ' + tc.knowledge + ' 篇</span>');

      var pref = s.preferred || (s.devices && s.devices[0] && s.devices[0].id) || '';
      var devList = (s.devices || []).slice().sort(function (a, b) {
        if (a.id === s.preferred) return -1;
        if (b.id === s.preferred) return 1;
        return 0;
      });
      var rows = [];
      for (var i = 0; i < devList.length; i++) {
        var d = devList[i];
        var isPref = s.preferred === d.id;
        var subBadges = [];
        if (d.model) subBadges.push('<span class="hdcp-badge">' + d.model + '</span>');
        if (d.apiVersion) subBadges.push('<span class="hdcp-badge">API ' + d.apiVersion + '</span>');
        if (d.battery) {
          var b = d.battery;
          subBadges.push('<span class="hdcp-badge">电池 ' + b.capacity + '%</span>');
          if (b.charging) subBadges.push('<span class="hdcp-badge">充电中</span>');
          if (b.temperature !== null && b.temperature !== undefined) subBadges.push('<span class="hdcp-badge">' + b.temperature + '°C</span>');
        }
        var nameLine = (d.name || d.model || d.id) + ' <span class="hdcp-dev-id">' + d.id + '</span>' + (isPref ? ' <span class="hdcp-badge hdcp-badge-pref">默认</span>' : '');
        rows.push('<div class="hdcp-dev' + (isPref ? ' hdcp-dev-pref' : '') + '" data-id="' + d.id + '" title="点击设为默认设备"><span class="hdcp-dev-state' + (/connected/i.test(d.state) ? ' on' : '') + '"></span><button class="hdcp-dev-shot" data-shot="' + d.id + '" title="截此设备">截图</button><div class="hdcp-dev-main"><div class="hdcp-dev-name">' + nameLine + '</div><div class="hdcp-dev-sub">' + subBadges.join('') + '</div></div></div>');
      }

      var sys = s.system || {};
      var kv = [];
      if (sys.mem && sys.mem.availMB) kv.push('<span>内存可用 ' + sys.mem.availMB + '/' + (sys.mem.totalMB || '?') + ' MB</span>');
      if (sys.storage) kv.push('<span>存储已用 ' + sys.storage.usePct + '</span>');
      if (sys.display) kv.push('<span>分辨率 ' + sys.display.w + '×' + sys.display.h + '</span>');
      var osVer = (s.devices && s.devices.length && (s.devices.find(function (x) { return x.id === pref; }) || s.devices[0]).softwareVersion) || '';
      if (osVer) kv.push('<span>OS ' + osVer + '</span>');

      var shot = s.screenshot && s.screenshot.available && !shotHidden ? s.screenshot : null;
      var logLines = s.hilog && s.hilog.available && s.hilog.lines ? s.hilog.lines : [];

      var headKids = [
        React.createElement('span', { key: 'dot', className: 'hdcp-dot ' + dotClass(s, data.err) }),
        React.createElement('span', { key: 'title', className: 'hdcp-title' }, title),
        React.createElement('button', { key: 'shot', className: 'hdcp-btn', onClick: function () { setShotHidden(false); data.refresh(true, ''); }, disabled: data.shotBusy }, data.shotBusy ? '截图…' : '截图'),
        React.createElement('button', { key: 'refresh', className: 'hdcp-btn', onClick: function () { data.refresh(false, ''); }, disabled: data.shotBusy }, '刷新'),
      ];
      if (floating) headKids.push(React.createElement('button', { key: 'close', className: 'hdcp-btn', onClick: props.onClose, title: '关闭' }, '×'));
      var head = React.createElement.apply(React, ['div', { className: 'hdcp-head' }].concat(headKids));

      var bodyKids = [];
      if (s.devices && s.devices.length) {
        bodyKids.push(React.createElement('div', { className: 'hdcp-devices', onClick: onDevClick, dangerouslySetInnerHTML: { __html: rows.join('') } }));
        if (kv.length) bodyKids.push(React.createElement('div', { className: 'hdcp-sys', dangerouslySetInnerHTML: { __html: kv.join('') } }));
        if (shot) bodyKids.push(React.createElement('div', { className: 'hdcp-shot' },
          React.createElement('div', { className: 'hdcp-shot-label' }, '截图 @ ' + shot.target),
          React.createElement('img', { src: shot.url, alt: '设备截图' }),
          React.createElement('button', { className: 'hdcp-shot-close', onClick: function () { setShotHidden(true); }, title: '关闭截图' }, '×')
        ));
        if (logLines.length) bodyKids.push(React.createElement('pre', { className: 'hdcp-pre' }, logLines.join(NL)));
        bodyKids.push(React.createElement('div', { className: 'hdcp-foot' }, '更新 ' + fmtTime(s.updatedAt || Date.now())));
      } else {
        bodyKids.push(React.createElement('div', { className: 'hdcp-hint' }, s.error || data.err || '无已连接设备（含连接指引：hdc_connect 127.0.0.1:5555）'));
      }
      if (s.lastError || data.err) bodyKids.push(React.createElement('div', { className: 'hdcp-err' }, s.lastError || data.err || ''));

      return React.createElement('div', { className: 'hdcp-root' + (floating ? ' hdcp-float' : '') },
        React.createElement('div', { className: 'hdcp-card' },
          head,
          React.createElement('div', { className: 'hdcp-tools', dangerouslySetInnerHTML: { __html: '<span class="hdcp-tools-label">本地工具链</span>' + badges.join('') } }),
          React.createElement('div', { className: 'hdcp-body' }, bodyKids)
        )
      );
    }

    // ---- sidebar tab body: registered under the keyed pane-tab seat ----
    function SidebarTabBody() {
      var data = usePanelData(true);
      return React.createElement(PanelBody, { data: data, floating: false });
    }

    var inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];
    function apply(ctx) {
      try { __hdcApply(ctx); }
      catch (e) { __hdcReport('apply', e); throw e; }
    }
    function __hdcApply(ctx) {
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
        }, 'hdc-panel: tab body');
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
