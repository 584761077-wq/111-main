(() => {
  'use strict';

  const VERSION = '1.1.0';
  const STORAGE_KEY = '__mlh_previous_session_v1';
  const SAMPLE_MS = 10000;
  const MAX_SAMPLES = 120;
  const MAX_SITES = 150;
  const MAX_DOM_SIGNATURES = 12;
  const startedAt = Date.now();
  const sessionId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const originals = {
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    addEventListener: EventTarget.prototype.addEventListener,
    removeEventListener: EventTarget.prototype.removeEventListener,
    createObjectURL: URL.createObjectURL?.bind(URL),
    revokeObjectURL: URL.revokeObjectURL?.bind(URL)
  };
  const intervalIds = new Map();
  const blobUrls = new Map();
  const listenerRecords = new WeakMap();
  const sites = new Map();
  const marks = [];
  const errors = [];
  const samples = [];
  const WARMUP_MS = 60000;
  let destroyed = false;
  let endedNormally = false;
  let previous = readPrevious();
  let samplerId = null;

  function safeString(value, limit = 500) {
    try {
      const text = typeof value === 'string' ? value : String(value);
      return text.replace(/[?&](token|key|secret|password|authorization)=[^&\s]+/gi, '$1=[REDACTED]').slice(0, limit);
    } catch (_) {
      return '[unavailable]';
    }
  }

  function readPrevious() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function captureSite(skipName) {
    try {
      const lines = String(new Error().stack || '').split('\n').slice(2);
      const useful = lines.find(line =>
        !line.includes('memory-leak-hunter.js') &&
        !line.includes(skipName || '__never__') &&
        (/modules\/|\.js[:?]/.test(line))
      );
      return safeString((useful || lines[0] || 'unknown').trim(), 260);
    } catch (_) {
      return 'unknown';
    }
  }

  function bump(kind, site, delta) {
    const key = `${kind}|${site}`;
    let item = sites.get(key);
    if (!item) {
      if (sites.size >= MAX_SITES) return;
      item = { kind, site, created: 0, released: 0, active: 0 };
      sites.set(key, item);
    }
    if (delta > 0) item.created += delta;
    else item.released += -delta;
    item.active = Math.max(0, item.active + delta);
  }

  function getHeap() {
    const memory = performance.memory;
    return memory ? {
      used: memory.usedJSHeapSize || 0,
      total: memory.totalJSHeapSize || 0,
      limit: memory.jsHeapSizeLimit || 0
    } : null;
  }

  function getDomSignatures() {
    const counts = new Map();
    document.querySelectorAll('body *').forEach(element => {
      const tag = element.tagName.toLowerCase();
      const classes = [...element.classList].slice(0, 2).map(name => `.${safeString(name, 40)}`).join('');
      const signature = `${tag}${classes}`;
      counts.set(signature, (counts.get(signature) || 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_DOM_SIGNATURES)
      .map(([signature, count]) => ({ signature, count }));
  }

  function takeSample() {
    if (destroyed) return;
    const sample = {
      time: Date.now(),
      heap: getHeap(),
      dom: document.getElementsByTagName('*').length,
      domSignatures: getDomSignatures(),
      images: document.images?.length || 0,
      videos: document.getElementsByTagName('video').length,
      audios: document.getElementsByTagName('audio').length,
      intervals: intervalIds.size,
      blobs: blobUrls.size,
      visibility: document.visibilityState
    };
    samples.push(sample);
    if (samples.length > MAX_SAMPLES) samples.shift();
    persist(false);
  }

  function serializableSites() {
    return [...sites.values()]
      .filter(item => item.active > 0 || item.created >= 5)
      .sort((a, b) => b.active - a.active || b.created - a.created)
      .slice(0, 40);
  }

  function sessionData(normal = false) {
    return {
      version: VERSION,
      sessionId,
      startedAt,
      lastHeartbeat: Date.now(),
      endedNormally: normal || endedNormally,
      endReason: normal || endedNormally ? 'pagehide' : null,
      url: location.origin + location.pathname,
      visibility: document.visibilityState,
      navigationType: performance.getEntriesByType('navigation')[0]?.type || 'unknown',
      samples,
      sites: serializableSites(),
      marks: marks.slice(-20),
      errors: errors.slice(-10),
      userAgent: navigator.userAgent.slice(0, 180)
    };
  }

  function persist(normal) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionData(normal)));
    } catch (error) {
      console.warn('[内存黑手追踪器] 无法保存诊断数据:', error);
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '不可用';
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function trend(values) {
    if (values.length < 2) return { first: values[0] || 0, last: values[0] || 0, peak: values[0] || 0, growth: 0, rising: 0 };
    let rising = 0;
    for (let i = 1; i < values.length; i++) if (values[i] > values[i - 1]) rising++;
    return { first: values[0], last: values.at(-1), peak: Math.max(...values), growth: values.at(-1) - values[0], rising };
  }

  function samplesSince(list, milliseconds) {
    const cutoff = (list.at(-1)?.time || Date.now()) - milliseconds;
    return list.filter(sample => sample.time >= cutoff);
  }

  function metricTrend(list, selector) {
    return trend(list.map(selector).filter(Number.isFinite));
  }

  function siteScore(item) {
    if (item.kind === 'Interval' && item.created === 1 && item.active === 1) return 0;
    const duplicateWeight = Math.max(0, item.created - item.released - 1);
    return item.active + duplicateWeight * 3 + (item.created >= 5 ? item.created : 0);
  }

  function domGrowthReport(list) {
    const first = list.find(sample => sample.domSignatures?.length)?.domSignatures || [];
    const last = [...list].reverse().find(sample => sample.domSignatures?.length)?.domSignatures || [];
    const baseline = new Map(first.map(item => [item.signature, item.count]));
    return last.map(item => ({
      signature: item.signature,
      first: baseline.get(item.signature) || 0,
      last: item.count,
      growth: item.count - (baseline.get(item.signature) || 0)
    })).filter(item => item.growth !== 0).sort((a, b) => b.growth - a.growth).slice(0, 10);
  }

  function buildReport(data, title = '当前会话诊断报告') {
    if (!data) return '没有可用的诊断数据。';
    const list = data.samples || [];
    const stableList = list.filter(sample => sample.time >= data.startedAt + WARMUP_MS);
    const baselineList = stableList.length >= 2 ? stableList : list;
    const heapValues = baselineList.map(s => s.heap?.used).filter(Number.isFinite);
    const domValues = baselineList.map(s => s.dom).filter(Number.isFinite);
    const heap = trend(heapValues);
    const dom = trend(domValues);
    const heap1m = metricTrend(samplesSince(list, 60000), s => s.heap?.used);
    const heap5m = metricTrend(samplesSince(list, 300000), s => s.heap?.used);
    const dom1m = metricTrend(samplesSince(list, 60000), s => s.dom);
    const dom5m = metricTrend(samplesSince(list, 300000), s => s.dom);
    const last = list.at(-1) || {};
    const duration = Math.max(0, (data.lastHeartbeat || Date.now()) - data.startedAt);
    const heartbeatGap = Math.max(0, startedAt - (data.lastHeartbeat || startedAt));
    const heapRatio = last.heap?.limit ? last.heap.used / last.heap.limit : 0;
    const rankedSites = (data.sites || []).map(item => ({ ...item, score: siteScore(item) })).sort((a, b) => b.score - a.score);
    const suspects = rankedSites.filter(item => item.score > 3).slice(0, 12);
    const observations = rankedSites.filter(item => item.score <= 3 && item.active > 0).slice(0, 12);
    const domGrowth = domGrowthReport(baselineList);
    const suspiciousGrowth = heap.growth > 100 * 1024 * 1024 || dom.growth > 5000 || suspects.some(s => s.score >= 20);
    const confidence = suspiciousGrowth ? '高' : baselineList.length >= 6 ? '中' : '低（稳定期采样较短）';
    const classification = data.endedNormally ? '正常离开/刷新' : '疑似异常崩溃刷新';
    const lines = [
      '=== PWA 内存黑手诊断报告 ===',
      `诊断器版本：${data.version || VERSION}`,
      `报告类型：${data.endedNormally && title.includes('异常') ? '上次正常会话（并非崩溃）' : title}`,
      `判定：${classification}`,
      `可疑置信度：${confidence}`,
      `会话开始：${new Date(data.startedAt).toLocaleString()}`,
      `记录时长：${Math.floor(duration / 60000)}分${Math.floor(duration % 60000 / 1000)}秒`,
      `最后心跳距本次启动：${(heartbeatGap / 1000).toFixed(1)}秒`,
      `导航类型：${data.navigationType || 'unknown'}`,
      `退出前可见状态：${data.visibility || 'unknown'}`,
      `正常结束标记：${data.endedNormally ? '是' : '否'}`,
      '',
      '【JS 堆内存（排除启动前60秒）】',
      heapValues.length ? `稳定期初始：${formatBytes(heap.first)}\n最后：${formatBytes(heap.last)}\n峰值：${formatBytes(heap.peak)}\n稳定期净增长：${formatBytes(heap.growth)}\n最近1分钟：${formatBytes(heap1m.growth)}\n最近5分钟：${formatBytes(heap5m.growth)}\n增长采样：${heap.rising}/${Math.max(0, heapValues.length - 1)}\n堆上限占用：${(heapRatio * 100).toFixed(1)}%` : '当前浏览器未开放 performance.memory，使用其他指标判断。',
      '',
      '【页面与资源（排除启动前60秒）】',
      `DOM 稳定期初始：${dom.first || '无'}\nDOM 最后：${dom.last || '无'}\nDOM 稳定期净增长：${dom.growth >= 0 ? '+' : ''}${dom.growth}\nDOM 最近1分钟：${dom1m.growth >= 0 ? '+' : ''}${dom1m.growth}\nDOM 最近5分钟：${dom5m.growth >= 0 ? '+' : ''}${dom5m.growth}\n图片：${last.images ?? '无'}\n视频：${last.videos ?? '无'}\n音频：${last.audios ?? '无'}\n存活 Interval：${last.intervals ?? 0}\n未撤销 Blob URL：${last.blobs ?? 0}`,
      '',
      '【DOM 类型增长（稳定期首尾）】'
    ];
    if (!domGrowth.length) lines.push('未记录到可归因的主要 DOM 类型变化。');
    domGrowth.forEach((item, index) => lines.push(`${index + 1}. ${item.signature}：${item.first} → ${item.last}（${item.growth >= 0 ? '+' : ''}${item.growth}）`));
    lines.push('', '【高风险嫌疑位置】');
    if (!suspects.length) lines.push('尚未发现重复创建或大量未释放的高风险资源。');
    suspects.forEach((item, index) => lines.push(`${index + 1}. ${item.kind} 风险分=${item.score} 活跃=${item.active} 创建=${item.created} 释放=${item.released}\n   ${item.site}`));
    lines.push('', '【普通长驻资源（不等于泄漏）】');
    if (!observations.length) lines.push('无。');
    observations.forEach((item, index) => lines.push(`${index + 1}. ${item.kind} 活跃=${item.active} 创建=${item.created} 释放=${item.released}\n   ${item.site}`));
    lines.push('', '【会话期间错误】');
    if (!(data.errors || []).length) lines.push('未记录到未处理错误。');
    else data.errors.forEach(e => lines.push(`- ${new Date(e.time).toLocaleTimeString()} ${e.type}${(e.count || 1) > 1 ? ` ×${e.count}` : ''}: ${e.message}\n  ${e.site || ''}`));
    lines.push('', '【操作标记】');
    if (!(data.marks || []).length) lines.push('无手动标记。');
    else data.marks.forEach(m => lines.push(`- ${new Date(m.time).toLocaleTimeString()} ${m.label}`));
    lines.push('', '请把本报告完整复制给代码分析助手。报告不包含聊天正文、密钥或媒体内容。');
    return lines.join('\n');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  function showReport(report) {
    document.getElementById('mlh-report-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'mlh-report-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:18px;font-family:system-ui,sans-serif';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:min(760px,100%);max-height:88vh;background:#fff;color:#222;border-radius:14px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:12px';
    const heading = document.createElement('div');
    heading.innerHTML = '<strong style="font-size:18px">检测到疑似 PWA 崩溃刷新</strong><div style="font-size:13px;color:#666;margin-top:4px">复制下面的脱敏报告并发给我进行定位。</div>';
    const area = document.createElement('textarea');
    area.readOnly = true;
    area.value = report;
    area.style.cssText = 'width:100%;height:55vh;box-sizing:border-box;resize:vertical;border:1px solid #ccc;border-radius:9px;padding:12px;font:12px/1.55 Consolas,monospace;color:#111;background:#f7f7f7';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap';
    const copy = document.createElement('button');
    copy.textContent = '复制报告';
    copy.style.cssText = 'border:0;border-radius:8px;padding:10px 18px;background:#1677ff;color:#fff;font-weight:700;cursor:pointer';
    copy.onclick = async () => {
      if (await copyText(report)) copy.textContent = '已复制';
      else { area.focus(); area.select(); copy.textContent = '请按 Ctrl+C'; }
    };
    const close = document.createElement('button');
    close.textContent = '关闭';
    close.style.cssText = 'border:1px solid #bbb;border-radius:8px;padding:10px 18px;background:#fff;color:#333;cursor:pointer';
    close.onclick = () => overlay.remove();
    actions.append(close, copy);
    panel.append(heading, area, actions);
    overlay.append(panel);
    document.body.append(overlay);
  }

  function installHooks() {
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (!listener || type === 'error' || type === 'unhandledrejection') {
        return originals.addEventListener.call(this, type, listener, options);
      }
      let targetMap = listenerRecords.get(this);
      if (!targetMap) {
        targetMap = new Map();
        listenerRecords.set(this, targetMap);
      }
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const key = `${type}|${capture}`;
      let listeners = targetMap.get(key);
      if (!listeners) {
        listeners = new Map();
        targetMap.set(key, listeners);
      }
      if (!listeners.has(listener)) {
        const site = captureSite('addEventListener');
        listeners.set(listener, site);
        bump(`Event:${type}`, site, 1);
      }
      return originals.addEventListener.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const listeners = listenerRecords.get(this)?.get(`${type}|${capture}`);
      const site = listeners?.get(listener);
      if (site) {
        bump(`Event:${type}`, site, -1);
        listeners.delete(listener);
      }
      return originals.removeEventListener.call(this, type, listener, options);
    };
    window.setInterval = function (callback, delay, ...args) {
      const site = captureSite('setInterval');
      const id = originals.setInterval(callback, delay, ...args);
      intervalIds.set(id, site);
      bump('Interval', site, 1);
      return id;
    };
    window.clearInterval = function (id) {
      const site = intervalIds.get(id);
      if (site) { bump('Interval', site, -1); intervalIds.delete(id); }
      return originals.clearInterval(id);
    };
    if (originals.createObjectURL) {
      URL.createObjectURL = function (object) {
        const url = originals.createObjectURL(object);
        const site = captureSite('createObjectURL');
        blobUrls.set(url, site);
        bump('Blob URL', site, 1);
        return url;
      };
      URL.revokeObjectURL = function (url) {
        const site = blobUrls.get(url);
        if (site) { bump('Blob URL', site, -1); blobUrls.delete(url); }
        return originals.revokeObjectURL(url);
      };
    }
  }

  function recordError(type, event) {
    const target = event?.target;
    const isResourceError = type === 'error' && target && target !== window;
    const reason = event?.reason || event?.error || event?.message;
    const resourceUrl = isResourceError ? (target.currentSrc || target.src || target.href || '') : '';
    const normalizedType = isResourceError ? 'ResourceLoadError' : type === 'unhandledrejection' ? 'UnhandledRejection' : 'JavaScriptError';
    const message = isResourceError
      ? `${target.tagName || 'RESOURCE'} 加载失败：${safeString(resourceUrl.split('?')[0], 400)}`
      : safeString(reason?.message || reason || '未知错误', 600);
    const site = isResourceError
      ? safeString(`${target.tagName || ''}${target.id ? `#${target.id}` : ''}${target.className && typeof target.className === 'string' ? `.${target.className.trim().replace(/\s+/g, '.')}` : ''}`, 300)
      : safeString(reason?.stack || `${event?.filename || ''}:${event?.lineno || ''}:${event?.colno || ''}`, 800);
    const duplicate = errors.find(item => item.type === normalizedType && item.message === message);
    if (duplicate) {
      duplicate.count = (duplicate.count || 1) + 1;
      duplicate.time = Date.now();
    } else {
      errors.push({ time: Date.now(), type: normalizedType, message, site, count: 1 });
    }
    if (errors.length > 15) errors.shift();
    persist(false);
  }

  function shouldShowPrevious(data) {
    if (!data || data.endedNormally || data.sessionId === sessionId) return false;
    const age = startedAt - (data.lastHeartbeat || 0);
    return age >= 0 && age < 12 * 60 * 60 * 1000 && (data.samples || []).length > 0;
  }

  function openMobileConsole() {
    const mobileConsole = document.getElementById('mobile-console');
    if (!mobileConsole) return false;
    mobileConsole.style.display = '';
    mobileConsole.hidden = false;
    mobileConsole.classList.add('show', 'active', 'visible');
    mobileConsole.setAttribute('aria-hidden', 'false');
    return true;
  }

  function publishToMobileConsole(report) {
    console.error('[内存黑手追踪器] 检测到疑似 PWA 崩溃刷新');
    console.log(report);
    openMobileConsole();
  }

  function addMobileConsoleControls() {
    const header = document.getElementById('mobile-console-header');
    if (!header || document.getElementById('mlh-console-actions')) return false;

    const actions = document.createElement('span');
    actions.id = 'mlh-console-actions';
    actions.style.cssText = 'display:inline-flex;gap:6px;margin-left:8px;align-items:center';

    const makeButton = (label, handler) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = 'border:1px solid rgba(255,255,255,.55);border-radius:5px;padding:3px 7px;background:rgba(22,119,255,.9);color:#fff;font-size:12px;cursor:pointer';
      button.addEventListener('click', event => {
        event.stopPropagation();
        handler(button);
      });
      return button;
    };

    actions.append(
      makeButton('诊断报告', () => {
        takeSample();
        console.log(buildReport(sessionData(false), '当前会话手动报告'));
      }),
      makeButton('复制报告', async button => {
        takeSample();
        const report = buildReport(sessionData(false), '当前会话手动报告');
        if (await copyText(report)) {
          button.textContent = '已复制';
          setTimeout(() => { button.textContent = '复制报告'; }, 1600);
        } else {
          showReport(report);
        }
      }),
      makeButton('上次会话', () => {
        console.log(buildReport(previous, previous?.endedNormally ? '上次正常会话（并非崩溃）' : '上次疑似异常会话'));
      })
    );
    header.appendChild(actions);
    announceStarted();
    return true;
  }

  function announceStarted() {
    console.info(`%c[内存黑手追踪器] v${VERSION} 已启动`, 'color:#52c41a;font-weight:bold', '每10秒采样；崩溃刷新后自动输出报告；无需输入命令。');
  }

  function scheduleStartupAnnouncements() {
    announceStarted();
    [1000, 3000, 7000].forEach(delay => {
      setTimeout(announceStarted, delay);
    });
  }

  function waitForMobileConsole() {
    if (addMobileConsoleControls()) return;
    const observer = new MutationObserver(() => {
      if (addMobileConsoleControls()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    originals.setInterval(() => addMobileConsoleControls(), 2000);
  }

  installHooks();
  window.addEventListener('error', event => recordError('error', event), true);
  window.addEventListener('unhandledrejection', event => recordError('unhandledrejection', event), true);
  window.addEventListener('pagehide', () => { endedNormally = true; persist(true); }, { capture: true });
  document.addEventListener('visibilitychange', () => persist(false));

  takeSample();
  samplerId = originals.setInterval(takeSample, SAMPLE_MS);

  window.MemoryLeakHunter = {
    version: VERSION,
    report() { takeSample(); return buildReport(sessionData(false)); },
    showReport() { const report = this.report(); showReport(report); return report; },
    showLastCrashReport() { const report = buildReport(previous, '上次会话'); showReport(report); return report; },
    async copyReport() { return copyText(this.report()); },
    async copyLastCrashReport() { return copyText(buildReport(previous, '上次会话')); },
    mark(label) { marks.push({ time: Date.now(), label: safeString(label, 160) }); persist(false); console.log('[内存黑手追踪器] 已标记:', label); },
    clearHistory() { localStorage.removeItem(STORAGE_KEY); previous = null; console.log('[内存黑手追踪器] 历史已清除'); },
    status() { return { version: VERSION, samples: samples.length, activeIntervals: intervalIds.size, activeBlobUrls: blobUrls.size, previousAbnormal: shouldShowPrevious(previous) }; },
    destroy() {
      destroyed = true;
      originals.clearInterval(samplerId);
      window.setInterval = originals.setInterval;
      window.clearInterval = originals.clearInterval;
      EventTarget.prototype.addEventListener = originals.addEventListener;
      EventTarget.prototype.removeEventListener = originals.removeEventListener;
      if (originals.createObjectURL) URL.createObjectURL = originals.createObjectURL;
      if (originals.revokeObjectURL) URL.revokeObjectURL = originals.revokeObjectURL;
      document.getElementById('mlh-report-overlay')?.remove();
      console.log('[内存黑手追踪器] 已停止，刷新页面可重新启用');
    }
  };

  const startWhenReady = () => {
    waitForMobileConsole();
    scheduleStartupAnnouncements();
    if (shouldShowPrevious(previous)) {
      const report = buildReport(previous, '上次疑似异常会话');
      setTimeout(() => publishToMobileConsole(report), 1800);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startWhenReady, { once: true });
  else startWhenReady();
})();
