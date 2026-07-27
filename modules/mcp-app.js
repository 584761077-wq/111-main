(function () {
  const mcpApp = {
    mounted: false,
    screenId: 'mcp-screen',
    cards: [
      {
        id: 'add-server',
        title: '添加服务器',
        subtitle: '创建一个独立的 VPS 连接配置，后续可同步与备份。',
        icon: '＋'
      }
    ]
  };

  function ensureScreen() {
    if (document.getElementById(mcpApp.screenId)) return;

    const screen = document.createElement('div');
    screen.id = mcpApp.screenId;
    screen.className = 'screen';
    screen.innerHTML = `
      <div class="mcp-page">
        <div class="header mcp-header">
          <span class="back-btn" id="mcp-back-btn">‹</span>
          <span data-lang-key="tutorialTitle">MCP</span>
          <span style="width: 30px;"></span>
        </div>
        <div class="mcp-body">
          <div class="mcp-hero">
            <div class="mcp-hero-topline">
              <span class="mcp-hero-badge">PWA 优先</span>
              <span class="mcp-hero-chip">本地可先用</span>
            </div>
            <h2 class="mcp-hero-title">MCP 设置中心</h2>
            <p class="mcp-hero-desc">这里会逐步扩展为一个设置导航页。当前先从“添加服务器”开始，后续每个卡片都会进入独立页面。配置可以同步到后端，但不会依赖后端才能使用 PWA。</p>
          </div>
          <div class="mcp-section-title">导航</div>
          <div class="mcp-card-list" id="mcp-card-list"></div>
        </div>
      </div>
    `;
    document.getElementById('phone-screen').appendChild(screen);

    screen.querySelector('#mcp-back-btn').addEventListener('click', () => {
      if (typeof showScreen === 'function') showScreen('home-screen');
    });

    const list = screen.querySelector('#mcp-card-list');
    mcpApp.cards.forEach((card) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mcp-nav-card';
      button.innerHTML = `
        <div class="mcp-card-icon">${card.icon}</div>
        <div class="mcp-card-content">
          <div class="mcp-card-title">${card.title}</div>
          <div class="mcp-card-subtitle">${card.subtitle}</div>
        </div>
        <div class="mcp-card-arrow">›</div>
      `;
      button.addEventListener('click', () => openMcpDetail(card.id));
      list.appendChild(button);
    });
  }

  function openMcpDetail(cardId) {
    if (cardId === 'add-server' && typeof showScreen === 'function') {
      showScreen('mcp-add-server-screen');
    }
  }

  const storageKey = 'ephone_mcp_servers';
  const legacyStorageKey = 'ephone_mcp_server_config';
  let editingServerId = null;

  function createId() {
    return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function readStore() {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (stored?.servers) return stored;
      const legacy = JSON.parse(localStorage.getItem(legacyStorageKey) || 'null');
      if (legacy) {
        const server = { ...legacy, id: createId(), active: true };
        const migrated = { activeServerId: server.id, servers: [server] };
        localStorage.setItem(storageKey, JSON.stringify(migrated));
        localStorage.removeItem(legacyStorageKey);
        return migrated;
      }
    } catch (error) {
      console.warn('[MCP] 读取本地服务器配置失败', error);
    }
    return { activeServerId: null, servers: [] };
  }

  function writeStore(store) {
    localStorage.setItem(storageKey, JSON.stringify(store));
  }

  function getFormConfig() {
    return {
      id: editingServerId || createId(),
      name: document.getElementById('mcp-server-name')?.value.trim() || '',
      backendUrl: document.getElementById('mcp-backend-url')?.value.trim().replace(/\/$/, '') || '',
      apiToken: document.getElementById('mcp-api-token')?.value || '',
      host: document.getElementById('mcp-server-host')?.value.trim() || '',
      port: Number(document.getElementById('mcp-ssh-port')?.value || 22),
      username: document.getElementById('mcp-ssh-user')?.value.trim() || '',
      allowProxy: Boolean(document.getElementById('mcp-allow-proxy')?.checked),
      syncData: Boolean(document.getElementById('mcp-sync-data')?.checked),
      enableJobs: Boolean(document.getElementById('mcp-enable-jobs')?.checked),
      connectionState: 'unknown',
      updatedAt: new Date().toISOString()
    };
  }

  function setStatus(message, state) {
    const status = document.querySelector('#mcp-add-server-screen .mcp-bottom-desc');
    if (!status) return;
    status.innerHTML = `<span class="mcp-state-dot${state ? ` is-${state}` : ''}"></span><span></span>`;
    status.lastElementChild.textContent = message;
  }

  function updateSyncUi() {
    const syncEnabled = Boolean(document.getElementById('mcp-sync-data')?.checked);
    const syncNote = document.getElementById('mcp-sync-data-note');
    const syncWrap = document.getElementById('mcp-sync-manual-wrap');
    if (syncNote) {
      syncNote.textContent = syncEnabled ? '同步中' : '默认关闭，开启后才同步至服务器';
    }
    if (syncWrap) {
      syncWrap.hidden = !syncEnabled;
    }
  }

  function updateConnectionUi(state) {
    const button = document.getElementById('mcp-test-connection-btn');
    const status = document.querySelector('#mcp-connection-status-pill');
    const map = {
      connected: { label: '已连接', className: 'is-connected' },
      failed: { label: '连接失败', className: 'is-failed' },
      loading: { label: '连接中…', className: 'is-loading' },
      unknown: { label: '未连接', className: 'is-unknown' }
    };
    const config = map[state] || map.unknown;
    if (button) {
      button.classList.toggle('is-connected', state === 'connected');
      button.classList.toggle('is-failed', state === 'failed');
      button.classList.toggle('is-loading', state === 'loading');
      button.disabled = state === 'loading';
      const strong = button.querySelector('.mcp-button-copy strong');
      const small = button.querySelector('.mcp-button-copy small');
      if (strong) strong.textContent = config.label;
      if (small) small.textContent = state === 'connected' ? '点击可重新连接后端与 API Token' : state === 'failed' ? '请检查地址、Token 或网络后重试' : '填写配置后点击连接';
      const chevron = button.querySelector('.mcp-button-chevron');
      if (chevron) chevron.textContent = state === 'connected' ? '✓' : '›';
    }
    if (status) {
      status.className = `mcp-connection-pill ${config.className}`;
      status.textContent = config.label;
    }
  }

  function fillForm(config) {
    if (!config) return;
    editingServerId = config.id;
    const values = {
      'mcp-server-name': config.name,
      'mcp-backend-url': config.backendUrl,
      'mcp-api-token': config.apiToken,
      'mcp-server-host': config.host,
      'mcp-ssh-port': config.port,
      'mcp-ssh-user': config.username
    };
    Object.entries(values).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element && value !== undefined) element.value = value;
    });
    ['allowProxy', 'syncData', 'enableJobs'].forEach((key) => {
      const id = `mcp-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
      const element = document.getElementById(id);
      if (element) element.checked = Boolean(config[key]);
    });
  }

  function renderSavedServers() {
    const container = document.getElementById('mcp-saved-servers');
    if (!container) return;
    const store = readStore();
    container.innerHTML = '';
    if (!store.servers.length) {
      container.innerHTML = '<div class="mcp-empty-servers">还没有保存后端连接</div>';
      return;
    }
    store.servers.forEach((server) => {
      const row = document.createElement('div');
      row.className = `mcp-server-row${server.id === store.activeServerId ? ' is-active' : ''}`;
      row.innerHTML = `
        <button type="button" class="mcp-server-select">
          <span class="mcp-server-indicator"></span>
          <span class="mcp-server-copy"><strong></strong><small></small></span>
          <span class="mcp-server-active-label">${server.id === store.activeServerId ? '当前' : '选择'}</span>
        </button>
        <button type="button" class="mcp-server-delete" aria-label="删除服务器">×</button>
      `;
      row.querySelector('strong').textContent = server.name || '未命名服务器';
      row.querySelector('small').textContent = server.backendUrl || server.host || '尚未填写地址';
      row.querySelector('.mcp-server-select').addEventListener('click', () => selectServer(server.id));
      row.querySelector('.mcp-server-delete').addEventListener('click', () => deleteServer(server.id));
      container.appendChild(row);
    });
  }

  function selectServer(id) {
    const store = readStore();
    const selected = store.servers.find(server => server.id === id);
    if (!selected) return;
    store.activeServerId = id;
    writeStore(store);
    fillForm(selected);
    renderSavedServers();
    setStatus(`已选择：${selected.name || '未命名服务器'}`, 'success');
  }

  function deleteServer(id) {
    const store = readStore();
    store.servers = store.servers.filter(server => server.id !== id);
    if (store.activeServerId === id) store.activeServerId = store.servers[0]?.id || null;
    writeStore(store);
    editingServerId = store.activeServerId;
    if (editingServerId) fillForm(store.servers.find(server => server.id === editingServerId));
    renderSavedServers();
    setStatus('后端连接已从当前设备删除', 'success');
  }

  function saveLocalConfig() {
    const config = getFormConfig();
    if (!config.backendUrl) {
      setStatus('请填写后端地址后再保存', 'error');
      return;
    }
    const store = readStore();
    const index = store.servers.findIndex(server => server.id === config.id);
    if (index >= 0) store.servers[index] = config;
    else store.servers.push(config);
    store.activeServerId = config.id;
    writeStore(store);
    editingServerId = config.id;
    renderSavedServers();
    setStatus('后端连接已保存到当前设备', 'success');
  }

  function restoreLocalConfig() {
    const store = readStore();
    const active = store.servers.find(server => server.id === store.activeServerId) || store.servers[0];
    if (active) {
      fillForm(active);
      updateConnectionUi(active.connectionState === 'connected' ? 'connected' : 'unknown');
    } else {
      updateConnectionUi('unknown');
    }
    renderSavedServers();
    updateSyncUi();
  }

  function authHeaders(config) {
    return config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {};
  }

  async function readJson(response) {
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `请求失败（${response.status}）`);
    }
    return result;
  }

  async function testBackend() {
    const config = getFormConfig();
    if (!config.backendUrl) {
      setStatus('请先填写部署完成后的后端地址', 'error');
      return;
    }
    setStatus('正在连接后端与 API Token…', 'loading');
    updateConnectionUi('loading');
    try {
      const health = await readJson(await fetch(`${config.backendUrl}/health`, { cache: 'no-store' }));
      const status = await readJson(await fetch(`${config.backendUrl}/api/status`, {
        cache: 'no-store',
        headers: authHeaders(config)
      }));
      const store = readStore();
      const nextConfig = { ...config, connectionState: 'connected', updatedAt: new Date().toISOString() };
      const index = store.servers.findIndex(server => server.id === config.id);
      if (index >= 0) store.servers[index] = nextConfig;
      else store.servers.push(nextConfig);
      store.activeServerId = nextConfig.id;
      writeStore(store);
      editingServerId = nextConfig.id;
      renderSavedServers();
      updateConnectionUi('connected');
      setStatus(`连接成功 · ${health.version} · ${status.configured ? '后端已配置' : '等待同步配置'}`, 'success');
    } catch (error) {
      const store = readStore();
      const failedConfig = { ...config, connectionState: 'failed', updatedAt: new Date().toISOString() };
      const index = store.servers.findIndex(server => server.id === config.id);
      if (index >= 0) store.servers[index] = failedConfig;
      else store.servers.push(failedConfig);
      store.activeServerId = failedConfig.id;
      writeStore(store);
      editingServerId = failedConfig.id;
      renderSavedServers();
      updateConnectionUi('failed');
      setStatus(`连接失败：${error.message}`, 'error');
    }
  }

  async function syncConfigToBackend() {
    const config = getFormConfig();
    if (!config.backendUrl) {
      setStatus('请先填写后端地址', 'error');
      return;
    }
    saveLocalConfig();
    setStatus('正在同步非敏感配置…', 'loading');
    const button = document.getElementById('mcp-sync-config-btn');
    if (button) button.disabled = true;
    try {
      const payload = {
        name: config.name,
        backendUrl: config.backendUrl,
        host: config.host,
        port: config.port,
        username: config.username,
        allowProxy: config.allowProxy,
        syncData: config.syncData,
        enableJobs: config.enableJobs
      };
      await readJson(await fetch(`${config.backendUrl}/api/server-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
        body: JSON.stringify(payload)
      }));
      if (config.enableJobs && window.mcpBackgroundBridge) {
        const result = await window.mcpBackgroundBridge.syncSnapshots();
        setStatus(`配置同步成功 · 已复制 ${result.saved || 0} 个角色后台上下文`, 'success');
      } else {
        setStatus('配置同步成功，现有 PWA 功能保持本地运行', 'success');
      }
    } catch (error) {
      setStatus(`同步失败：${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function autoSyncIfEnabled() {
    const syncEnabled = Boolean(document.getElementById('mcp-sync-data')?.checked);
    updateSyncUi();
    if (syncEnabled) syncConfigToBackend();
  }

  async function runBridgeAction(buttonId, loadingText, successText, action) {
    const button = document.getElementById(buttonId);
    if (button) button.disabled = true;
    setStatus(loadingText, 'loading');
    try {
      const result = await action();
      setStatus(typeof successText === 'function' ? successText(result) : successText, 'success');
    } catch (error) {
      setStatus(`操作失败：${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bindPushModal() {
    const modal = document.getElementById('mcp-push-modal');
    const openButton = document.getElementById('mcp-enable-push-btn');
    const subscribeButton = document.getElementById('mcp-push-subscribe-btn');
    const testButton = document.getElementById('mcp-push-test-btn');
    const status = document.getElementById('mcp-push-status');
    if (!modal || !openButton || !subscribeButton || !testButton || !status) return;

    const showStatus = (message, state) => {
      status.hidden = false;
      status.className = `mcp-push-status is-${state}`;
      status.textContent = message;
    };
    const setBusy = (busy) => {
      subscribeButton.disabled = busy;
      testButton.disabled = busy;
    };
    const close = () => {
      modal.hidden = true;
      document.body.classList.remove('mcp-push-open');
    };

    openButton.addEventListener('click', () => {
      modal.hidden = false;
      status.hidden = true;
      document.body.classList.add('mcp-push-open');
    });
    modal.querySelectorAll('[data-mcp-close-push]').forEach(element => element.addEventListener('click', close));
    subscribeButton.addEventListener('click', async () => {
      setBusy(true);
      showStatus('正在获取权限并订阅当前设备…', 'loading');
      try {
        await window.mcpBackgroundBridge.subscribePush();
        showStatus('推送订阅成功，已上传后端', 'success');
        setStatus('Web Push 订阅成功', 'success');
      } catch (error) {
        showStatus(`订阅失败：${error.message}`, 'error');
        setStatus(`Web Push 订阅失败：${error.message}`, 'error');
      } finally {
        setBusy(false);
      }
    });
    testButton.addEventListener('click', async () => {
      setBusy(true);
      showStatus('正在调用后端发送真实推送…', 'loading');
      try {
        const result = await window.mcpBackgroundBridge.testPush();
        showStatus(`测试推送已发送${result.sent ? ` · ${result.sent} 个订阅` : ''}`, 'success');
        setStatus(result.warning ? `Web Push 已发送但部分失败：${result.detail || '请查看后端日志'}` : 'Web Push 测试发送成功', result.warning ? 'warning' : 'success');
      } catch (error) {
        showStatus(`测试失败：${error.message}`, 'error');
        setStatus(`Web Push 测试失败：${error.message}`, 'error');
      } finally {
        setBusy(false);
      }
    });
  }

  function bindLogsModal() {
    const modal = document.getElementById('mcp-logs-modal');
    const openButton = document.getElementById('mcp-open-logs-btn');
    const list = document.getElementById('mcp-log-list');
    const empty = document.getElementById('mcp-log-empty');
    const liveLabel = document.getElementById('mcp-log-live-label');
    const clearButton = document.getElementById('mcp-log-clear-btn');
    if (!modal || !openButton || !list || !empty || !liveLabel || !clearButton) return;

    let pollingTimer = null;
    let lastLogId = 0;

    const setEmpty = (title, message) => {
      empty.hidden = false;
      empty.querySelector('strong').textContent = title;
      empty.querySelector('p').textContent = message;
    };
    const formatTime = value => new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date(value));
    const renderLogs = (logs, reset = false) => {
      if (reset) list.innerHTML = '';
      logs.forEach(log => {
        const row = document.createElement('article');
        row.className = `mcp-log-row is-${log.status || 'info'}`;
        row.innerHTML = `<div class="mcp-log-meta"><time></time><span class="mcp-log-type"></span><span class="mcp-log-status"></span></div><p></p>`;
        row.querySelector('time').textContent = formatTime(log.createdAt);
        row.querySelector('.mcp-log-type').textContent = log.type || 'system';
        row.querySelector('.mcp-log-status').textContent = ({ success: '成功', failed: '失败', warning: '警告', info: '信息' })[log.status] || log.status;
        row.querySelector('p').textContent = log.message;
        list.appendChild(row);
        lastLogId = Math.max(lastLogId, Number(log.id) || 0);
      });
      empty.hidden = list.children.length > 0;
      clearButton.disabled = list.children.length === 0;
      if (logs.length) list.scrollTop = list.scrollHeight;
    };
    const fetchLogs = async (reset = false) => {
      const config = getFormConfig();
      if (!config.backendUrl) {
        liveLabel.textContent = '未连接';
        setEmpty('无法加载日志', '请先填写 MCP 后端地址和 API Token。');
        return;
      }
      if (reset) {
        lastLogId = 0;
        list.innerHTML = '';
        setEmpty('正在拉取真实日志', '正在连接当前 MCP 后端…');
      }
      try {
        const result = await readJson(await fetch(`${config.backendUrl}/api/logs?afterId=${lastLogId}&limit=200`, {
          cache: 'no-store', headers: authHeaders(config)
        }));
        renderLogs(result.logs || [], false);
        liveLabel.textContent = '实时日志 · 已连接';
        if (!list.children.length) setEmpty('暂无后端日志', '后端已连接，新运行记录会实时显示在这里。');
      } catch (error) {
        liveLabel.textContent = '实时日志 · 连接失败';
        if (!list.children.length) setEmpty('日志拉取失败', error.message);
      }
    };
    const close = () => {
      modal.hidden = true;
      document.body.classList.remove('mcp-logs-open');
      clearInterval(pollingTimer);
      pollingTimer = null;
    };

    openButton.addEventListener('click', () => {
      modal.hidden = false;
      document.body.classList.add('mcp-logs-open');
      fetchLogs(true);
      clearInterval(pollingTimer);
      pollingTimer = setInterval(() => fetchLogs(false), 2500);
    });
    clearButton.addEventListener('click', async () => {
      const config = getFormConfig();
      if (!config.backendUrl) return;
      clearButton.disabled = true;
      try {
        await readJson(await fetch(`${config.backendUrl}/api/logs`, { method: 'DELETE', headers: authHeaders(config) }));
        lastLogId = 0;
        list.innerHTML = '';
        setEmpty('暂无后端日志', '日志已清空，新运行记录会实时显示在这里。');
      } catch (error) {
        setEmpty('清空失败', error.message);
      }
    });
    modal.querySelectorAll('[data-mcp-close-logs]').forEach(element => element.addEventListener('click', close));
  }

  function bindServerForm() {
    document.getElementById('mcp-save-config-btn')?.addEventListener('click', saveLocalConfig);
    document.getElementById('mcp-save-local-btn')?.addEventListener('click', saveLocalConfig);
    document.getElementById('mcp-test-connection-btn')?.addEventListener('click', testBackend);
    document.getElementById('mcp-backend-url')?.addEventListener('input', () => updateConnectionUi('unknown'));
    document.getElementById('mcp-api-token')?.addEventListener('input', () => updateConnectionUi('unknown'));
    document.getElementById('mcp-sync-data')?.addEventListener('change', autoSyncIfEnabled);
    document.getElementById('mcp-enable-jobs')?.addEventListener('change', autoSyncIfEnabled);
    document.getElementById('mcp-allow-proxy')?.addEventListener('change', autoSyncIfEnabled);
    document.getElementById('mcp-authorize-api-btn')?.addEventListener('click', () => runBridgeAction(
      'mcp-authorize-api-btn', '正在安全授权后台 API…', result => `后台 API 已授权 · ${result.model}`, () => window.mcpBackgroundBridge.authorizeBackgroundApi()
    ));
    bindPushModal();
    bindLogsModal();
    restoreLocalConfig();
    updateSyncUi();
  }

  function mount() {
    if (mcpApp.mounted) return;
    ensureScreen();
    bindServerForm();
    mcpApp.mounted = true;
  }

  document.addEventListener('DOMContentLoaded', mount);
  window.openMcpDetail = openMcpDetail;
  window.openMcpScreen = function () {
    ensureScreen();
    if (typeof showScreen === 'function') showScreen('mcp-screen');
  };
})();
