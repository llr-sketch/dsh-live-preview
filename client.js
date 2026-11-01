/**
 * dsh-live-preview — client half (browser bundle).
 *
 * Hand-written ModuleLoader bundle: no build step, no JSX, no TypeScript.
 * Only `react` is required; everything else is plain DOM/fetch against the
 * same-origin host routes under `/live-preview/api/*`.
 *
 * What it registers:
 *   - `sidebar.panellist` icon `live-preview` (order 20) — the sidebar owns
 *     the row, its label and the panel selection, so the icon only draws the
 *     glyph from the `{ size, active }` props it is handed.
 *   - `main` keyed entry `live-preview` — the full-page panel. Selecting the
 *     sidebar row switches `main` to this key; the page never routes itself.
 *
 * Panel behaviour: live web iframe, Windows window capture, Android mirror,
 * run-command control and an incremental log tail. Polling, frame URLs and
 * AbortControllers are all torn down when the component unmounts or the tab
 * changes, and every object URL is revoked exactly once.
 */

window.__ModuleLoader__.load({
  id: "dsh-live-preview",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    var NS = "dsh-live-preview";
    var API = "/live-preview/api";
    var MAX_LOG_LINES = 3000;
    var STATE_INTERVAL_MS = 1000;
    var LOG_INTERVAL_MS = 600;
    var FRAME_INTERVAL_MS = 160;
    var FAST_STATE_INTERVAL_MS = 500;
    var TAP_SLOP_CSS_PX = 5;

    // //////////////////////////////////////////////////////////////////////
    // CSS — host design language: full-height column, compact header, 12px
    // cards, capsule buttons and inputs. Colours come only from the
    // --dsw-alias-* theme tokens so light/dark follow the host.
    // //////////////////////////////////////////////////////////////////////
    var CSS =
      ".__lp_root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}" +
      ".__lp_root *,.__lp_root *:before,.__lp_root *:after{box-sizing:border-box}" +
      ".__lp_head{flex:none;display:flex;align-items:center;gap:10px;min-height:48px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".__lp_glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}" +
      ".__lp_title{margin:0;font-size:15px;line-height:22px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".__lp_badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}" +
      ".__lp_dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}" +
      ".__lp_dot[data-tone=success]{background:var(--dsw-alias-state-success-primary)}" +
      ".__lp_dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}" +
      ".__lp_dot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}" +
      ".__lp_spacer{flex:1;min-width:8px}" +
      ".__lp_btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;text-decoration:none;cursor:pointer;-webkit-appearance:none}" +
      ".__lp_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
      ".__lp_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}" +
      ".__lp_btn:disabled{opacity:.45;cursor:default}" +
      ".__lp_btnPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}" +
      ".__lp_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}" +
      ".__lp_btnDanger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent)}" +
      ".__lp_btnDanger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}" +
      ".__lp_btnGhost{border-color:var(--dsw-alias-border-l2);background:transparent}" +
      ".__lp_headImport{flex:none;max-width:520px;min-width:0}" +
      ".__lp_hiddenInput{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}" +
      ".__lp_iconBtn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;-webkit-appearance:none}" +
      ".__lp_iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
      ".__lp_iconBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}" +
      ".__lp_iconBtn:disabled{opacity:.45;cursor:default}" +
      ".__lp_tabs{flex:none;display:flex;align-items:center;gap:4px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto}" +
      ".__lp_tab{box-sizing:border-box;flex:none;height:28px;padding:0 12px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap;-webkit-appearance:none}" +
      ".__lp_tab:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".__lp_tab[aria-selected=true]{background:color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}" +
      ".__lp_tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}" +
      ".__lp_body{flex:1;min-height:0;display:flex;flex-direction:column;padding:12px 16px;overflow:hidden}" +
      ".__lp_pane{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;overflow:hidden}" +
      ".__lp_paneScroll{overflow:auto}" +
      ".__lp_card{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}" +
      ".__lp_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}" +
      ".__lp_field{display:flex;align-items:center;gap:8px;flex:1;min-width:180px}" +
      ".__lp_label{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}" +
      ".__lp_input{box-sizing:border-box;flex:1;min-width:0;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}" +
      ".__lp_input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}" +
      ".__lp_input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}" +
      ".__lp_select{box-sizing:border-box;flex:1;min-width:0;max-width:100%;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}" +
      ".__lp_select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}" +
      ".__lp_hint{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__lp_hintWarn{color:var(--dsw-alias-state-warn-primary)}" +
      ".__lp_hintError{color:var(--dsw-alias-state-error-primary)}" +
      ".__lp_mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace);font-size:12px;line-height:18px}" +
      ".__lp_stage{position:relative;flex:1;min-height:120px;display:flex;align-items:center;justify-content:center;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__lp_stageScroll{overflow:auto;align-items:flex-start}" +
      ".__lp_previewBar{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}" +
      ".__lp_previewBarLabel{flex:none;margin-right:2px;color:var(--dsw-alias-label-secondary)}" +
      ".__lp_zoomBtn{box-sizing:border-box;height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}" +
      ".__lp_zoomBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".__lp_zoomOn{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
      ".__lp_splitter{flex:none;height:18px;margin:-3px 0;display:flex;align-items:center;justify-content:center;border-radius:9px;cursor:row-resize;touch-action:none;user-select:none;-webkit-user-select:none;background:transparent}" +
      ".__lp_splitter:hover,.__lp_splitter:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}" +
      ".__lp_splitterGrip{flex:none;width:44px;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2)}" +
      ".__lp_splitter:hover .__lp_splitterGrip,.__lp_splitter:focus-visible .__lp_splitterGrip{background:var(--dsw-alias-label-tertiary)}" +
      ".__lp_rightTab{height:100%;min-height:0;display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}" +
      ".__lp_rightHead{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".__lp_rightStage{position:relative;flex:1;min-height:180px;display:flex;align-items:center;justify-content:center;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__lp_rightBar{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:26px}" +
      ".__lp_import{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}" +
      ".__lp_importRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}" +
      ".__lp_importFile{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".__lp_importHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__lp_importErr{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}" +
      ".__lp_choice{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}" +
      ".__lp_choiceTitle{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".__lp_choiceDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".__lp_choiceRow{display:flex;gap:8px;flex-wrap:wrap}" +
      ".__lp_versionBtn{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:150px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-align:left}" +
      ".__lp_versionBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".__lp_versionBtnSub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}" +
      ".__lp_modalBackdrop{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:24px}" +
      ".__lp_modal{width:min(720px,92vw);max-height:80vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.4);overflow:hidden}" +
      ".__lp_modalHead{flex:none;display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".__lp_modalTitle{font-size:14px;line-height:22px;font-weight:600}" +
      ".__lp_modalBody{flex:1;min-height:0;overflow:auto;padding:10px 16px 16px}" +
      ".__lp_versionRow{display:flex;align-items:center;gap:10px;padding:10px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:8px;outline:none}" +
      ".__lp_versionRow:hover,.__lp_versionRow:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".__lp_versionGroup{display:flex;align-items:center;gap:8px;margin:14px 0 4px;padding:4px 2px;border-bottom:1px dashed var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".__lp_versionGroupTitle{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".__lp_versionMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}" +
      ".__lp_versionName{display:flex;align-items:center;gap:6px;font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".__lp_versionMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}" +
      ".__lp_versionBadge{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:999px;font-size:10px;line-height:14px;color:var(--dsw-alias-brand-primary);border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent)}" +
      ".__lp_star{font-size:14px;line-height:18px}" +
      ".__lp_frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base)}" +
      ".__lp_shot{display:block;max-width:100%;max-height:100%;width:auto;height:auto;background:var(--dsw-alias-bg-layer-2)}" +
      ".__lp_interactive{touch-action:none;user-select:none;-webkit-user-select:none;-webkit-user-drag:none;cursor:crosshair}" +
      ".__lp_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;max-width:560px}" +
      ".__lp_emptyTitle{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}" +
      ".__lp_stageNote{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:6px;padding:4px 10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}" +
      ".__lp_overlayErr{position:absolute;top:8px;left:8px;right:8px;padding:4px 8px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}" +
      ".__lp_errorBar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 16px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 25%, transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}" +
      ".__lp_errorText{flex:1;min-width:0;word-break:break-word}" +
      ".__lp_spin{flex:none;width:12px;height:12px;border-radius:50%;border:1.5px solid color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);border-top-color:var(--dsw-alias-label-primary);animation:__lp_spin .8s linear infinite}" +
      "@keyframes __lp_spin{to{transform:rotate(360deg)}}" +
      "@media (prefers-reduced-motion: reduce){.__lp_spin{animation:none}}" +
      ".__lp_chev{flex:none;width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform 120ms ease}" +
      ".__lp_chev[data-open=true]{transform:rotate(45deg)}" +
      ".__lp_progress{flex:none;height:6px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);overflow:hidden}" +
      ".__lp_progressFill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width 160ms ease}" +
      "@media (prefers-reduced-motion: reduce){.__lp_progressFill{transition:none}}" +
      ".__lp_stageBadges{position:absolute;top:8px;left:8px;right:8px;display:flex;align-items:center;justify-content:flex-end;gap:6px;pointer-events:none}" +
      ".__lp_chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:nowrap}" +
      ".__lp_fps[data-tone=success]{color:var(--dsw-alias-state-success-primary)}" +
      ".__lp_fps[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}" +
      ".__lp_fps[data-tone=muted]{color:var(--dsw-alias-label-tertiary)}" +
      ".__lp_logs{flex:none;display:flex;flex-direction:column;min-height:0;border-top:1px solid var(--dsw-alias-border-l2)}" +
      ".__lp_logs[data-open=true]{height:180px}" +
      ".__lp_logs[data-open=false]{height:auto}" +
      ".__lp_logsHead{flex:none;display:flex;align-items:center;gap:8px;min-height:34px;padding:4px 16px}" +
      ".__lp_logsToggle{display:inline-flex;align-items:center;gap:8px;flex:1;min-width:0;height:26px;padding:0 4px;margin-left:-4px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;-webkit-appearance:none}" +
      ".__lp_logsToggle:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".__lp_logsToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}" +
      ".__lp_logsCount{color:var(--dsw-alias-label-tertiary);white-space:nowrap}" +
      ".__lp_logsBody{flex:1;min-height:0;overflow:auto;padding:0 16px 8px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace);font-size:12px;line-height:18px}" +
      ".__lp_logsBody[data-open=false]{display:none}" +
      ".__lp_logLine{display:flex;gap:8px;white-space:pre-wrap;word-break:break-word;padding:0 2px}" +
      ".__lp_logTime{flex:none;color:var(--dsw-alias-label-tertiary)}" +
      ".__lp_logStream{flex:none;width:52px;color:var(--dsw-alias-label-tertiary)}" +
      ".__lp_logText{flex:1;min-width:0;color:var(--dsw-alias-label-primary)}" +
      ".__lp_logLine[data-stream=stderr] .__lp_logText{color:var(--dsw-alias-state-error-primary)}" +
      ".__lp_logLine[data-stream=system] .__lp_logText{color:var(--dsw-alias-label-tertiary)}" +
      ".__lp_logsEmpty{padding:4px 0;color:var(--dsw-alias-label-tertiary)}";

    var cssTagId = "dsh-live-preview/main.css";

    /**
     * Register the bundle stylesheet for the plugin's lifetime and hand back a
     * disposer: apply() owns it through ctx.effect, so disabling or reloading
     * the plugin removes exactly the sheet this instance added.
     */
    function injectStyles() {
      if (typeof document === "undefined" || typeof document.createElement !== "function") {
        return function noop() {};
      }
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-live-preview";
      tag.dataset.pluginCss = cssTagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function removeStyles() {
        if (tag.parentNode && typeof tag.parentNode.removeChild === "function") tag.parentNode.removeChild(tag);
      };
    }

    // //////////////////////////////////////////////////////////////////////
    // Locale dictionaries (zh is the key-set source of truth).
    // //////////////////////////////////////////////////////////////////////
    var zh = {
      panel: "实时预览",
      tabWeb: "网页",
      tabDesk: "桌面窗口",
      tabAndroid: "安卓",
      tabsLabel: "预览目标",
      badgeLive: "运行中",
      badgeIdle: "空闲",
      refresh: "刷新",
      dismiss: "关闭",
      loading: "正在读取状态…",
      errState: "无法获取插件状态，请确认宿主服务正常。",
      errAction: "操作失败",
      errFrame: "画面获取失败",
      never: "暂无",
      justNow: "刚刚",
      secondsAgo: "{n} 秒前",
      minutesAgo: "{n} 分钟前",
      webUrl: "网页地址",
      webUrlPlaceholder: "http://localhost:5173/",
      webLoad: "载入",
      webReload: "重新载入",
      webOpenExternal: "新窗口打开",
      webEmptyTitle: "还没有网页地址",
      webEmpty: "在「启动命令」里运行本地服务，或填入 URL 后点「载入」。",
      webAutoDetected: "自动探测到",
      webAutoUse: "使用",
      webRunLabel: "启动命令",
      webRunPlaceholder: "npm run dev",
      webRun: "运行",
      webStopRun: "停止",
      webFrameTitle: "网页预览",
      runStatusIdle: "空闲",
      runStatusStarting: "启动中",
      runStatusRunning: "运行中",
      runStatusExited: "已退出",
      runStatusStopped: "已停止",
      runExitCode: "退出码 {code}",
      runCwd: "目录",
      deskRefresh: "刷新窗口",
      deskWindow: "窗口",
      deskSelectPlaceholder: "选择一个窗口",
      deskActivate: "置前",
      deskRestore: "取回窗口",
      deskRestoreHint: "导入应用时窗口默认被移到屏幕外，点这里把它拿回屏幕（预览会继续）",
      deskStop: "停止串流",
      deskSelected: "当前窗口",
      deskFrames: "{fps} 帧/秒",
      deskLastFrame: "最近一帧 {time}",
      deskUnsupported: "当前平台不支持窗口捕获。",
      deskEmptyTitle: "还没有选择窗口",
      deskEmpty: "点「刷新窗口」，再从列表里选一个窗口开始实时串流。",
      deskNoWindows: "没有找到可捕获的窗口。",
      deskWindowCount: "共 {count} 个窗口",
      deskUntitled: "未命名窗口",
      deskStreaming: "串流中",
      waitingFrame: "正在等待画面…",
      andrAdbMissingTitle: "未检测到 adb",
      andrAdbMissing: "安卓镜像需要 Android platform-tools 里的 adb。",
      andrInstall: "安装 adb",
      andrInstalling: "正在下载并解压 platform-tools…",
      andrInstallHint: "约 8 MB，只写入 DSH 数据目录。",
      andrInstallError: "安装失败：{error}",
      andrDevice: "设备",
      andrNoDevices: "没有检测到设备",
      andrRefresh: "刷新设备",
      andrStart: "开始镜像",
      andrStop: "停止镜像",
      andrRestart: "重启应用",
      andrBack: "返回",
      andrHome: "主页",
      andrEnter: "回车",
      andrTextPlaceholder: "输入要发送的文字",
      andrSend: "发送",
      andrEmptyTitle: "还没有设备镜像",
      andrEmpty: "用 USB 连接手机并开启 USB 调试，或启动模拟器，然后点「刷新设备」。",
      andrUnsupported: "当前平台不支持安卓镜像。",
      andrResolution: "分辨率 {width}×{height}",
      andrTapHint: "点击画面可点击设备，按住拖动可滑动。",
      andrPreviewLabel: "画面",
      andrPreviewFit: "适应",
      andrPreview100: "100%",
      andrPreview200: "200%",
      andrPreviewReset: "默认大小",
      andrPreviewResizeHint: "上下拖动分隔条调整预览高度；双击分隔条恢复默认大小。",
      andrPreviewFocus: "专注预览",
      andrPreviewExitFocus: "显示设置",
      andrVersion: "adb {version}",
      andrDevicesCount: "{count} 台设备",
      andrEmuTitle: "安卓模拟器",
      andrEmuInstall: "安装安卓模拟器（约 2GB）",
      andrEmuInstallHint: "需要下载 Java 运行时、Android SDK 与系统镜像，全部写入插件数据目录。",
      andrEmuInstalling: "正在安装安卓模拟器…",
      andrEmuInstallingTitle: "正在安装安卓模拟器",
      andrEmuInstallWait: "安装期间请保持本页打开，进度会自动刷新。",
      andrEmuStep: "步骤 {index}/{total}",
      andrEmuError: "模拟器操作失败：{error}",
      andrEmuAccelLabel: "硬件加速",
      andrEmuAccelOk: "硬件加速：{mode}",
      andrEmuAccelReady: "硬件加速可用",
      andrEmuAccelMissing: "未启用硬件加速，串流帧率可能不足 30。",
      andrEmuAccelChecking: "正在检测硬件加速…",
      andrEmuAccelInstall: "安装加速驱动（会弹 UAC）",
      andrEmuFfmpegLabel: "高清串流",
      andrEmuFfmpegOk: "高清串流组件已就绪",
      andrEmuFfmpegMissing: "未安装高清串流组件，将降级为截图轮询。",
      andrEmuFfmpegInstall: "安装高清串流组件（约 110MB）",
      andrEmuFfmpegInstalling: "正在安装高清串流组件…",
      andrEmuAvd: "模拟器",
      andrEmuNoAvd: "没有可用 AVD",
      andrEmuStart: "启动模拟器",
      andrEmuStop: "停止模拟器",
      emulatorStartingShort: "模拟器启动中…",
      andrEmuLaunching: "正在启动模拟器（首次启动可能要 1–2 分钟）…",
      andrEmuLaunchingShort: "正在启动…",
      andrEmuLaunchingTitle: "正在启动模拟器",
      andrEmuRunning: "模拟器运行中",
      andrModeH264: "高清串流",
      andrModeScreencap: "截图轮询",
      andrStreamFps: "{fps} 帧/秒",
      rightGuideDesc: "在右侧边栏与会话同时显示应用画面",
      rightOpen: "右侧同时看",
      openMainPanel: "打开主面板",
      rightEmpty: "还没有正在运行的应用。可以导入 APK / exe / 网页包，或先在主面板启动模拟器。",
      rightTitleAndroid: "安卓 · 模拟器",
      rightTitleDesk: "Windows 窗口",
      rightTitleWeb: "网页预览",
      importTitle: "导入应用文件",
      importPick: "选择文件",
      importHint: "支持 APK、Windows exe、HTML / ZIP 网页包，自动识别系统并运行。",
      importUploading: "正在上传 {percent}%…",
      importRunning: "正在识别并运行…",
      importDone: "已导入：{detail}",
      importFailed: "导入失败：{error}",
      importKindAndroid: "已安装到安卓模拟器",
      importKindWindows: "已在 Windows 启动并开始预览",
      importKindWeb: "已加载网页应用",
      importBusy: "正在导入，请稍候…",
      previewBusy: "预览连接数已满，请稍等或关闭其他预览",
      retry: "重试",
      logsTitle: "日志",
      needKeepTitle: "需要保留哪个版本？",
      needKeepDesc: "旧版本和新版本都在运行。选择后 60 秒，未保留版本的进程会被关闭（应用包保留在「历史应用」里）。",
      keepOldVersion: "保留旧版本",
      keepNewVersion: "保留新版本",
      keepChosen: "已保留：{name}",
      keepCloseIn: "{seconds} 秒后关闭未保留版本",
      historyApps: "历史应用",
      historyEmpty: "还没有历史版本。导入应用后会自动记录，交付新版本时也会在这里出现。",
      versionMark: "标记",
      versionUnmark: "取消标记",
      versionDelete: "删除",
      versionDeleteConfirm: "删除这个版本？对应的应用文件会被移除（运行中的进程会先被关闭）。",
      versionLatest: "最新",
      versionRunHint: "运行该版本",
      historyHint: "点击任意版本可直接运行；★ 标记，删除会移除该版本文件。",
      versionSession: "对话 {id}",
      versionUngrouped: "未关联对话",
      versionCount: "{count} 个版本",
      versionAssign: "归到当前对话",
      versionAssignAll: "全部归到当前对话",
      versionAssignUngrouped: "把这 {count} 个未关联版本归到当前对话",
      versionOpeningLoading: "正在启动 {name}…",
      versionOpeningEmulator: "正在启动安卓模拟器…",
      versionOpeningInstall: "正在安装 {name}…",
      historySessionHint: "只显示当前对话下的应用版本；点击可直接运行。",
      historySessionEmpty: "当前对话下还没有应用版本。",
      versionRunning: "运行中",
      versionOldLabel: "旧版本",
      versionNewLabel: "新版本",
      versionKindAndroid: "安卓",
      versionKindWindows: "Windows",
      versionKindWeb: "网页",
      logsClear: "清空",
      logsEmpty: "暂无日志",
      logsCollapse: "折叠",
      logsExpand: "展开",
      logsCount: "{count} 行",
    };

    var en = {
      panel: "Live Preview",
      tabWeb: "Web",
      tabDesk: "Windows",
      tabAndroid: "Android",
      tabsLabel: "Preview target",
      badgeLive: "Live",
      badgeIdle: "Idle",
      refresh: "Refresh",
      dismiss: "Dismiss",
      loading: "Reading state…",
      errState: "Cannot read the plugin state. Check that the host service is running.",
      errAction: "Action failed",
      errFrame: "Frame request failed",
      never: "never",
      justNow: "just now",
      secondsAgo: "{n}s ago",
      minutesAgo: "{n} min ago",
      webUrl: "Page URL",
      webUrlPlaceholder: "http://localhost:5173/",
      webLoad: "Load",
      webReload: "Reload",
      webOpenExternal: "Open in new tab",
      webEmptyTitle: "No page URL yet",
      webEmpty: "Run a dev server with the start command below, or paste a URL and press Load.",
      webAutoDetected: "Auto-detected",
      webAutoUse: "Use",
      webRunLabel: "Start command",
      webRunPlaceholder: "npm run dev",
      webRun: "Run",
      webStopRun: "Stop",
      webFrameTitle: "Web preview",
      runStatusIdle: "idle",
      runStatusStarting: "starting",
      runStatusRunning: "running",
      runStatusExited: "exited",
      runStatusStopped: "stopped",
      runExitCode: "exit {code}",
      runCwd: "cwd",
      deskRefresh: "Refresh windows",
      deskWindow: "Window",
      deskSelectPlaceholder: "Select a window",
      deskActivate: "Bring to front",
      deskRestore: "Bring app back",
      deskRestoreHint: "Imported app windows are moved off-screen; click to bring this one back on screen",
      deskStop: "Stop stream",
      deskSelected: "Current window",
      deskFrames: "{fps} fps",
      deskLastFrame: "last frame {time}",
      deskUnsupported: "Window capture is not available on this platform.",
      deskEmptyTitle: "No window selected",
      deskEmpty: "Press Refresh windows, then pick a window to start streaming.",
      deskNoWindows: "No capturable windows found.",
      deskWindowCount: "{count} windows",
      deskUntitled: "Untitled window",
      deskStreaming: "streaming",
      waitingFrame: "Waiting for frames…",
      andrAdbMissingTitle: "adb not found",
      andrAdbMissing: "Android mirroring needs adb from Android platform-tools.",
      andrInstall: "Install adb",
      andrInstalling: "Downloading and extracting platform-tools…",
      andrInstallHint: "About 8 MB, written to the DSH data directory only.",
      andrInstallError: "Install failed: {error}",
      andrDevice: "Device",
      andrNoDevices: "No devices detected",
      andrRefresh: "Refresh devices",
      andrStart: "Start mirror",
      andrStop: "Stop mirror",
      andrRestart: "Restart app",
      andrBack: "Back",
      andrHome: "Home",
      andrEnter: "Enter",
      andrTextPlaceholder: "Text to send",
      andrSend: "Send",
      andrEmptyTitle: "No mirror yet",
      andrEmpty: "Connect a phone with USB debugging enabled, or start an emulator, then press Refresh devices.",
      andrUnsupported: "Android mirroring is not available on this platform.",
      andrResolution: "{width}×{height}",
      andrTapHint: "Click the frame to tap; press and drag to swipe.",
      andrPreviewLabel: "View",
      andrPreviewFit: "Fit",
      andrPreview100: "100%",
      andrPreview200: "200%",
      andrPreviewReset: "Default",
      andrPreviewResizeHint: "Drag the divider to resize the preview; double-click it to reset.",
      andrPreviewFocus: "Focus view",
      andrPreviewExitFocus: "Show settings",
      andrVersion: "adb {version}",
      andrDevicesCount: "{count} devices",
      andrEmuTitle: "Android emulator",
      andrEmuInstall: "Install Android emulator (~2 GB)",
      andrEmuInstallHint: "Downloads the Java runtime, Android SDK and a system image into the plugin data directory.",
      andrEmuInstalling: "Installing the Android emulator…",
      andrEmuInstallingTitle: "Installing the Android emulator",
      andrEmuInstallWait: "Keep this page open during the install; the progress refreshes automatically.",
      andrEmuStep: "Step {index}/{total}",
      andrEmuError: "Emulator action failed: {error}",
      andrEmuAccelLabel: "Acceleration",
      andrEmuAccelOk: "Hardware acceleration: {mode}",
      andrEmuAccelReady: "Hardware acceleration available",
      andrEmuAccelMissing: "Hardware acceleration is off; streaming may stay below 30 fps.",
      andrEmuAccelChecking: "Checking hardware acceleration…",
      andrEmuAccelInstall: "Install accelerator (UAC prompt)",
      andrEmuFfmpegLabel: "HD streaming",
      andrEmuFfmpegOk: "HD streaming component is ready",
      andrEmuFfmpegMissing: "HD streaming component missing; falling back to screencap polling.",
      andrEmuFfmpegInstall: "Install HD streaming component (~110 MB)",
      andrEmuFfmpegInstalling: "Installing the HD streaming component…",
      andrEmuAvd: "Emulator",
      andrEmuNoAvd: "No AVD available",
      andrEmuStart: "Start emulator",
      andrEmuStop: "Stop emulator",
      emulatorStartingShort: "Starting…",
      andrEmuLaunching: "Starting the emulator (first boot may take 1–2 minutes)…",
      andrEmuLaunchingShort: "Starting…",
      andrEmuLaunchingTitle: "Starting the emulator",
      andrEmuRunning: "Emulator running",
      andrModeH264: "HD stream",
      andrModeScreencap: "Screencap polling",
      andrStreamFps: "{fps} fps",
      rightGuideDesc: "Show the running app beside the chat in the right sidebar",
      rightOpen: "Side-by-side",
      openMainPanel: "Open main panel",
      rightEmpty: "Nothing is running yet. Import an APK / exe / web bundle, or start the emulator from the main panel.",
      rightTitleAndroid: "Android · emulator",
      rightTitleDesk: "Windows window",
      rightTitleWeb: "Web preview",
      importTitle: "Import app file",
      importPick: "Choose file",
      importHint: "APK, Windows exe, or HTML / ZIP web bundle — the right target is detected automatically.",
      importUploading: "Uploading {percent}%…",
      importRunning: "Detecting and starting…",
      importDone: "Imported: {detail}",
      importFailed: "Import failed: {error}",
      importKindAndroid: "Installed on the Android emulator",
      importKindWindows: "Started on Windows and previewing",
      importKindWeb: "Loaded the web app",
      importBusy: "An import is already running…",
      previewBusy: "Preview connections are busy — retry or close other previews",
      retry: "Retry",
      logsTitle: "Logs",
      needKeepTitle: "Which version do you want to keep?",
      needKeepDesc: "Both versions are running. One minute after you choose, the process of the version you did not keep is closed (the app package is kept in App history).",
      keepOldVersion: "Keep old version",
      keepNewVersion: "Keep new version",
      keepChosen: "Keeping: {name}",
      keepCloseIn: "Closing the other version in {seconds}s",
      historyApps: "App history",
      historyEmpty: "No versions yet. Importing an app records one; delivered updates show up here too.",
      versionMark: "Mark",
      versionUnmark: "Unmark",
      versionDelete: "Delete",
      versionDeleteConfirm: "Delete this version? Its file will be removed (a running process is stopped first).",
      versionLatest: "latest",
      versionRunHint: "Run this version",
      historyHint: "Click a version to run it; ★ marks it, delete removes its file.",
      versionSession: "Chat {id}",
      versionUngrouped: "No conversation",
      versionCount: "{count} versions",
      versionAssign: "Move to this chat",
      versionAssignAll: "Move all to this chat",
      versionAssignUngrouped: "Move these {count} unassigned versions to this chat",
      versionOpeningLoading: "Starting {name}…",
      versionOpeningEmulator: "Starting Android emulator…",
      versionOpeningInstall: "Installing {name}…",
      historySessionHint: "Only apps from this conversation; click to run.",
      historySessionEmpty: "No app versions in this conversation yet.",
      versionRunning: "running",
      versionOldLabel: "Old version",
      versionNewLabel: "New version",
      versionKindAndroid: "Android",
      versionKindWindows: "Windows",
      versionKindWeb: "Web",
      logsClear: "Clear",
      logsEmpty: "No log output yet",
      logsCollapse: "Collapse",
      logsExpand: "Expand",
      logsCount: "{count} lines",
    };

    // Bound in apply(); tr() is a safe stand-in before that (and in tests).
    var T = null;
    function tr(key, params) {
      if (typeof T !== "function") return key;
      var text = T(key, params);
      return text === undefined || text === null ? key : text;
    }

    // Preview geometry preferences (per browser, survive reloads).
    var STORE_ANDROID_PREVIEW_HEIGHT = "dsh-live-preview:android:previewHeight";
    var STORE_ANDROID_PREVIEW_ZOOM = "dsh-live-preview:android:previewZoom";
    var STORE_ANDROID_PREVIEW_FOCUS = "dsh-live-preview:android:previewFocus2";
    var MIN_PREVIEW_HEIGHT = 200;
    var MAX_PREVIEW_HEIGHT = 1400;

    function readStored(key) {
      try {
        if (typeof window === "undefined" || !window.localStorage) return null;
        return window.localStorage.getItem(key);
      } catch (error) {
        return null;
      }
    }

    function writeStored(key, value) {
      try {
        if (typeof window === "undefined" || !window.localStorage) return;
        if (value === null || value === undefined) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, String(value));
      } catch (error) {
        /* private mode / quota: preference is best-effort */
      }
    }

    function readStoredPreviewHeight() {
      var height = Number(readStored(STORE_ANDROID_PREVIEW_HEIGHT));
      if (!isFinite(height) || height < MIN_PREVIEW_HEIGHT || height > MAX_PREVIEW_HEIGHT) return 0;
      return Math.round(height);
    }

    function readStoredPreviewZoom() {
      var zoom = readStored(STORE_ANDROID_PREVIEW_ZOOM);
      return zoom === "1" || zoom === "2" ? zoom : "fit";
    }

    function readStoredFocusMode() {
      var raw = readStored(STORE_ANDROID_PREVIEW_FOCUS);
      if (raw === "1") return true;
      if (raw === "0") return false;
      return null;
    }

    // //////////////////////////////////////////////////////////////////////
    // Small helpers — pure, no DOM, no state.
    // //////////////////////////////////////////////////////////////////////
    function errText(error) {
      if (error === null || error === undefined) return tr("errAction");
      if (typeof error === "string") return error;
      if (error.message) return String(error.message);
      return String(error);
    }

    function pad2(n) {
      return n < 10 ? "0" + n : "" + n;
    }

    function fmtClock(ms) {
      if (!ms || typeof ms !== "number") return "--:--:--";
      var d = new Date(ms);
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    }

    function fmtAgo(ms) {
      if (!ms || typeof ms !== "number") return tr("never");
      var sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (sec < 2) return tr("justNow");
      if (sec < 60) return tr("secondsAgo", { n: sec });
      return tr("minutesAgo", { n: Math.round(sec / 60) });
    }

    function mergeLogs(prev, lines) {
      if (!Array.isArray(lines) || lines.length === 0) return prev;
      var seen = Object.create(null);
      var i;
      for (i = 0; i < prev.length; i += 1) {
        if (prev[i] && typeof prev[i].seq === "number") seen[prev[i].seq] = true;
      }
      var extra = [];
      for (i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        if (!line || typeof line.seq !== "number" || seen[line.seq]) continue;
        seen[line.seq] = true;
        extra.push(line);
      }
      if (extra.length === 0) return prev;
      var next = prev.concat(extra);
      if (next.length > MAX_LOG_LINES) next = next.slice(next.length - MAX_LOG_LINES);
      return next;
    }

    function getJSON(path) {
      return fetch(path, { cache: "no-store" }).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch (parseError) {
              data = null;
            }
          }
          if (!res.ok) {
            if (data && data.error) throw new Error(String(data.error));
            throw new Error("HTTP " + res.status);
          }
          if (data === null) return {};
          if (data.ok === false) throw new Error(data.error ? String(data.error) : tr("errAction"));
          return data;
        });
      });
    }

    function postAction(name, params) {
      var body = { action: name };
      if (params) {
        var keys = Object.keys(params);
        for (var i = 0; i < keys.length; i += 1) {
          if (params[keys[i]] !== undefined) body[keys[i]] = params[keys[i]];
        }
      }
      return fetch(API + "/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch (parseError) {
              data = null;
            }
          }
          if (!res.ok) {
            if (data && data.error) throw new Error(String(data.error));
            throw new Error("HTTP " + res.status);
          }
          if (data === null) return {};
          if (data.ok === false) throw new Error(data.error ? String(data.error) : tr("errAction"));
          return data;
        });
      });
    }

    // //////////////////////////////////////////////////////////////////////
    // Hooks — plain custom hooks, called unconditionally at component top.
    // //////////////////////////////////////////////////////////////////////

    /** A ref that flips false from its effect cleanup: guards late setState. */
    function useAlive() {
      var ref = useRef(true);
      useEffect(function () {
        ref.current = true;
        return function () {
          ref.current = false;
        };
      }, []);
      return ref;
    }

    /**
     * Stream `target`'s frames into a blob URL while `enabled`.
     * 204 (no frame yet) is skipped, not an error. The cleanup aborts the
     * in-flight request, stops the timer and revokes the last object URL.
     * @returns {{ url: string | null, error: string | null }}
     */
    function useFrameStream(target, enabled) {
      var urlState = useState(null);
      var frameUrl = urlState[0];
      var setFrameUrl = urlState[1];
      var errState = useState(null);
      var frameErr = errState[0];
      var setFrameErr = errState[1];

      useEffect(
        function () {
          if (!enabled) return undefined;
          var stopped = false;
          var timer = null;
          var ctrl = null;
          var currentUrl = null;
          setFrameUrl(null);
          setFrameErr(null);

          function tick() {
            if (stopped) return;
            ctrl = new AbortController();
            fetch(API + "/frame?target=" + target + "&_=" + Date.now(), {
              signal: ctrl.signal,
              cache: "no-store",
            })
              .then(function (res) {
                if (res.status === 204) return null;
                if (!res.ok) throw new Error("HTTP " + res.status);
                return res.blob();
              })
              .then(function (blob) {
                if (stopped || blob === null) return;
                var nextUrl = URL.createObjectURL(blob);
                var previousUrl = currentUrl;
                currentUrl = nextUrl;
                setFrameUrl(nextUrl);
                setFrameErr(null);
                if (previousUrl !== null) URL.revokeObjectURL(previousUrl);
              })
              .catch(function (error) {
                if (stopped || (error && error.name === "AbortError")) return;
                setFrameErr(errText(error));
              })
              .then(function () {
                if (!stopped) timer = setTimeout(tick, FRAME_INTERVAL_MS);
              });
          }

          tick();

          return function () {
            stopped = true;
            if (timer !== null) clearTimeout(timer);
            if (ctrl !== null) ctrl.abort();
            if (currentUrl !== null) URL.revokeObjectURL(currentUrl);
          };
        },
        [target, enabled]
      );

      return { url: frameUrl, error: frameErr };
    }

    // //////////////////////////////////////////////////////////////////////
    // Sidebar icon — the row is the host's; draw only the glyph.
    // //////////////////////////////////////////////////////////////////////

    function LivePreviewIcon(props) {
      var size = props && typeof props.size === "number" ? props.size : 18;
      var active = !!(props && props.active);
      var strokeWidth = active ? 1.9 : 1.5;
      var play = active
        ? h("path", {
            d: "M10.2 7.7 15.2 10.4 10.2 13.1Z",
            fill: "currentColor",
            stroke: "currentColor",
            strokeWidth: 1.1,
            strokeLinejoin: "round",
          })
        : h("path", {
            d: "M10.2 7.7 15.2 10.4 10.2 13.1Z",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.5,
            strokeLinejoin: "round",
          });
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true",
          focusable: "false",
          "data-live-preview-icon": active ? "active" : "idle",
        },
        h("rect", {
          x: 2.6,
          y: 3.4,
          width: 18.8,
          height: 13.4,
          rx: 2.6,
          stroke: "currentColor",
          strokeWidth: strokeWidth,
        }),
        h("path", {
          d: "M8.6 20.4h6.8",
          stroke: "currentColor",
          strokeWidth: strokeWidth,
          strokeLinecap: "round",
        }),
        h("path", {
          d: "M12 16.8v3.6",
          stroke: "currentColor",
          strokeWidth: strokeWidth,
          strokeLinecap: "round",
        }),
        play
      );
    }

    function RefreshGlyph() {
      return h(
        "svg",
        {
          width: 16,
          height: 16,
          viewBox: "0 0 24 24",
          fill: "none",
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("path", {
          d: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
        }),
        h("path", {
          d: "M19.7 4.3v4.5h-4.5",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        })
      );
    }

    // //////////////////////////////////////////////////////////////////////
    // Presentational pieces
    // //////////////////////////////////////////////////////////////////////

    function EmptyState(props) {
      return h(
        "div",
        { className: "__lp_empty" },
        props.title ? h("div", { className: "__lp_emptyTitle" }, props.title) : null,
        props.text ? h("div", null, props.text) : null,
        props.action || null
      );
    }

    function LogsPanel(props) {
      var lines = Array.isArray(props.lines) ? props.lines : [];
      var open = !!props.open;
      var bodyRef = useRef(null);

      useEffect(
        function () {
          var el = bodyRef.current;
          if (el && open) el.scrollTop = el.scrollHeight;
        },
        [lines.length, open]
      );

      function toggle() {
        props.onToggle(!open);
      }

      var rows = [];
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        var stream = line && line.stream ? line.stream : "stdout";
        rows.push(
          h(
            "div",
            { className: "__lp_logLine", "data-stream": stream, key: String(line.seq) },
            h("span", { className: "__lp_logTime" }, fmtClock(line.t)),
            h("span", { className: "__lp_logStream" }, stream),
            h("span", { className: "__lp_logText" }, line.text === undefined || line.text === null ? "" : String(line.text))
          )
        );
      }

      return h(
        "section",
        { className: "__lp_logs", "data-open": open ? "true" : "false", "aria-label": tr("logsTitle") },
        h(
          "div",
          { className: "__lp_logsHead" },
          h(
            "button",
            {
              type: "button",
              className: "__lp_logsToggle",
              onClick: toggle,
              "aria-expanded": open ? "true" : "false",
              "aria-label": open ? tr("logsCollapse") : tr("logsExpand"),
              title: open ? tr("logsCollapse") : tr("logsExpand"),
            },
            h("span", { className: "__lp_chev", "data-open": open ? "true" : "false" }),
            h("span", null, tr("logsTitle")),
            h("span", { className: "__lp_logsCount" }, tr("logsCount", { count: lines.length }))
          ),
          h(
            "button",
            {
              type: "button",
              className: "__lp_btn",
              onClick: props.onClear,
              disabled: lines.length === 0,
              "aria-label": tr("logsClear"),
            },
            tr("logsClear")
          )
        ),
        h(
          "div",
          { className: "__lp_logsBody", "data-open": open ? "true" : "false", ref: bodyRef, role: "log", "aria-live": "off" },
          lines.length === 0
            ? h("div", { className: "__lp_logsEmpty" }, tr("logsEmpty"))
            : rows
        )
      );
    }

    // //////////////////////////////////////////////////////////////////////
    // Web tab
    // //////////////////////////////////////////////////////////////////////

    function WebPane(props) {
      var web = props.web || {};
      var run = props.run || {};
      var busy = props.busy || null;
      var running = run.status === "starting" || run.status === "running";

      var urlState = useState(web.url || "");
      var urlDraft = urlState[0];
      var setUrlDraft = urlState[1];
      var cmdState = useState(web.runCommand || run.command || "");
      var cmdDraft = cmdState[0];
      var setCmdDraft = cmdState[1];
      var cmdTouched = useRef(false);

      useEffect(
        function () {
          setUrlDraft(web.url || "");
        },
        [web.url]
      );

      useEffect(
        function () {
          if (!cmdTouched.current && web.runCommand) setCmdDraft(web.runCommand);
        },
        [web.runCommand]
      );

      function loadUrl() {
        var url = String(urlDraft || "").trim();
        if (!url) return;
        props.onAction("web.url", { url: url });
      }

      function runCommand() {
        var command = String(cmdDraft || "").trim();
        if (!command) return;
        props.onAction("run", { command: command, kind: "web", url: web.url || undefined });
      }

      function useDetected() {
        var url = web.url || "";
        setUrlDraft(url);
        if (url) props.onAction("web.url", { url: url });
      }

      function onUrlKeyDown(event) {
        if (event && event.key === "Enter") {
          event.preventDefault();
          loadUrl();
        }
      }

      function onCmdKeyDown(event) {
        if (event && event.key === "Enter") {
          event.preventDefault();
          runCommand();
        }
      }

      var statusLabel = tr("runStatusIdle");
      if (run.status === "starting") statusLabel = tr("runStatusStarting");
      else if (run.status === "running") statusLabel = tr("runStatusRunning");
      else if (run.status === "exited") statusLabel = tr("runStatusExited");
      else if (run.status === "stopped") statusLabel = tr("runStatusStopped");

      var stage;
      if (web.url) {
        stage = h("iframe", {
          className: "__lp_frame",
          key: String(props.reloadKey) + "|" + web.url,
          src: web.url,
          title: tr("webFrameTitle"),
          allow: "clipboard-read; clipboard-write",
          referrerPolicy: "no-referrer",
        });
      } else {
        stage = h(EmptyState, { title: tr("webEmptyTitle"), text: tr("webEmpty") });
      }

      return h(
        "div",
        { className: "__lp_pane" },
        h(
          "div",
          { className: "__lp_card" },
          h(
            "div",
            { className: "__lp_row" },
            h(
              "div",
              { className: "__lp_field" },
              h("span", { className: "__lp_label" }, tr("webUrl")),
              h("input", {
                className: "__lp_input",
                type: "url",
                value: urlDraft,
                placeholder: tr("webUrlPlaceholder"),
                onChange: function (event) {
                  setUrlDraft(event.target.value);
                },
                onKeyDown: onUrlKeyDown,
                "aria-label": tr("webUrl"),
                spellCheck: false,
              })
            ),
            h(
              "button",
              {
                type: "button",
                className: "__lp_btn __lp_btnPrimary",
                onClick: loadUrl,
                disabled: !String(urlDraft || "").trim() || busy === "web.url",
              },
              tr("webLoad")
            ),
            web.url
              ? h(
                  "a",
                  {
                    className: "__lp_btn",
                    href: web.url,
                    target: "_blank",
                    rel: "noreferrer noopener",
                  },
                  tr("webOpenExternal")
                )
              : null
          ),
          web.autoDetected && web.url
            ? h(
                "div",
                { className: "__lp_hint" },
                h("span", null, tr("webAutoDetected")),
                h("span", { className: "__lp_mono" }, web.url),
                h(
                  "button",
                  { type: "button", className: "__lp_btn", onClick: useDetected },
                  tr("webAutoUse")
                )
              )
            : null,
          h(
            "div",
            { className: "__lp_row" },
            h(
              "div",
              { className: "__lp_field" },
              h("span", { className: "__lp_label" }, tr("webRunLabel")),
              h("input", {
                className: "__lp_input __lp_mono",
                type: "text",
                value: cmdDraft,
                placeholder: tr("webRunPlaceholder"),
                onChange: function (event) {
                  cmdTouched.current = true;
                  setCmdDraft(event.target.value);
                },
                onKeyDown: onCmdKeyDown,
                "aria-label": tr("webRunLabel"),
                spellCheck: false,
              })
            ),
            running
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "__lp_btn __lp_btnDanger",
                    onClick: function () {
                      props.onAction("stop", {});
                    },
                    disabled: busy === "stop",
                  },
                  tr("webStopRun")
                )
              : h(
                  "button",
                  {
                    type: "button",
                    className: "__lp_btn __lp_btnPrimary",
                    onClick: runCommand,
                    disabled: !String(cmdDraft || "").trim() || busy === "run",
                  },
                  tr("webRun")
                )
          ),
          h(
            "div",
            { className: "__lp_hint" },
            h("span", null, statusLabel),
            run.command ? h("span", { className: "__lp_mono" }, run.command) : null,
            run.status === "exited" && run.exitCode !== null && run.exitCode !== undefined
              ? h("span", null, tr("runExitCode", { code: run.exitCode }))
              : null,
            run.cwd ? h("span", null, tr("runCwd") + ": " + run.cwd) : null
          )
        ),
        h("div", { className: "__lp_stage" }, stage)
      );
    }

    // //////////////////////////////////////////////////////////////////////
    // Desktop-window tab
    // //////////////////////////////////////////////////////////////////////

    function DeskPane(props) {
      var desk = props.desk || {};
      var busy = props.busy || null;
      var supported = desk.supported !== false;
      var streaming = !!desk.streaming;
      var stream = useFrameStream("desk", streaming);
      var winState = useState([]);
      var windows = winState[0];
      var setWindows = winState[1];
      var loadState = useState(false);
      var loading = loadState[0];
      var setLoading = loadState[1];
      var localErrState = useState(null);
      var localErr = localErrState[0];
      var setLocalErr = localErrState[1];
      var firstLoad = useRef(true);

      function loadWindows() {
        setLoading(true);
        setLocalErr(null);
        return postAction("desk.list", {})
          .then(function (data) {
            setLoading(false);
            if (data && Array.isArray(data.windows)) setWindows(data.windows);
            return data;
          })
          .catch(function (error) {
            setLoading(false);
            setLocalErr(errText(error));
            return null;
          });
      }

      useEffect(function () {
        if (!supported) return;
        if (firstLoad.current) {
          firstLoad.current = false;
          loadWindows();
        }
      }, [supported]);

      var selected = desk.selectedHwnd;
      var selectedValue = selected === null || selected === undefined ? "" : String(selected);

      function onSelect(event) {
        var raw = event.target.value;
        if (!raw) return;
        props.onAction("desk.select", { hwnd: Number(raw) });
      }

      var windowOptions = [
        h("option", { value: "", key: "__none" }, tr("deskSelectPlaceholder")),
      ].concat(
        windows.map(function (win) {
          var label = win && win.title ? win.title : tr("deskUntitled");
          if (win && win.pid) label = label + " · " + win.pid;
          return h("option", { value: String(win.hwnd), key: String(win.hwnd) }, label);
        })
      );

      var stage;
      if (!supported) {
        stage = h(EmptyState, { title: tr("deskEmptyTitle"), text: tr("deskUnsupported") });
      } else if (streaming) {
        stage = [
          stream.url
            ? h("img", {
                key: "shot",
                className: "__lp_shot",
                src: stream.url,
                alt: tr("deskSelected") + ": " + (desk.selectedTitle || ""),
                draggable: false,
              })
            : h(
                "div",
                { className: "__lp_empty", key: "waiting" },
                h("span", { className: "__lp_spin" }),
                h("span", null, tr("waitingFrame"))
              ),
          stream.error
            ? h("div", { className: "__lp_overlayErr", key: "err" }, tr("errFrame") + ": " + stream.error)
            : null,
        ];
      } else {
        stage = h(EmptyState, {
          title: tr("deskEmptyTitle"),
          text: windows.length === 0 && !loading ? tr("deskNoWindows") + " " + tr("deskEmpty") : tr("deskEmpty"),
        });
      }

      return h(
        "div",
        { className: "__lp_pane" },
        h(
          "div",
          { className: "__lp_card" },
          h(
            "div",
            { className: "__lp_row" },
            h(
              "div",
              { className: "__lp_field" },
              h("span", { className: "__lp_label" }, tr("deskWindow")),
              h(
                "select",
                {
                  className: "__lp_select",
                  value: selectedValue,
                  onChange: onSelect,
                  "aria-label": tr("deskWindow"),
                  disabled: !supported,
                },
                windowOptions
              )
            ),
            h(
              "button",
              {
                type: "button",
                className: "__lp_btn",
                onClick: loadWindows,
                disabled: !supported || loading || busy === "desk.list",
                "aria-label": tr("deskRefresh"),
              },
              tr("deskRefresh")
            ),
            h(
              "button",
              {
                type: "button",
                className: "__lp_btn",
                onClick: function () {
                  props.onAction("desk.activate", {});
                },
                disabled: !supported || !selected || busy === "desk.activate",
              },
              tr("deskActivate")
            ),
            h(
              "button",
              {
                type: "button",
                className: "__lp_btn",
                onClick: function () {
                  props.onAction("desk.restore", {});
                },
                disabled: !supported || !selected || busy === "desk.restore",
                title: tr("deskRestoreHint"),
              },
              tr("deskRestore")
            ),
            h(
              "button",
              {
                type: "button",
                className: "__lp_btn __lp_btnDanger",
                onClick: function () {
                  props.onAction("desk.stop", {});
                },
                disabled: !supported || !streaming || busy === "desk.stop",
              },
              tr("deskStop")
            )
          ),
          h(
            "div",
            { className: "__lp_hint" },
            loading ? h("span", { className: "__lp_spin" }) : null,
            h("span", null, tr("deskWindowCount", { count: windows.length })),
            desk.selectedTitle ? h("span", null, tr("deskSelected") + ": " + desk.selectedTitle) : null,
            streaming ? h("span", null, tr("deskStreaming")) : null,
            streaming ? h("span", null, tr("deskFrames", { fps: Math.round(Number(desk.fps) || 0) })) : null,
            desk.lastFrameAt ? h("span", null, tr("deskLastFrame", { time: fmtAgo(desk.lastFrameAt) })) : null,
            localErr ? h("span", { className: "__lp_hintError" }, localErr) : null,
            desk.error ? h("span", { className: "__lp_hintError" }, String(desk.error)) : null
          )
        ),
        h("div", { className: "__lp_stage" }, stage)
      );
    }

    // //////////////////////////////////////////////////////////////////////
    // Android tab — emulator one-click install card + HD (MJPEG) preview.
    // //////////////////////////////////////////////////////////////////////

    var mjpegSerial = 0;

    /** Monotonic page-level token: a new value forces a fresh MJPEG connection. */
    function newMjpegToken() {
      mjpegSerial += 1;
      return String(Date.now()) + "-" + mjpegSerial;
    }

    function AndroidPane(props) {
      var android = props.android || {};
      var adb = android.adb || {};
      var emulator = android.emulator && typeof android.emulator === "object" ? android.emulator : {};
      var streamInfo = android.stream && typeof android.stream === "object" ? android.stream : {};
      // The contract puts ffmpeg under emulator.ffmpeg; keep the flat
      // android.ffmpeg shape as a fallback for older service builds.
      var ffmpeg =
        emulator.ffmpeg && typeof emulator.ffmpeg === "object"
          ? emulator.ffmpeg
          : android.ffmpeg && typeof android.ffmpeg === "object"
            ? android.ffmpeg
            : {};
      var busy = props.busy || null;
      var supported = android.supported !== false;
      var streaming = !!android.streaming;
      // h264 means the host decodes adb screenrecord through ffmpeg and exposes
      // a multipart MJPEG endpoint: an <img> can display it directly, no polling.
      var hdStream = streaming && streamInfo.mode === "h264";
      var devices = Array.isArray(android.devices) ? android.devices : [];
      var resolution = android.resolution || null;

      var emulatorInstalled = !!emulator.installed;
      var emulatorInstalling = !!emulator.installing;
      var emulatorLaunching =
        !!emulator.launching || !!emulator.starting || busy === "android.emulator.start";
      var emulatorRunning = !!emulator.running;
      var accel = emulator.accel && typeof emulator.accel === "object" ? emulator.accel : {};
      var progress = emulator.progress && typeof emulator.progress === "object" ? emulator.progress : {};

      var avdNames = [];
      var avdList = Array.isArray(emulator.avds) ? emulator.avds : [];
      for (var avdIndex = 0; avdIndex < avdList.length; avdIndex += 1) {
        var avdEntry = avdList[avdIndex];
        var avdEntryName = avdEntry && typeof avdEntry === "object" ? avdEntry.name : avdEntry;
        if (avdEntryName) avdNames.push(String(avdEntryName));
      }

      var fpsValue = Number(streamInfo.fps);
      if (!isFinite(fpsValue) || fpsValue < 0) fpsValue = 0;
      var fpsTone = fpsValue >= 30 ? "success" : fpsValue >= 15 ? "warn" : "muted";

      var textState = useState("");
      var textDraft = textState[0];
      var setTextDraft = textState[1];
      var avdState = useState("");
      var avdDraft = avdState[0];
      var setAvdDraft = avdState[1];
      var mjpegState = useState(newMjpegToken);
      var mjpegToken = mjpegState[0];
      var setMjpegToken = mjpegState[1];
      var imgRef = useRef(null);
      var dragRef = useRef(null);
      var hdPrevRef = useRef(hdStream);
      var stream = useFrameStream("android", streaming && !hdStream);

      // 预览区可调：高度可拖动大小（持久化），缩放可选 适应/100%/200%。
      var previewHeightState = useState(readStoredPreviewHeight);
      var previewHeight = previewHeightState[0];
      var setPreviewHeight = previewHeightState[1];
      var zoomState = useState(readStoredPreviewZoom);
      var zoomId = zoomState[0];
      var setZoomId = zoomState[1];
      var storedFocusInit = readStoredFocusMode();
      // 默认显示设置（不自动进专注预览）；只认用户手动点过的选择。
      var focusState = useState(storedFocusInit === null ? false : storedFocusInit);
      var focusMode = focusState[0];
      var setFocusMode = focusState[1];
      var stageRef = useRef(null);
      var paneRef = useRef(null);
      var splitterRef = useRef(null);
      var splitDragRef = useRef(null);
      var mjpegRetryRef = useRef(0);

      // A fresh token on mount and whenever the HD stream starts: the browser
      // must never reuse a connection that was created for an earlier mount.
      useEffect(
        function () {
          if (hdStream && !hdPrevRef.current) setMjpegToken(newMjpegToken());
          hdPrevRef.current = hdStream;
        },
        [hdStream]
      );

      // MJPEG 首帧失败（409/429/断流）时自动换 token 重连，避免一直裂图。
      useEffect(
        function () {
          if (!hdStream || !streaming) return undefined;
          if ((Number(streamInfo.frames) || 0) > 0) return undefined;
          var timer = setTimeout(function () {
            retryMjpeg();
          }, 4000);
          return function () {
            clearTimeout(timer);
          };
        },
        [hdStream, streaming, streamInfo.frames]
      );

      var avdValue = "";
      if (avdDraft && avdNames.indexOf(avdDraft) >= 0) avdValue = avdDraft;
      else if (emulator.avd && avdNames.indexOf(String(emulator.avd)) >= 0) avdValue = String(emulator.avd);
      else if (avdNames.length > 0) avdValue = avdNames[0];

      var deviceId = "";
      if (typeof android.device === "string") deviceId = android.device;
      else if (android.device && typeof android.device === "object" && android.device.serial) deviceId = android.device.serial;

      function devicePoint(event) {
        var img = imgRef.current;
        if (!img || typeof img.getBoundingClientRect !== "function") return null;
        var rect = img.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) return null;
        var width = resolution && resolution.width ? Number(resolution.width) : 0;
        var height = resolution && resolution.height ? Number(resolution.height) : 0;
        if (!width || !height) {
          width = img.naturalWidth || 0;
          height = img.naturalHeight || 0;
        }
        if (!width || !height) return null;
        var x = Math.round(((event.clientX - rect.left) * width) / rect.width);
        var y = Math.round(((event.clientY - rect.top) * height) / rect.height);
        x = Math.min(width - 1, Math.max(0, x));
        y = Math.min(height - 1, Math.max(0, y));
        return { x: x, y: y, scale: width / rect.width };
      }

      function onPointerDown(event) {
        if (!streaming) return;
        if (event.button !== undefined && event.button !== 0) return;
        var point = devicePoint(event);
        if (!point) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        var target = event.currentTarget;
        if (target && typeof target.setPointerCapture === "function" && event.pointerId !== undefined) {
          try {
            target.setPointerCapture(event.pointerId);
          } catch (captureError) {
            /* pointer capture is best-effort */
          }
        }
        dragRef.current = {
          x: point.x,
          y: point.y,
          at: Date.now(),
          threshold: Math.max(4, TAP_SLOP_CSS_PX * point.scale),
        };
      }

      function onPointerUp(event) {
        var start = dragRef.current;
        dragRef.current = null;
        if (!start || !streaming) return;
        var point = devicePoint(event);
        if (!point) return;
        var dx = point.x - start.x;
        var dy = point.y - start.y;
        var distance = Math.sqrt(dx * dx + dy * dy);
        if (distance <= start.threshold) {
          props.onAction("android.tap", { x: start.x, y: start.y });
          return;
        }
        var durationMs = Math.min(2000, Math.max(60, Date.now() - start.at));
        props.onAction("android.swipe", {
          x1: start.x,
          y1: start.y,
          x2: point.x,
          y2: point.y,
          durationMs: durationMs,
        });
      }

      function onPointerCancel() {
        dragRef.current = null;
      }

      function sendText() {
        var text = String(textDraft || "");
        if (!text) return;
        props.onAction("android.text", { text: text }).then(function (data) {
          if (data) setTextDraft("");
        });
      }

      function onTextKeyDown(event) {
        if (event && event.key === "Enter") {
          event.preventDefault();
          sendText();
        }
      }

      // —— 预览区尺寸/缩放 ——
      function paneMaxPreviewHeight() {
        var pane = paneRef.current;
        if (pane && typeof pane.getBoundingClientRect === "function") {
          var paneHeight = Math.round(pane.getBoundingClientRect().height) || 0;
          if (paneHeight > 240) return Math.max(MIN_PREVIEW_HEIGHT, paneHeight - 140);
        }
        return MAX_PREVIEW_HEIGHT;
      }

      function clampPreviewHeight(value) {
        var next = Math.round(Number(value) || 0);
        if (next < MIN_PREVIEW_HEIGHT) next = MIN_PREVIEW_HEIGHT;
        if (next > MAX_PREVIEW_HEIGHT) next = MAX_PREVIEW_HEIGHT;
        return next;
      }

      function toggleFocusMode() {
        var next = !focusMode;
        setFocusMode(next);
        writeStored(STORE_ANDROID_PREVIEW_FOCUS, next ? "1" : "0");
        // 进入专注时让预览铺满；退出时恢复默认高度，避免卡片回来把预览裁切。
        setPreviewHeight(0);
        writeStored(STORE_ANDROID_PREVIEW_HEIGHT, null);
      }

      function onSplitterDown(event) {
        if (!event) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        var stage = stageRef.current;
        var startHeight = previewHeight;
        if (!startHeight && stage && typeof stage.getBoundingClientRect === "function") {
          startHeight = Math.round(stage.getBoundingClientRect().height) || 320;
        }
        // 高度上限：允许超过可视区域（面板会滚动），给「放大预览」留足空间。
        var maxHeight = MAX_PREVIEW_HEIGHT;
        var pane = paneRef.current;
        var splitter = event.currentTarget;
        if (pane && typeof pane.getBoundingClientRect === "function") {
          var paneRect = pane.getBoundingClientRect();
          maxHeight = Math.min(MAX_PREVIEW_HEIGHT, Math.max(MIN_PREVIEW_HEIGHT, Math.round(paneRect.height) * 2));
        }
        splitDragRef.current = {
          startY: event.clientY,
          startHeight: startHeight,
          pointerId: event.pointerId,
          maxHeight: maxHeight,
        };
        try {
          if (event.currentTarget && event.currentTarget.setPointerCapture) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        } catch (error) {
          /* capture is best-effort */
        }
        if (event.preventDefault) event.preventDefault();
      }

      function onSplitterMove(event) {
        var drag = splitDragRef.current;
        if (!drag || !event) return;
        var delta = drag.startY - event.clientY;
        var next = clampPreviewHeight(drag.startHeight + delta);
        if (drag.maxHeight && next > drag.maxHeight) next = drag.maxHeight;
        drag.lastHeight = next;
        setPreviewHeight(next);
      }

      function onSplitterUp(event) {
        var drag = splitDragRef.current;
        if (!drag) return;
        splitDragRef.current = null;
        try {
          if (event && event.currentTarget && event.currentTarget.releasePointerCapture) {
            event.currentTarget.releasePointerCapture(drag.pointerId);
          }
        } catch (error) {
          /* ignore */
        }
        // 用拖动过程中记录的最新高度写入（同一事件批次里的 previewHeight 可能还是旧值）。
        var settled = drag.lastHeight || previewHeight;
        if (settled > 0) writeStored(STORE_ANDROID_PREVIEW_HEIGHT, settled);
      }

      function onSplitterKeyDown(event) {
        if (!event || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        if (event.preventDefault) event.preventDefault();
        var stage = stageRef.current;
        var current = previewHeight;
        if (!current && stage && typeof stage.getBoundingClientRect === "function") {
          current = Math.round(stage.getBoundingClientRect().height) || 320;
        }
        var next = clampPreviewHeight(current + (event.key === "ArrowUp" ? 40 : -40));
        setPreviewHeight(next);
        writeStored(STORE_ANDROID_PREVIEW_HEIGHT, next);
      }

      function resetPreviewHeight() {
        splitDragRef.current = null;
        setPreviewHeight(0);
        writeStored(STORE_ANDROID_PREVIEW_HEIGHT, null);
      }

      function choosePreviewZoom(id) {
        setZoomId(id);
        writeStored(STORE_ANDROID_PREVIEW_ZOOM, id);
      }

      // MJPEG <img> 断流/被 429 时换 token 重连（至少间隔 1.5s）。
      function retryMjpeg() {
        var now = Date.now();
        if (now - mjpegRetryRef.current < 1500) return;
        mjpegRetryRef.current = now;
        setMjpegToken(newMjpegToken());
      }

      var deviceOptions = [
        h("option", { value: "", key: "__none" }, devices.length === 0 ? tr("andrNoDevices") : tr("deskSelectPlaceholder")),
      ].concat(
        devices.map(function (device) {
          var serial = device && device.serial ? String(device.serial) : "";
          var label = serial;
          if (device && device.model) label = device.model + " · " + serial;
          if (device && device.state && device.state !== "device") label = label + " (" + device.state + ")";
          return h("option", { value: serial, key: serial }, label);
        })
      );

      function frameImage(src, key, style, onError) {
        return h("img", {
          key: key,
          ref: imgRef,
          className: "__lp_shot __lp_interactive",
          style: style || null,
          src: src,
          alt: tr("andrDevice"),
          draggable: false,
          onError: typeof onError === "function" ? onError : undefined,
          onPointerDown: onPointerDown,
          onPointerUp: onPointerUp,
          onPointerCancel: onPointerCancel,
          onContextMenu: function (event) {
            if (typeof event.preventDefault === "function") event.preventDefault();
          },
        });
      }

      var deviceWidth = resolution && resolution.width ? Number(resolution.width) : 0;
      var deviceHeight = resolution && resolution.height ? Number(resolution.height) : 0;
      var zoomScale = zoomId === "2" ? 2 : zoomId === "1" ? 1 : 0;
      var shotStyle = null;
      if (zoomScale > 0 && deviceWidth > 0) {
        shotStyle = {
          width: Math.round(deviceWidth * zoomScale) + "px",
          height: "auto",
          maxWidth: "none",
          maxHeight: "none",
        };
      }
      var stageStyle = previewHeight > 0 ? { height: previewHeight + "px", flex: "0 0 auto" } : null;
      var zoomButtons = [
        ["fit", tr("andrPreviewFit")],
        ["1", tr("andrPreview100")],
        ["2", tr("andrPreview200")],
      ].map(function (entry) {
        var active = zoomId === entry[0];
        return h(
          "button",
          {
            type: "button",
            key: "zoom-" + entry[0],
            className: "__lp_zoomBtn" + (active ? " __lp_zoomOn" : ""),
            "aria-pressed": active ? "true" : "false",
            onClick: function () {
              choosePreviewZoom(entry[0]);
            },
          },
          entry[1]
        );
      });
      // 专注模式下把常用的设备操作保留在预览条里，避免必须切回设置。
      var focusActions = [];
      if (focusMode && streaming) {
        [
          ["back", tr("andrBack")],
          ["home", tr("andrHome")],
          ["enter", tr("andrEnter")],
        ].forEach(function (entry) {
          focusActions.push(
            h(
              "button",
              {
                type: "button",
                key: "focus-key-" + entry[0],
                className: "__lp_zoomBtn",
                disabled: !deviceId,
                onClick: function () {
                  props.onAction("android.key", { key: entry[0] });
                },
              },
              entry[1]
            )
          );
        });
        focusActions.push(
          h(
            "button",
            {
              type: "button",
              key: "focus-stop",
              className: "__lp_zoomBtn",
              disabled: busy === "android.stop",
              onClick: function () {
                props.onAction("android.stop", {});
              },
            },
            tr("andrStop")
          )
        );
        focusActions.push(
          h(
            "button",
            {
              type: "button",
              key: "focus-restart",
              className: "__lp_zoomBtn",
              disabled: !deviceId || busy === "android.restart_app",
              onClick: function () {
                props.onAction("android.restart_app", {});
              },
            },
            tr("andrRestart")
          )
        );
      }

      var previewBar = h(
        "div",
        { className: "__lp_previewBar" },
        h("span", { className: "__lp_previewBarLabel" }, tr("andrPreviewLabel")),
        zoomButtons,
        focusActions,
        deviceWidth && deviceHeight
          ? h("span", { className: "__lp_mono" }, tr("andrResolution", { width: deviceWidth, height: deviceHeight }))
          : null,
        h("span", { className: "__lp_spacer" }),
        h(
          "button",
          {
            type: "button",
            className: "__lp_zoomBtn" + (focusMode ? " __lp_zoomOn" : ""),
            onClick: toggleFocusMode,
            "aria-pressed": focusMode ? "true" : "false",
            title: tr("andrPreviewResizeHint"),
          },
          focusMode ? tr("andrPreviewExitFocus") : tr("andrPreviewFocus")
        ),
        h(
          "button",
          {
            type: "button",
            className: "__lp_zoomBtn",
            onClick: resetPreviewHeight,
            title: tr("andrPreviewResizeHint"),
          },
          tr("andrPreviewReset")
        )
      );

      var stageBadges = null;
      if (streaming) {
        var fpsKnown = typeof streamInfo.fps === "number" && isFinite(streamInfo.fps);
        stageBadges = h(
          "div",
          { className: "__lp_stageBadges", key: "badges", "aria-live": "off" },
          h("span", { className: "__lp_chip" }, hdStream ? tr("andrModeH264") : tr("andrModeScreencap")),
          fpsKnown
            ? h(
                "span",
                {
                  className: "__lp_chip __lp_fps",
                  "data-tone": fpsTone,
                  title: tr("andrStreamFps", { fps: Math.round(fpsValue) }),
                },
                h("span", { className: "__lp_dot", "data-tone": fpsTone === "muted" ? "idle" : fpsTone }),
                tr("andrStreamFps", { fps: Math.round(fpsValue) })
              )
            : null
        );
      }

      var stage = null;
      if (!supported) {
        stage = h(EmptyState, { title: tr("andrEmptyTitle"), text: tr("andrUnsupported") });
      } else if (streaming) {
        if (hdStream) {
          stage = [
            frameImage(API + "/stream?target=android&t=" + encodeURIComponent(mjpegToken), "mjpeg", shotStyle, retryMjpeg),
            stageBadges,
          ];
        } else {
          stage = [
            stream.url
              ? frameImage(stream.url, "shot", shotStyle)
              : h(
                  "div",
                  { className: "__lp_empty", key: "waiting" },
                  h("span", { className: "__lp_spin" }),
                  h("span", null, tr("waitingFrame"))
                ),
            stageBadges,
            stream.error
              ? h("div", { className: "__lp_overlayErr", key: "err" }, tr("errFrame") + ": " + stream.error)
              : null,
          ];
        }
      } else if (emulatorInstalling) {
        stage = h(EmptyState, { title: tr("andrEmuInstallingTitle"), text: tr("andrEmuInstallWait") });
      } else if (emulatorLaunching) {
        stage = h(EmptyState, { title: tr("andrEmuLaunchingTitle"), text: tr("andrEmuLaunching") });
      } else if (!adb.available && !android.installing) {
        stage = h(EmptyState, { title: tr("andrAdbMissingTitle"), text: tr("andrAdbMissing") });
      } else {
        stage = h(EmptyState, {
          title: tr("andrEmptyTitle"),
          text: devices.length === 0 && adb.available ? tr("andrNoDevices") + " " + tr("andrEmpty") : tr("andrEmpty"),
        });
      }

      var adbInstallCard = null;
      if (supported && !adb.available && !emulatorInstalling) {
        adbInstallCard = h(
          "div",
          { className: "__lp_card" },
          h(
            "div",
            { className: "__lp_row" },
            android.installing
              ? h("span", { className: "__lp_spin" })
              : h(
                  "button",
                  {
                    type: "button",
                    className: "__lp_btn __lp_btnPrimary",
                    onClick: function () {
                      props.onAction("android.install", {});
                    },
                    disabled: android.installing || busy === "android.install",
                  },
                  tr("andrInstall")
                ),
            h(
              "span",
              { className: "__lp_hint" },
              android.installing ? tr("andrInstalling") : tr("andrAdbMissing")
            )
          ),
          h("div", { className: "__lp_hint" }, tr("andrInstallHint")),
          android.error
            ? h("div", { className: "__lp_hint __lp_hintWarn" }, String(android.error))
            : null,
          android.installError
            ? h("div", { className: "__lp_hint __lp_hintError" }, tr("andrInstallError", { error: String(android.installError) }))
            : null
        );
      }

      var emulatorCard = null;
      if (supported) {
        var emulatorError = emulator.lastError || emulator.error || null;
        if (!emulatorInstalled && !emulatorInstalling) {
          emulatorCard = h(
            "div",
            { className: "__lp_card" },
            h(
              "div",
              { className: "__lp_row" },
              h("span", { className: "__lp_label" }, tr("andrEmuTitle")),
              h(
                "button",
                {
                  type: "button",
                  className: "__lp_btn __lp_btnPrimary",
                  onClick: function () {
                    props.onAction("android.emulator.install", {});
                  },
                  disabled: busy === "android.emulator.install",
                },
                tr("andrEmuInstall")
              )
            ),
            h("div", { className: "__lp_hint" }, tr("andrEmuInstallHint")),
            emulatorError
              ? h("div", { className: "__lp_hint __lp_hintError" }, tr("andrEmuError", { error: String(emulatorError) }))
              : null
          );
        } else if (emulatorInstalling) {
          var percent = Number(progress.percent);
          if (!isFinite(percent)) percent = 0;
          percent = Math.min(100, Math.max(0, percent));
          var percentText = Math.round(percent) + "%";
          var stepText = progress.step ? String(progress.step) : tr("andrEmuInstalling");
          var counterText =
            progress.index || progress.total
              ? tr("andrEmuStep", { index: Number(progress.index) || 0, total: Number(progress.total) || 0 })
              : null;
          emulatorCard = h(
            "div",
            { className: "__lp_card" },
            h(
              "div",
              { className: "__lp_row" },
              h("span", { className: "__lp_spin" }),
              h("span", { className: "__lp_label" }, stepText),
              counterText ? h("span", { className: "__lp_mono" }, counterText) : null,
              h("span", { className: "__lp_spacer" }),
              h("span", { className: "__lp_mono" }, percentText)
            ),
            h(
              "div",
              {
                className: "__lp_progress",
                role: "progressbar",
                "aria-valuemin": 0,
                "aria-valuemax": 100,
                "aria-valuenow": Math.round(percent),
                "aria-label": tr("andrEmuInstalling"),
              },
              h("div", { className: "__lp_progressFill", style: { width: percentText } })
            ),
            h("div", { className: "__lp_hint" }, progress.detail ? String(progress.detail) : tr("andrEmuInstallWait")),
            emulatorError
              ? h("div", { className: "__lp_hint __lp_hintError" }, tr("andrEmuError", { error: String(emulatorError) }))
              : null
          );
        } else {
          var accelUsable = accel.usable === true;
          var accelChecked = accel.checked !== false;
          var accelMode = accel.mode && accel.mode !== "none" ? String(accel.mode) : "";
          var accelText = accelMode ? tr("andrEmuAccelOk", { mode: accelMode }) : tr("andrEmuAccelReady");
          var ffmpegAvailable = ffmpeg.available === true;
          var ffmpegInstalling = !!ffmpeg.installing || busy === "android.ffmpeg.install";
          var ffmpegProgress = ffmpeg.progress && typeof ffmpeg.progress === "object" ? ffmpeg.progress : {};
          var ffmpegPercent = Number(ffmpegProgress.percent);
          if (!isFinite(ffmpegPercent)) ffmpegPercent = 0;
          ffmpegPercent = Math.min(100, Math.max(0, ffmpegPercent));
          var startDisabled = !avdValue || emulatorLaunching || busy === "android.emulator.start";
          emulatorCard = h(
            "div",
            { className: "__lp_card" },
            h(
              "div",
              { className: "__lp_row" },
              h("span", { className: "__lp_label" }, tr("andrEmuAccelLabel")),
              accelUsable
                ? h(
                    "span",
                    { className: "__lp_hint" },
                    h("span", { className: "__lp_dot", "data-tone": "success" }),
                    h("span", null, accelText)
                  )
                : accelChecked
                  ? h(
                      "span",
                      { className: "__lp_hint __lp_hintWarn" },
                      h("span", { className: "__lp_dot", "data-tone": "warn" }),
                      h("span", null, tr("andrEmuAccelMissing"))
                    )
                  : h("span", { className: "__lp_hint" }, tr("andrEmuAccelChecking")),
              !accelUsable && accelChecked
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "__lp_btn",
                      onClick: function () {
                        props.onAction("android.emulator.accel.install", {});
                      },
                      disabled: busy === "android.emulator.accel.install",
                    },
                    tr("andrEmuAccelInstall")
                  )
                : null
            ),
            !accelUsable && accelChecked && accel.detail
              ? h("div", { className: "__lp_hint __lp_hintWarn" }, String(accel.detail))
              : null,
            h(
              "div",
              { className: "__lp_row" },
              h("span", { className: "__lp_label" }, tr("andrEmuFfmpegLabel")),
              ffmpegAvailable
                ? h(
                    "span",
                    { className: "__lp_hint" },
                    h("span", { className: "__lp_dot", "data-tone": "success" }),
                    h("span", null, tr("andrEmuFfmpegOk"))
                  )
                : ffmpegInstalling
                  ? h(
                      "span",
                      { className: "__lp_hint" },
                      h("span", { className: "__lp_spin" }),
                      h("span", null, tr("andrEmuFfmpegInstalling")),
                      ffmpegPercent > 0 ? h("span", { className: "__lp_mono" }, Math.round(ffmpegPercent) + "%") : null
                    )
                  : h(
                      "span",
                      { className: "__lp_hint __lp_hintWarn" },
                      h("span", { className: "__lp_dot", "data-tone": "warn" }),
                      h("span", null, tr("andrEmuFfmpegMissing"))
                    ),
              ffmpegAvailable || ffmpegInstalling
                ? null
                : h(
                    "button",
                    {
                      type: "button",
                      className: "__lp_btn",
                      onClick: function () {
                        props.onAction("android.ffmpeg.install", {});
                      },
                      disabled: ffmpegInstalling,
                    },
                    tr("andrEmuFfmpegInstall")
                  )
            ),
            h(
              "div",
              { className: "__lp_row" },
              h(
                "div",
                { className: "__lp_field" },
                h("span", { className: "__lp_label" }, tr("andrEmuAvd")),
                h(
                  "select",
                  {
                    className: "__lp_select",
                    value: avdValue,
                    onChange: function (event) {
                      setAvdDraft(event.target.value);
                    },
                    "aria-label": tr("andrEmuAvd"),
                    disabled: emulatorLaunching || emulatorInstalling,
                  },
                  avdNames.length === 0
                    ? [h("option", { value: "", key: "__none" }, tr("andrEmuNoAvd"))]
                    : avdNames.map(function (name) {
                        return h("option", { value: name, key: name }, name);
                      })
                )
              ),
              emulatorRunning
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "__lp_btn __lp_btnDanger",
                      onClick: function () {
                        props.onAction("android.emulator.stop", {});
                      },
                      disabled: busy === "android.emulator.stop",
                    },
                    tr("andrEmuStop")
                  )
                : h(
                    "button",
                    {
                      type: "button",
                      className: "__lp_btn __lp_btnPrimary",
                      onClick: function () {
                        props.onAction("android.emulator.start", { avd: avdValue || undefined });
                      },
                      disabled: startDisabled,
                    },
                    emulatorLaunching ? tr("andrEmuLaunchingShort") : tr("andrEmuStart")
                  )
            ),
            emulatorLaunching
              ? h(
                  "div",
                  { className: "__lp_hint" },
                  h("span", { className: "__lp_spin" }),
                  h("span", null, tr("andrEmuLaunching"))
                )
              : emulatorRunning
                ? h(
                    "div",
                    { className: "__lp_hint" },
                    h("span", { className: "__lp_dot", "data-tone": "success" }),
                    h("span", null, tr("andrEmuRunning")),
                    emulator.detail ? h("span", { className: "__lp_mono" }, String(emulator.detail)) : null
                  )
                : null,
            emulatorError
              ? h("div", { className: "__lp_hint __lp_hintError" }, tr("andrEmuError", { error: String(emulatorError) }))
              : null
          );
        }
      }

      var controlCard = null;
      if (supported && adb.available) {
        controlCard = h(
          "div",
          { className: "__lp_card" },
          h(
            "div",
            { className: "__lp_row" },
            h(
              "div",
              { className: "__lp_field" },
              h("span", { className: "__lp_label" }, tr("andrDevice")),
              h(
                "select",
                {
                  className: "__lp_select",
                  value: deviceId,
                  onChange: function (event) {
                    var serial = event.target.value;
                    if (!serial) return;
                    props.onAction("android.select", { serial: serial });
                  },
                  "aria-label": tr("andrDevice"),
                },
                deviceOptions
              )
            ),
            h(
              "button",
              {
                type: "button",
                className: "__lp_btn",
                onClick: function () {
                  props.onAction("android.devices", {});
                },
                disabled: busy === "android.devices",
              },
              tr("andrRefresh")
            ),
            streaming
              ? [
                  h(
                    "button",
                    {
                      key: "andr-stop",
                      type: "button",
                      className: "__lp_btn __lp_btnDanger",
                      onClick: function () {
                        props.onAction("android.stop", {});
                      },
                      disabled: busy === "android.stop",
                    },
                    tr("andrStop")
                  ),
                  h(
                    "button",
                    {
                      key: "andr-restart",
                      type: "button",
                      className: "__lp_btn",
                      onClick: function () {
                        props.onAction("android.restart_app", {});
                      },
                      disabled: !deviceId || busy === "android.restart_app",
                    },
                    tr("andrRestart")
                  ),
                ]
              : h(
                  "button",
                  {
                    type: "button",
                    className: "__lp_btn __lp_btnPrimary",
                    onClick: function () {
                      props.onAction("android.start", {});
                    },
                    disabled: !deviceId || busy === "android.start",
                  },
                  tr("andrStart")
                )
          ),
          h(
            "div",
            { className: "__lp_row" },
            h(
              "button",
              {
                type: "button",
                className: "__lp_btn",
                onClick: function () {
                  props.onAction("android.key", { key: "back" });
                },
                disabled: !deviceId,
              },
              tr("andrBack")
            ),
            h(
              "button",
              {
                type: "button",
                className: "__lp_btn",
                onClick: function () {
                  props.onAction("android.key", { key: "home" });
                },
                disabled: !deviceId,
              },
              tr("andrHome")
            ),
            h(
              "button",
              {
                type: "button",
                className: "__lp_btn",
                onClick: function () {
                  props.onAction("android.key", { key: "enter" });
                },
                disabled: !deviceId,
              },
              tr("andrEnter")
            ),
            h(
              "div",
              { className: "__lp_field" },
              h("input", {
                className: "__lp_input",
                type: "text",
                value: textDraft,
                placeholder: tr("andrTextPlaceholder"),
                onChange: function (event) {
                  setTextDraft(event.target.value);
                },
                onKeyDown: onTextKeyDown,
                "aria-label": tr("andrTextPlaceholder"),
              })
            ),
            h(
              "button",
              {
                type: "button",
                className: "__lp_btn",
                onClick: sendText,
                disabled: !deviceId || !String(textDraft || ""),
              },
              tr("andrSend")
            )
          ),
          h(
            "div",
            { className: "__lp_hint" },
            h("span", null, tr("andrDevicesCount", { count: devices.length })),
            resolution && resolution.width && resolution.height
              ? h("span", null, tr("andrResolution", { width: resolution.width, height: resolution.height }))
              : null,
            adb.version ? h("span", null, tr("andrVersion", { version: String(adb.version) })) : null,
            streaming ? h("span", null, tr("deskStreaming")) : null,
            android.lastFrameAt ? h("span", null, tr("deskLastFrame", { time: fmtAgo(android.lastFrameAt) })) : null,
            streaming ? h("span", null, tr("andrTapHint")) : null,
            android.error ? h("span", { className: "__lp_hintError" }, String(android.error)) : null
          )
        );
      }

      return h(
        "div",
        { className: "__lp_pane" + (previewHeight > 0 ? " __lp_paneScroll" : ""), ref: paneRef },
        focusMode ? null : emulatorCard,
        focusMode ? null : adbInstallCard,
        focusMode ? null : controlCard,
        previewBar,
        h(
          "div",
          {
            className: "__lp_splitter",
            role: "separator",
            tabIndex: 0,
            "aria-orientation": "horizontal",
            title: tr("andrPreviewResizeHint"),
            onPointerDown: onSplitterDown,
            onPointerMove: onSplitterMove,
            onPointerUp: onSplitterUp,
            onPointerCancel: onSplitterUp,
            onDoubleClick: resetPreviewHeight,
            onKeyDown: onSplitterKeyDown,
          },
          h("span", { className: "__lp_splitterGrip" })
        ),
        h(
          "div",
          {
            className: "__lp_stage" + (zoomScale > 0 ? " __lp_stageScroll" : ""),
            style: stageStyle,
            ref: stageRef,
          },
          stage
        )
      );
    }

    // //////////////////////////////////////////////////////////////////////
    // 版本选择 + 历史应用
    // //////////////////////////////////////////////////////////////////////

    function pad2(value) {
      return String(value).length < 2 ? "0" + String(value) : String(value);
    }

    function versionTimeLabel(ts) {
      if (!ts) return "";
      try {
        var date = new Date(Number(ts));
        if (isNaN(date.getTime())) return "";
        return (
          date.getFullYear() +
          "-" +
          pad2(date.getMonth() + 1) +
          "-" +
          pad2(date.getDate()) +
          " " +
          pad2(date.getHours()) +
          ":" +
          pad2(date.getMinutes())
        );
      } catch (error) {
        return "";
      }
    }

    function versionKindLabel(kind) {
      if (kind === "android") return tr("versionKindAndroid");
      if (kind === "windows") return tr("versionKindWindows");
      if (kind === "web") return tr("versionKindWeb");
      return String(kind || "");
    }

    /** “需要保留哪个版本？”——旧/新版本同时在跑时出现。 */
    function VersionChoiceBanner(props) {
      var choice = props.choice;
      var busy = !!props.busy;
      var remainState = useState(0);
      var remaining = remainState[0];
      var setRemaining = remainState[1];
      var closesAt = choice && choice.chosenId ? choice.closesAt : null;
      useEffect(
        function () {
          if (!closesAt) {
            setRemaining(0);
            return undefined;
          }
          function tick() {
            setRemaining(Math.max(0, Math.ceil((Number(closesAt) - Date.now()) / 1000)));
          }
          tick();
          var timer = setInterval(tick, 1000);
          return function () {
            clearInterval(timer);
          };
        },
        [closesAt]
      );
      if (!choice) return null;
      var oldVersion = choice.oldVersion || {};
      var newVersion = choice.newVersion || {};
      function keep(versionId) {
        postAction("app.version.choose", { versionId: versionId }).catch(function () {});
        if (typeof props.onChanged === "function") props.onChanged();
      }
      var body;
      if (choice.chosenId) {
        var kept = choice.chosenNew ? newVersion : oldVersion;
        body = h(
          "div",
          { className: "__lp_choiceDesc" },
          tr("keepChosen", { name: kept.name || "" }),
          remaining > 0 ? " · " + tr("keepCloseIn", { seconds: remaining }) : ""
        );
      } else {
        body = h(
          "div",
          { className: "__lp_choiceRow" },
          h(
            "button",
            { type: "button", className: "__lp_versionBtn", disabled: busy, onClick: function () { keep(oldVersion.id); } },
            h("span", null, tr("keepOldVersion")),
            h("span", { className: "__lp_versionBtnSub" }, (oldVersion.name || "") + " · " + versionTimeLabel(oldVersion.createdAt) + " · " + formatBytes(oldVersion.size))
          ),
          h(
            "button",
            { type: "button", className: "__lp_versionBtn", disabled: busy, onClick: function () { keep(newVersion.id); } },
            h("span", null, tr("keepNewVersion")),
            h("span", { className: "__lp_versionBtnSub" }, (newVersion.name || "") + " · " + versionTimeLabel(newVersion.createdAt) + " · " + formatBytes(newVersion.size))
          )
        );
      }
      return h(
        "div",
        { className: "__lp_choice" },
        h("div", { className: "__lp_choiceTitle" }, tr("needKeepTitle")),
        h("div", { className: "__lp_choiceDesc" }, tr("needKeepDesc")),
        body
      );
    }

    /** 历史应用：所有导入过的版本，可标记/删除。 */
    function formatBytes(bytes) {
      var value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return "—";
      if (value < 1024) return value + " B";
      var kb = value / 1024;
      if (kb < 1024) return Math.round(kb * 10) / 10 + " KB";
      var mb = kb / 1024;
      if (mb < 1024) return Math.round(mb * 10) / 10 + " MB";
      return Math.round((mb / 1024) * 100) / 100 + " GB";
    }

    /** 版本切换中的加载文案：按阶段显示（启模拟器 / 装包 / 启动）。 */
    function versionOpeningText(opening) {
      if (!opening) return "";
      var name = opening.name || "";
      if (opening.phase === "emulator") return tr("versionOpeningEmulator");
      if (opening.phase === "install") return tr("versionOpeningInstall", { name: name });
      return tr("versionOpeningLoading", { name: name });
    }

    /** 历史应用：所有导入过的版本，可点击运行、标记、删除。 */
    function VersionHistoryModal(props) {
      var versions = props.versions || [];
      var assignTarget = props.sessionId || null;
      var unassigned = versions.filter(function (version) {
        return !version.sessionId;
      });
      function refreshSoon() {
        if (typeof props.onChanged !== "function") return;
        props.onChanged();
        try {
          setTimeout(props.onChanged, 2500);
          setTimeout(props.onChanged, 9000);
        } catch (error) {
          /* ignore */
        }
      }
      function assignToSession(list) {
        if (!assignTarget || !list || list.length === 0) return;
        postAction("app.version.assign_session", {
          versionIds: list.map(function (version) {
            return version.id;
          }),
          sessionId: assignTarget,
        })
          .then(function () {
            refreshSoon();
          })
          .catch(function () {});
      }
      function run(version) {
        // 选好版本后立刻关掉历史窗口，预览区改为加载动画，等新程序启动完成。
        if (typeof props.onClose === "function") props.onClose();
        postAction("app.version.open", { versionId: version.id })
          .then(function () {
            refreshSoon();
          })
          .catch(function () {});
      }
      function mark(version) {
        postAction("app.version.mark", { versionId: version.id, marked: !version.marked })
          .then(function () {
            if (typeof props.onChanged === "function") props.onChanged();
          })
          .catch(function () {});
      }
      function remove(version) {
        var ok = true;
        try {
          ok = window.confirm(tr("versionDeleteConfirm"));
        } catch (error) {
          ok = true;
        }
        if (!ok) return;
        postAction("app.version.delete", { versionId: version.id })
          .then(function () {
            if (typeof props.onChanged === "function") props.onChanged();
          })
          .catch(function () {});
      }
      var mode = props.mode === "session" ? "session" : "all";
      var sessionId = props.sessionId || null;
      var titles = props.sessionTitles || {};
      var visible = versions.filter(function (version) {
        if (mode !== "session") return true;
        return !!sessionId && version.sessionId === sessionId;
      });
      function renderRow(version) {
        var meta =
          versionKindLabel(version.kind) +
          " · " +
          versionTimeLabel(version.createdAt) +
          " · " +
          formatBytes(version.size) +
          (version.running || version.active ? " · " + tr("versionRunning") : "");
        return h(
          "div",
          {
            key: version.id,
            className: "__lp_versionRow",
            role: "button",
            tabIndex: 0,
            title: tr("historyHint"),
            "aria-label": (version.name || version.id) + " " + tr("versionRunHint"),
            onClick: function () {
              run(version);
            },
            onKeyDown: function (event) {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                run(version);
              }
            },
          },
          h("span", { className: "__lp_star", title: version.marked ? tr("versionUnmark") : tr("versionMark") }, version.marked ? "★" : "☆"),
          h(
            "div",
            { className: "__lp_versionMain" },
            h(
              "span",
              { className: "__lp_versionName" },
              version.name || version.id,
              version.latest ? h("span", { className: "__lp_versionBadge" }, tr("versionLatest")) : null
            ),
            h("span", { className: "__lp_versionMeta" }, meta)
          ),
          !version.sessionId && assignTarget
            ? h(
                "button",
                {
                  type: "button",
                  className: "__lp_zoomBtn",
                  onClick: function (event) {
                    event.stopPropagation();
                    assignToSession([version]);
                  },
                },
                tr("versionAssign")
              )
            : null,
          h(
            "button",
            {
              type: "button",
              className: "__lp_zoomBtn",
              onClick: function (event) {
                event.stopPropagation();
                mark(version);
              },
            },
            version.marked ? tr("versionUnmark") : tr("versionMark")
          ),
          h(
            "button",
            {
              type: "button",
              className: "__lp_btn __lp_btnDanger",
              onClick: function (event) {
                event.stopPropagation();
                remove(version);
              },
            },
            tr("versionDelete")
          )
        );
      }
      // 按对话分组（主面板看全部对话；右侧栏只看当前对话）。
      var groups = [];
      var groupMap = {};
      visible.forEach(function (version) {
        var key = version.sessionId || "__none__";
        var group = groupMap[key];
        if (!group) {
          group = { key: key, sessionId: version.sessionId || null, versions: [], latestAt: 0 };
          groupMap[key] = group;
          groups.push(group);
        }
        group.versions.push(version);
        group.latestAt = Math.max(group.latestAt, Number(version.createdAt) || 0);
      });
      groups.sort(function (left, right) {
        return right.latestAt - left.latestAt;
      });
      var rows = [];
      groups.forEach(function (group) {
        if (mode === "all") {
          var title = group.sessionId
            ? titles[group.sessionId] || tr("versionSession", { id: String(group.sessionId).slice(0, 8) })
            : tr("versionUngrouped");
          rows.push(
            h(
              "div",
              { key: "group-" + group.key, className: "__lp_versionGroup" },
              h("span", { className: "__lp_versionGroupTitle" }, title),
              h(
                "span",
                { className: "__lp_versionMeta" },
                versionTimeLabel(group.latestAt) + " · " + tr("versionCount", { count: group.versions.length })
              ),
              group.sessionId || !assignTarget
                ? null
                : h(
                    "button",
                    {
                      type: "button",
                      className: "__lp_zoomBtn",
                      onClick: function () {
                        assignToSession(group.versions);
                      },
                    },
                    tr("versionAssignAll")
                  )
            )
          );
        }
        group.versions.forEach(function (version) {
          rows.push(renderRow(version));
        });
      });
      return h(
        "div",
        {
          className: "__lp_modalBackdrop",
          onClick: function (event) {
            if (event.target === event.currentTarget && typeof props.onClose === "function") props.onClose();
          },
        },
        h(
          "div",
          { className: "__lp_modal" },
          h(
            "div",
            { className: "__lp_modalHead" },
            h("span", { className: "__lp_modalTitle" }, tr("historyApps")),
            h("span", { className: "__lp_spacer" }),
            h(
              "button",
              { type: "button", className: "__lp_btn", onClick: function () { if (typeof props.onClose === "function") props.onClose(); } },
              tr("dismiss")
            )
          ),
          h(
            "div",
            { className: "__lp_modalBody" },
            visible.length > 0
              ? [
                  h(
                    "div",
                    { key: "history-hint", className: "__lp_importHint" },
                    mode === "session" ? tr("historySessionHint") : tr("historyHint")
                  ),
                  rows,
                ]
              : h(
                  "div",
                  { className: "__lp_importHint" },
                  mode === "session" ? tr("historySessionEmpty") : tr("historyEmpty"),
                  mode === "session" && assignTarget && unassigned.length > 0
                    ? h(
                        "div",
                        { style: { marginTop: "8px" } },
                        h(
                          "button",
                          {
                            type: "button",
                            className: "__lp_btn",
                            onClick: function () {
                              assignToSession(unassigned);
                            },
                          },
                          tr("versionAssignUngrouped", { count: unassigned.length })
                        )
                      )
                    : null
                )
          )
        )
      );
    }

    // //////////////////////////////////////////////////////////////////////
    // Right sidebar preview — 让应用画面和对话同时显示
    // //////////////////////////////////////////////////////////////////////

    var PREVIEW_TAB_ID = "dsh-live-preview/preview";
    var PREVIEW_TAB_KIND = "dsh-live-preview-preview";
    var rightTabController = null;
    var layoutApi = null;
    var clientCtx = null;
    /** 最近一次已知的“当前会话 id”（右侧预览挂载时更新），供主面板导入时关联对话。 */
    var lastKnownSessionId = null;

    function selectAllSessions(state) {
      return state;
    }

    /** 从 useSessions 快照中取 id → 会话标题。 */
    function sessionsTitleMap(sessionState) {
      var map = {};
      try {
        if (sessionState && sessionState.byId) {
          Object.keys(sessionState.byId).forEach(function (id) {
            var row = sessionState.byId[id];
            map[id] = (row && (row.displayTitle || row.title)) || id;
          });
        }
      } catch (error) {
        /* ignore */
      }
      return map;
    }

    /** 打开右侧「实时预览」标签（与会话并排）；服务晚到时现取一次。 */
    function openRightPreviewTab() {
      try {
        var controller = rightTabController;
        if (!controller && clientCtx && typeof clientCtx.get === "function") {
          controller = clientCtx.get("sidebarRight") || null;
        }
        if (controller && typeof controller.openTab === "function") {
          rightTabController = controller;
          controller.openTab(PREVIEW_TAB_KIND);
          return true;
        }
      } catch (error) {
        /* ignore */
      }
      return false;
    }

    /** 切回主面板（右侧栏里的“打开主面板”入口）；layout 服务晚到时现取一次。 */
    function openMainPanel() {
      try {
        var api = layoutApi;
        if (!api && clientCtx && typeof clientCtx.get === "function") api = clientCtx.get("layout") || null;
        if (api && typeof api.selectPanel === "function") {
          layoutApi = api;
          api.selectPanel("live-preview");
          return true;
        }
      } catch (error) {
        /* ignore */
      }
      return false;
    }

    function describeImport(data) {
      var imported = (data && data.import) || {};
      var info = (data && data.info) || {};
      if (imported.kind === "android") {
        return tr("importKindAndroid") + (imported.packageName ? " · " + imported.packageName : "");
      }
      if (imported.kind === "windows") {
        return tr("importKindWindows") + (imported.title ? " · " + imported.title : imported.arch ? " · " + imported.arch : "");
      }
      if (imported.kind === "web") return tr("importKindWeb");
      if (info.kind) return info.kind;
      return tr("importRunning");
    }

    function ImportBar(props) {
      var compact = !!props.compact;
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var percentState = useState(0);
      var percent = percentState[0];
      var setPercent = percentState[1];
      var msgState = useState(null);
      var msg = msgState[0];
      var setMsg = msgState[1];
      var errState = useState(null);
      var err = errState[0];
      var setErr = errState[1];
      var fileState = useState(null);
      var fileName = fileState[0];
      var setFileName = fileState[1];
      var inputRef = useRef(null);
      var alive = useAlive();

      function choose() {
        if (busy) return;
        if (inputRef.current && typeof inputRef.current.click === "function") inputRef.current.click();
      }

      function upload(file) {
        setBusy(true);
        setPercent(0);
        setErr(null);
        setMsg(null);
        setFileName(file.name);
        var xhr = new XMLHttpRequest();
        var query = "?name=" + encodeURIComponent(file.name);
        if (props.sessionId) query += "&sessionId=" + encodeURIComponent(props.sessionId);
        xhr.open("POST", API + "/import" + query);
        xhr.upload.onprogress = function (event) {
          if (event && event.lengthComputable && event.total > 0) {
            setPercent(Math.min(99, Math.round((event.loaded / event.total) * 100)));
          }
        };
        xhr.onload = function () {
          if (!alive.current) return;
          setBusy(false);
          setPercent(100);
          var data = null;
          try {
            data = JSON.parse(xhr.responseText || "{}");
          } catch (error) {
            data = null;
          }
          if (!data || data.ok !== true) {
            setErr(tr("importFailed", { error: (data && data.error) || "HTTP " + xhr.status }));
            return;
          }
          setMsg(tr("importDone", { detail: describeImport(data) }));
          if (typeof props.onImported === "function") props.onImported(data);
        };
        xhr.onerror = function () {
          if (!alive.current) return;
          setBusy(false);
          setErr(tr("importFailed", { error: "network" }));
        };
        xhr.send(file);
      }

      function onChange(event) {
        var file = event && event.target && event.target.files ? event.target.files[0] : null;
        if (file) upload(file);
        if (event && event.target) event.target.value = "";
      }

      var status = null;
      if (busy) status = tr("importUploading", { percent: percent });
      else if (msg) status = msg;
      else if (err) status = err;

      return h(
        "div",
        { className: "__lp_import" },
        h("input", {
          type: "file",
          ref: inputRef,
          className: "__lp_hiddenInput",
          accept: ".apk,.exe,.msi,.zip,.html,.htm",
          onChange: onChange,
          "aria-hidden": "true",
          tabIndex: -1,
        }),
        h(
          "div",
          { className: "__lp_importRow" },
          h(
            "button",
            {
              type: "button",
              className: "__lp_btn __lp_btnPrimary",
              onClick: choose,
              disabled: busy,
            },
            busy ? tr("importRunning") : tr("importTitle")
          ),
          fileName ? h("span", { className: "__lp_importFile" }, fileName) : null,
          status
            ? h(
                "span",
                { className: err && !busy ? "__lp_importErr" : "__lp_importHint" },
                status
              )
            : null
        ),
        busy || (percent > 0 && percent < 100)
          ? h("div", { className: "__lp_progress" }, h("div", { className: "__lp_progressFill", style: { width: percent + "%" } }))
          : null,
        compact ? null : h("div", { className: "__lp_importHint" }, tr("importHint"))
      );
    }

    /** 右侧栏轻量状态轮询（1.2s，不阻塞主面板）。 */
    function useRightState() {
      var state = useState(null);
      var snap = state[0];
      var setSnap = state[1];
      useEffect(function () {
        var stopped = false;
        var timer = null;
        var controller = null;
        function load() {
          controller = new AbortController();
          fetch(API + "/state?_=" + Date.now(), { signal: controller.signal, cache: "no-store" })
            .then(function (response) {
              return response.json();
            })
            .then(function (data) {
              if (!stopped) setSnap(data);
            })
            .catch(function () {})
            .then(function () {
              if (!stopped) timer = setTimeout(load, 1200);
            });
        }
        load();
        return function () {
          stopped = true;
          if (timer) clearTimeout(timer);
          if (controller) controller.abort();
        };
      }, []);
      return snap;
    }

    function RightPreviewTab(props) {
      var snap = useRightState();
      var android = (snap && snap.android) || {};
      var streamInfo = android.stream || {};
      var resolution = android.resolution || null;
      var desk = (snap && snap.desk) || {};
      var web = (snap && snap.web) || {};
      var app = (snap && snap.app) || {};
      var versions = Array.isArray(app.versions) ? app.versions : [];
      var versionChoice = app.versionChoice || null;
      var currentSessionId = (props && props.sessionId) || null;
      var visibleChoice = versionChoice && versionChoice.sessionId && versionChoice.sessionId === currentSessionId ? versionChoice : null;
      var sessionState = null;
      try {
        if (props && typeof props.useSessions === "function") sessionState = props.useSessions(selectAllSessions);
      } catch (error) {
        sessionState = null;
      }
      var sessionTitles = sessionsTitleMap(sessionState);
      var historyState = useState(false);
      var historyOpen = historyState[0];
      var setHistoryOpen = historyState[1];
      var streamingAndroid = !!android.streaming;
      var hdStream = streamingAndroid && streamInfo.mode === "h264";
      var targetKind = streamingAndroid ? "android" : desk.streaming ? "desk" : web.url ? "web" : null;

      // 右侧栏里的模拟器开关：没启动就拉起，运行中就停掉。
      var emulator = android.emulator && typeof android.emulator === "object" ? android.emulator : {};
      var emulatorRunning = !!emulator.running || !!android.device;
      var emulatorBusy =
        !!emulator.installing || !!emulator.launching || !!emulator.starting || !!emulator.stopping;
      var emulatorAvd = Array.isArray(emulator.avds) && emulator.avds[0] ? emulator.avds[0].name : null;
      var openingPhase = app.versionOpening && app.versionOpening.phase;
      var emuErrState = useState(null);
      var emuErr = emuErrState[0];
      var setEmuErr = emuErrState[1];
      var emuPendingState = useState(false);
      var emuPending = emuPendingState[0];
      var setEmuPending = emuPendingState[1];
      function toggleEmulator() {
        if (emuPending) return;
        setEmuErr(null);
        setEmuPending(true);
        var actionName = emulatorRunning ? "android.emulator.stop" : "android.emulator.start";
        var payload = emulatorRunning ? {} : { avd: emulatorAvd || undefined };
        postAction(actionName, payload)
          .catch(function (error) {
            setEmuErr(tr("andrEmuError", { error: (error && (error.message || error.detail)) || "" }));
          })
          .then(function () {
            setEmuPending(false);
          });
      }
      var emuLabel = emuPending || emulatorBusy || openingPhase === "emulator"
        ? tr("emulatorStartingShort")
        : emulatorRunning
          ? tr("andrEmuStop")
          : tr("andrEmuStart");

      var mjpegState = useState(newMjpegToken);
      var mjpegToken = mjpegState[0];
      var setMjpegToken = mjpegState[1];
      var mjpegFailState = useState(null);
      var mjpegFail = mjpegFailState[0];
      var setMjpegFail = mjpegFailState[1];
      var mjpegTries = useRef(0);
      var mjpegTimer = useRef(null);
      var hdPrev = useRef(hdStream);
      var imgRef = useRef(null);
      var dragRef = useRef(null);
      var androidFrames = useFrameStream("android", streamingAndroid && !hdStream);
      var deskFrames = useFrameStream("desk", !!desk.streaming);

      // 记住当前会话，供主面板里的导入关联到对话。
      useEffect(
        function () {
          if (currentSessionId) lastKnownSessionId = currentSessionId;
        },
        [currentSessionId]
      );

      useEffect(
        function () {
          return function () {
            if (mjpegTimer.current) clearTimeout(mjpegTimer.current);
            // 卸载时主动断开 MJPEG（把 <img> 的 src 摘掉），避免热更新/切页留下僵尸连接占满配额。
            try {
              if (imgRef.current) imgRef.current.removeAttribute("src");
            } catch (error) {
              /* ignore */
            }
          };
        },
        []
      );

      useEffect(
        function () {
          if (hdStream && !hdPrev.current) {
            mjpegTries.current = 0;
            setMjpegFail(null);
            setMjpegToken(newMjpegToken());
          }
          hdPrev.current = hdStream;
        },
        [hdStream]
      );

      function devicePoint(event) {
        var img = imgRef.current;
        if (!img || typeof img.getBoundingClientRect !== "function") return null;
        var rect = img.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) return null;
        var width = resolution && resolution.width ? Number(resolution.width) : 0;
        var height = resolution && resolution.height ? Number(resolution.height) : 0;
        if (!width || !height) {
          width = img.naturalWidth || 0;
          height = img.naturalHeight || 0;
        }
        if (!width || !height) return null;
        var x = Math.round(((event.clientX - rect.left) * width) / rect.width);
        var y = Math.round(((event.clientY - rect.top) * height) / rect.height);
        x = Math.min(width - 1, Math.max(0, x));
        y = Math.min(height - 1, Math.max(0, y));
        return { x: x, y: y, width: width, height: height, at: Date.now() };
      }

      function onPointerDown(event) {
        if (targetKind !== "android") return;
        dragRef.current = devicePoint(event) ? Object.assign(devicePoint(event), { startX: event.clientX, startY: event.clientY }) : null;
        try {
          if (event.currentTarget && event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
        } catch (error) {
          /* ignore */
        }
      }

      function onPointerUp(event) {
        if (targetKind !== "android" || !dragRef.current) return;
        var start = dragRef.current;
        dragRef.current = null;
        var moved = Math.abs(event.clientX - start.startX) > 6 || Math.abs(event.clientY - start.startY) > 6;
        var end = devicePoint(event);
        if (!end) return;
        if (moved) {
          var duration = Math.min(2000, Math.max(60, Date.now() - start.at));
          postAction("android.swipe", { x1: start.x, y1: start.y, x2: end.x, y2: end.y, durationMs: duration }).catch(function () {});
        } else {
          postAction("android.tap", { x: start.x, y: start.y }).catch(function () {});
        }
      }

      function retryMjpeg() {
        mjpegTries.current = 0;
        setMjpegFail(null);
        setMjpegToken(newMjpegToken());
      }

      /** 失败最多自动重试 2 次，之后交给用户点「重试」，避免 429 时无限重连。 */
      function onMjpegError() {
        mjpegTries.current += 1;
        if (mjpegTries.current <= 2) {
          if (mjpegTimer.current) clearTimeout(mjpegTimer.current);
          mjpegTimer.current = setTimeout(function () {
            setMjpegToken(newMjpegToken());
          }, 1000);
        } else {
          setMjpegFail(tr("previewBusy"));
        }
      }

      function onMjpegLoad() {
        mjpegTries.current = 0;
        setMjpegFail(null);
      }

      var versionOpening = app.versionOpening || null;
      var stage = null;
      if (versionOpening) {
        // 正在切换版本：旧画面立刻换成加载动画，直到新程序启动完成。
        stage = h(
          "div",
          { className: "__lp_empty" },
          h("span", { className: "__lp_spin" }),
          h("span", null, versionOpeningText(versionOpening))
        );
      } else if (hdStream) {
        stage = [
          h("img", {
            key: "mjpeg-" + mjpegToken,
            ref: imgRef,
            className: "__lp_shot __lp_interactive",
            src: API + "/stream?target=android&t=" + encodeURIComponent(mjpegToken),
            alt: tr("rightTitleAndroid"),
            draggable: false,
            onLoad: onMjpegLoad,
            onError: onMjpegError,
            onPointerDown: onPointerDown,
            onPointerUp: onPointerUp,
            onPointerCancel: function () {
              dragRef.current = null;
            },
          }),
          mjpegFail
            ? h(
                "div",
                { className: "__lp_stageNote" },
                h("span", null, mjpegFail),
                h(
                  "button",
                  { type: "button", className: "__lp_zoomBtn", onClick: retryMjpeg },
                  tr("retry")
                )
              )
            : null,
        ];
      } else if (streamingAndroid && androidFrames.url) {
        stage = h("img", {
          ref: imgRef,
          className: "__lp_shot __lp_interactive",
          src: androidFrames.url,
          alt: tr("rightTitleAndroid"),
          draggable: false,
          onPointerDown: onPointerDown,
          onPointerUp: onPointerUp,
        });
      } else if (desk.streaming && deskFrames.url) {
        stage = h("img", { className: "__lp_shot", src: deskFrames.url, alt: tr("rightTitleDesk"), draggable: false });
      } else if (web.url) {
        stage = h("iframe", { className: "__lp_frame", src: web.url, title: tr("rightTitleWeb") });
      } else if (app.importing) {
        stage = h("div", { className: "__lp_empty" }, h("span", { className: "__lp_spin" }), h("span", null, tr("importRunning")));
      } else {
        stage = h(
          "div",
          { className: "__lp_empty" },
          h("span", { className: "__lp_emptyTitle" }, tr("rightEmpty")),
          h(
            "button",
            { type: "button", className: "__lp_btn", onClick: openMainPanel },
            tr("openMainPanel")
          )
        );
      }

      var fps = Number(streamInfo.fps) || 0;
      var fpsTone = fps >= 30 ? "success" : fps >= 15 ? "warn" : "muted";
      var title = targetKind === "android" ? tr("rightTitleAndroid") : targetKind === "desk" ? tr("rightTitleDesk") : targetKind === "web" ? tr("rightTitleWeb") : tr("panel");

      var keyButtons = null;
      if (targetKind === "android") {
        keyButtons = [
          ["back", tr("andrBack")],
          ["home", tr("andrHome")],
          ["enter", tr("andrEnter")],
        ].map(function (entry) {
          return h(
            "button",
            {
              key: "right-key-" + entry[0],
              type: "button",
              className: "__lp_zoomBtn",
              onClick: function () {
                postAction("android.key", { key: entry[0] }).catch(function () {});
              },
            },
            entry[1]
          );
        });
        keyButtons.push(
          h(
            "button",
            {
              key: "right-stop",
              type: "button",
              className: "__lp_zoomBtn",
              onClick: function () {
                postAction("android.stop", {}).catch(function () {});
              },
            },
            tr("andrStop")
          )
        );
        keyButtons.push(
          h(
            "button",
            {
              key: "right-restart",
              type: "button",
              className: "__lp_zoomBtn",
              onClick: function () {
                postAction("android.restart_app", {}).catch(function () {});
              },
            },
            tr("andrRestart")
          )
        );
      }

      return h(
        "div",
        { className: "__lp_rightTab" },
        h(
          "div",
          { className: "__lp_rightHead" },
          h("span", { className: "__lp_dot", "data-tone": targetKind ? "success" : "idle" }),
          h("span", null, title),
          streamingAndroid ? h("span", { className: "__lp_chip __lp_fps", "data-tone": fpsTone }, tr("andrStreamFps", { fps: Math.round(fps) })) : null,
          h("span", { className: "__lp_spacer" }),
          h(
            "button",
            {
              type: "button",
              className: "__lp_zoomBtn",
              onClick: toggleEmulator,
              disabled: emulatorBusy,
              title: emulatorRunning ? tr("andrEmuStop") : tr("andrEmuStart"),
            },
            emuLabel
          ),
          h(
            "button",
            { type: "button", className: "__lp_zoomBtn", onClick: function () { setHistoryOpen(true); }, title: tr("historyApps") },
            tr("historyApps")
          ),
          h(
            "button",
            { type: "button", className: "__lp_zoomBtn", onClick: openMainPanel, title: tr("panel") },
            tr("openMainPanel")
          )
        ),
        emuErr ? h("div", { className: "__lp_hint" }, emuErr) : null,
        visibleChoice ? h(VersionChoiceBanner, { choice: visibleChoice }) : null,
        h("div", { className: "__lp_rightStage" }, stage),
        keyButtons && keyButtons.length > 0 ? h("div", { className: "__lp_rightBar" }, keyButtons) : null,
        h(ImportBar, { sessionId: currentSessionId, onImported: function () { retryMjpeg(); } }),
        historyOpen
          ? h(VersionHistoryModal, {
              versions: versions,
              mode: "session",
              sessionId: currentSessionId,
              sessionTitles: sessionTitles,
              onClose: function () {
                setHistoryOpen(false);
              },
            })
          : null
      );
    }

    // //////////////////////////////////////////////////////////////////////
    // Main panel
    // //////////////////////////////////////////////////////////////////////

    function LivePreviewPage(props) {
      var snapState = useState(null);
      var snap = snapState[0];
      var setSnap = snapState[1];
      var sessionState = null;
      try {
        if (props && typeof props.useSessions === "function") sessionState = props.useSessions(selectAllSessions);
      } catch (error) {
        sessionState = null;
      }
      var sessionTitles = sessionsTitleMap(sessionState);
      var currentSessionId = (props && props.sessionId) || lastKnownSessionId || null;
      var tabState = useState("web");
      var tab = tabState[0];
      var setTab = tabState[1];
      var logsState = useState([]);
      var logs = logsState[0];
      var setLogs = logsState[1];
      var openState = useState(true);
      var logOpen = openState[0];
      var setLogOpen = openState[1];
      var busyState = useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var actErrState = useState(null);
      var actErr = actErrState[0];
      var setActErr = actErrState[1];
      var linkErrState = useState(null);
      var linkErr = linkErrState[0];
      var setLinkErr = linkErrState[1];
      var reloadState = useState(0);
      var reloadKey = reloadState[0];
      var setReloadKey = reloadState[1];
      var historyState = useState(false);
      var historyOpen = historyState[0];
      var setHistoryOpen = historyState[1];

      var aliveRef = useAlive();
      var sinceRef = useRef(0);
      var clearedRef = useRef(0);
      var refreshRef = useRef(null);
      var fastPollRef = useRef(false);
      var rescheduleRef = useRef(null);

      // State + base log tail: one self-scheduling poll for the whole page.
      // The delay is read from a ref, so the fast install/launch cadence can
      // change without tearing the loop down. poll() is a no-op while a
      // request is already in flight.
      useEffect(function () {
        var stopped = false;
        var timer = null;
        var ctrl = null;
        var failures = 0;
        var inFlight = false;

        function schedule() {
          if (stopped) return;
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(function () {
            timer = null;
            poll();
          }, fastPollRef.current ? FAST_STATE_INTERVAL_MS : STATE_INTERVAL_MS);
        }

        function poll() {
          if (stopped || inFlight) return;
          inFlight = true;
          ctrl = new AbortController();
          fetch(API + "/state?_=" + Date.now(), { signal: ctrl.signal, cache: "no-store" })
            .then(function (res) {
              return res.text().then(function (text) {
                var data = null;
                if (text) {
                  try {
                    data = JSON.parse(text);
                  } catch (parseError) {
                    data = null;
                  }
                }
                if (!res.ok || data === null || data.ok === false) {
                  throw new Error((data && data.error) || "HTTP " + res.status);
                }
                return data;
              });
            })
            .then(function (data) {
              if (stopped) return;
              failures = 0;
              setSnap(data);
              setLinkErr(null);
              if (Array.isArray(data.logs) && data.logs.length > 0) {
                var last = data.logs[data.logs.length - 1];
                if (last && typeof last.seq === "number" && last.seq > sinceRef.current) sinceRef.current = last.seq;
                appendLogs(data.logs);
              }
            })
            .catch(function (error) {
              if (stopped || (error && error.name === "AbortError")) return;
              failures += 1;
              if (failures >= 2) setLinkErr(errText(error));
            })
            .then(function () {
              inFlight = false;
              schedule();
            });
        }

        refreshRef.current = poll;
        rescheduleRef.current = function () {
          if (!inFlight) schedule();
        };
        poll();

        return function () {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          if (ctrl !== null) ctrl.abort();
          refreshRef.current = null;
          rescheduleRef.current = null;
        };
      }, []);

      // Simulator install / launch (and adb install) need tighter feedback:
      // poll /state every 500 ms instead of 1 s while one is in flight.
      var fastPoll = false;
      if (snap && snap.android) {
        var snapAndroid = snap.android;
        var snapEmulator =
          snapAndroid.emulator && typeof snapAndroid.emulator === "object" ? snapAndroid.emulator : {};
        var snapStream = snapAndroid.stream && typeof snapAndroid.stream === "object" ? snapAndroid.stream : {};
        fastPoll =
          !!snapAndroid.installing ||
          !!snapEmulator.installing ||
          !!snapEmulator.launching ||
          !!snapEmulator.starting ||
          !!snapStream.starting ||
          snapStream.mode === "starting";
      }

      useEffect(
        function () {
          fastPollRef.current = fastPoll;
          if (typeof rescheduleRef.current === "function") rescheduleRef.current();
        },
        [fastPoll]
      );

      var running = false;
      if (snap && snap.run && (snap.run.status === "starting" || snap.run.status === "running")) running = true;

      // Incremental log tail while a command runs.
      useEffect(
        function () {
          if (!running) return undefined;
          var stopped = false;
          var ctrl = null;

          function tick() {
            if (stopped) return;
            ctrl = new AbortController();
            fetch(API + "/logs?since=" + sinceRef.current, { signal: ctrl.signal, cache: "no-store" })
              .then(function (res) {
                if (!res.ok) return null;
                return res.text();
              })
              .then(function (text) {
                if (stopped || !text) return;
                var data = null;
                try {
                  data = JSON.parse(text);
                } catch (parseError) {
                  data = null;
                }
                if (!data || data.ok === false) return;
                if (typeof data.nextSeq === "number" && data.nextSeq > sinceRef.current) sinceRef.current = data.nextSeq;
                if (Array.isArray(data.lines) && data.lines.length > 0) appendLogs(data.lines);
              })
              .catch(function () {
                /* the next tick retries; the state poll owns the error bar */
              });
          }

          var interval = setInterval(tick, LOG_INTERVAL_MS);
          tick();

          return function () {
            stopped = true;
            clearInterval(interval);
            if (ctrl !== null) ctrl.abort();
          };
        },
        [running]
      );

      /**
       * Append log lines from either poll. /state replays the last 300 lines
       * every second, so a line the user cleared has to stay cleared: anything
       * at or below `clearedRef` is dropped. Sequences are monotonic for the
       * life of this host page (a host restart reloads the plugin, resetting
       * the ref), so no "sequence went backwards" special case is needed.
       */
      function appendLogs(lines) {
        if (!Array.isArray(lines) || lines.length === 0) return;
        var fresh = [];
        for (var i = 0; i < lines.length; i += 1) {
          var line = lines[i];
          if (!line || typeof line.seq !== "number") continue;
          if (line.seq > clearedRef.current) fresh.push(line);
        }
        if (fresh.length === 0) return;
        setLogs(function (prev) {
          return mergeLogs(prev, fresh);
        });
      }

      function clearLogs() {
        clearedRef.current = sinceRef.current;
        setLogs([]);
      }

      function doAction(name, params) {
        if (aliveRef.current) {
          setBusy(name);
          setActErr(null);
        }
        return postAction(name, params)
          .then(function (data) {
            if (aliveRef.current) setBusy(null);
            if (aliveRef.current && typeof refreshRef.current === "function") refreshRef.current();
            return data;
          })
          .catch(function (error) {
            if (aliveRef.current) {
              setBusy(null);
              setActErr(errText(error));
            }
            return null;
          });
      }

      function refreshNow() {
        setActErr(null);
        setLinkErr(null);
        setReloadKey(function (value) {
          return value + 1;
        });
        if (typeof refreshRef.current === "function") refreshRef.current();
      }

      function onImported(data) {
        var kind = data && data.import && data.import.kind;
        if (kind === "android") setTab("android");
        else if (kind === "windows") setTab("desk");
        else if (kind === "web") setTab("web");
        openRightPreviewTab();
        refreshNow();
      }

      var web = (snap && snap.web) || {};
      var run = (snap && snap.run) || {};
      var desk = (snap && snap.desk) || { supported: true };
      var android = (snap && snap.android) || { supported: true, adb: {} };
      var appState = (snap && snap.app) || {};
      var versions = Array.isArray(appState.versions) ? appState.versions : [];
      var versionChoice = appState.versionChoice || null;
      var versionBusy = busy === "app.version.choose" || busy === "app.version.mark" || busy === "app.version.delete";
      var androidEmulator = android.emulator && typeof android.emulator === "object" ? android.emulator : {};
      var emulatorBusy =
        !!androidEmulator.installing || !!androidEmulator.launching || !!androidEmulator.starting;
      var live = running || !!desk.streaming || !!android.streaming || emulatorBusy;
      var errorText = actErr || linkErr;

      // 一旦有画面在跑，自动把「右侧同时看」打开：应用画面和对话并排显示。
      // 服务刚就绪时可能还取不到 controller，所以隔一小段时间重试两次。
      useEffect(
        function () {
          if (!live) return undefined;
          var stopped = false;
          var timer1 = null;
          var timer2 = null;
          function attempt() {
            if (stopped) return;
            if (openRightPreviewTab()) {
              stopped = true;
              if (timer1) clearTimeout(timer1);
              if (timer2) clearTimeout(timer2);
            }
          }
          attempt();
          timer1 = setTimeout(attempt, 1200);
          timer2 = setTimeout(attempt, 3500);
          return function () {
            stopped = true;
            if (timer1) clearTimeout(timer1);
            if (timer2) clearTimeout(timer2);
          };
        },
        [live]
      );

      var tabs = [
        { id: "web", label: tr("tabWeb") },
        { id: "desk", label: tr("tabDesk") },
        { id: "android", label: tr("tabAndroid") },
      ];

      var tabButtons = tabs.map(function (item) {
        var selected = tab === item.id;
        return h(
          "button",
          {
            key: item.id,
            type: "button",
            role: "tab",
            id: "lp-tab-" + item.id,
            className: "__lp_tab",
            "aria-selected": selected ? "true" : "false",
            "aria-controls": "lp-panel",
            onClick: function () {
              setTab(item.id);
            },
          },
          item.label
        );
      });

      var versionOpening = appState.versionOpening || null;
      var body;
      if (snap === null) {
        body = h(
          "div",
          { className: "__lp_empty" },
          h("span", { className: "__lp_spin" }),
          h("span", null, tr("loading"))
        );
      } else if (versionOpening) {
        // 切换版本时不要把旧程序的画面继续留着：整块换成加载动画，直到新版本启动完成。
        body = h(
          "div",
          { className: "__lp_empty" },
          h("span", { className: "__lp_spin" }),
          h("span", null, versionOpeningText(versionOpening))
        );
      } else if (tab === "desk") {
        body = h(DeskPane, { desk: desk, busy: busy, onAction: doAction });
      } else if (tab === "android") {
        body = h(AndroidPane, { android: android, busy: busy, onAction: doAction });
      } else {
        body = h(WebPane, {
          web: web,
          run: run,
          busy: busy,
          onAction: doAction,
          reloadKey: reloadKey,
        });
      }

      return h(
        "div",
        { className: "__lp_root" },
        h(
          "header",
          { className: "__lp_head" },
          h("span", { className: "__lp_glyph" }, h(LivePreviewIcon, { size: 18, active: live })),
          h("h1", { className: "__lp_title" }, tr("panel")),
          h(
            "span",
            { className: "__lp_badge", role: "status" },
            h("span", { className: "__lp_dot", "data-tone": live ? "success" : "idle" }),
            h("span", null, live ? tr("badgeLive") : tr("badgeIdle"))
          ),
          h("div", { className: "__lp_headImport" }, h(ImportBar, { compact: true, sessionId: currentSessionId, onImported: onImported })),
          h(
            "button",
            {
              type: "button",
              className: "__lp_btn __lp_btnGhost",
              onClick: function () {
                setHistoryOpen(true);
              },
              title: tr("historyApps"),
            },
            tr("historyApps") + (versions.length > 0 ? " (" + versions.length + ")" : "")
          ),
          h("span", { className: "__lp_spacer" }),
          h(
            "button",
            {
              type: "button",
              className: "__lp_iconBtn",
              onClick: refreshNow,
              "aria-label": tr("refresh"),
              title: tr("refresh"),
            },
            h(RefreshGlyph, null)
          )
        ),
        errorText
          ? h(
              "div",
              { className: "__lp_errorBar", role: "alert" },
              h("span", { className: "__lp_errorText" }, errorText),
              h(
                "button",
                {
                  type: "button",
                  className: "__lp_btn",
                  onClick: function () {
                    setActErr(null);
                    setLinkErr(null);
                  },
                  "aria-label": tr("dismiss"),
                },
                tr("dismiss")
              )
            )
          : null,
        versionChoice
          ? h(VersionChoiceBanner, {
              choice: versionChoice,
              busy: versionBusy,
              onChanged: refreshNow,
            })
          : null,
        h(
          "div",
          { className: "__lp_tabs", role: "tablist", "aria-label": tr("tabsLabel") },
          tabButtons
        ),
        h(
          "div",
          {
            className: "__lp_body",
            role: "tabpanel",
            id: "lp-panel",
            "aria-labelledby": "lp-tab-" + tab,
          },
          body
        ),
        h(LogsPanel, {
          lines: logs,
          open: logOpen,
          onToggle: setLogOpen,
          onClear: clearLogs,
        }),
        historyOpen
          ? h(VersionHistoryModal, {
              versions: versions,
              mode: "all",
              sessionId: currentSessionId,
              sessionTitles: sessionTitles,
              onClose: function () {
                setHistoryOpen(false);
              },
              onChanged: refreshNow,
            })
          : null
      );
    }

    // //////////////////////////////////////////////////////////////////////
    // Plugin body
    // //////////////////////////////////////////////////////////////////////

    var inject = ["slots", "locale"];

    function apply(ctx) {
      T = ctx.locale.bind(NS);
      clientCtx = ctx;
      ctx.effect(injectStyles, "dsh-live-preview: stylesheet");
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-live-preview: dictionaries");

      try {
        layoutApi = ctx.get("layout") || null;
      } catch (error) {
        layoutApi = null;
      }

      // 右侧边栏标签：应用画面与会话同时显示。
      // 注意：sidebarRight/sidebarRightTabs 服务的初始化可能晚于本插件的 apply（冷启动时顺序不保证），
      // 早先一次性 get 会静默失败、标签永远注册不上；这里改成轮询等待、就绪后只注册一次。
      (function setupRightPreviewTab() {
        var done = false;
        var tries = 0;
        var timer = null;
        function attempt() {
          if (done) return;
          try {
            var tabsApi = ctx.get("sidebarRightTabs");
            var sidebarRight = ctx.get("sidebarRight");
            if (!tabsApi || typeof tabsApi.register !== "function") {
              throw new Error("sidebarRightTabs 尚未就绪");
            }
            rightTabController = sidebarRight && typeof sidebarRight.openTab === "function" ? sidebarRight : null;
            var already =
              typeof tabsApi.get === "function" &&
              (tabsApi.get(PREVIEW_TAB_KIND) || tabsApi.get(PREVIEW_TAB_ID));
            if (!already) {
              ctx.effect(function () {
                return tabsApi.register({
                  id: PREVIEW_TAB_ID,
                  kind: PREVIEW_TAB_KIND,
                  priority: "builtin",
                  title: function () {
                    return tr("panel");
                  },
                  guide: [
                    {
                      id: PREVIEW_TAB_ID,
                      order: 40,
                      title: function () {
                        return tr("panel");
                      },
                      description: function () {
                        return tr("rightGuideDesc");
                      },
                    },
                  ],
                });
              }, "dsh-live-preview: right tab type");
            }
            ctx.slots.inject("sidebar.right.pane.tab", function () {
              return ctx.slots.register(
                { name: "sidebar.right.pane.tab", key: PREVIEW_TAB_ID, locale: NS },
                RightPreviewTab
              );
            });
            done = true;
            if (timer) clearTimeout(timer);
          } catch (error) {
            tries += 1;
            if (tries < 120) timer = setTimeout(attempt, 500);
          }
        }
        attempt();
      })();

      // 自动并排：只要有画面在跑（网页/桌面/安卓），就打开右侧「实时预览」。
      // 放在 apply 层而不是主面板组件里：对话占满主栏时主面板不一定挂载。
      try {
        var autoOpened = false;
        function checkAutoRight() {
          if (autoOpened) return;
          fetch(API + "/state?_=" + Date.now(), { cache: "no-store" })
            .then(function (response) {
              return response.json();
            })
            .then(function (data) {
              if (autoOpened || !data || data.ok !== true) return;
              var androidState = data.android || {};
              var deskState = data.desk || {};
              var webState = data.web || {};
              var runState = data.run || {};
              var running = !!androidState.streaming || !!deskState.streaming || (runState.status === "running") || !!webState.url;
              if (!running) return;
              if (openRightPreviewTab()) autoOpened = true;
            })
            .catch(function () {});
        }
        ctx.effect(
          function () {
            checkAutoRight();
            var timer = setInterval(checkAutoRight, 3000);
            return function () {
              clearInterval(timer);
            };
          },
          "dsh-live-preview: auto right preview"
        );
      } catch (error) {
        /* ignore */
      }

      // Register the main panel first so the sidebar row can never select a
      // key that does not exist yet (the host throws for missing main keys).
      ctx.slots.inject("main", function () {
        return ctx.slots.register(
          {
            name: "main",
            key: "live-preview",
            locale: NS,
          },
          LivePreviewPage
        );
      });

      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: "live-preview",
            order: 20,
            label: function () {
              return T("panel");
            },
            locale: NS,
          },
          LivePreviewIcon
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
