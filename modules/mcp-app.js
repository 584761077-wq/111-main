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
      updatedAt: new Date().toISOString()
    };
  }

  function setStatus(message, state) {
    const status = document.querySelector('#mcp-add-server-screen .mcp-bottom-desc');
    if (!status) return;
    status.innerHTML = `<span class="mcp-state-dot${state ? ` is-${state}` : ''}"></span><span></span>`;
    status.lastElementChild.textContent = message;
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
    if (active) fillForm(active);
    renderSavedServers();
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
    setStatus('正在验证后端与 API Token…', 'loading');
    const button = document.getElementById('mcp-test-connection-btn');
    if (button) button.disabled = true;
    try {
      const health = await readJson(await fetch(`${config.backendUrl}/health`, { cache: 'no-store' }));
      const status = await readJson(await fetch(`${config.backendUrl}/api/status`, {
        cache: 'no-store',
        headers: authHeaders(config)
      }));
      saveLocalConfig();
      setStatus(`连接成功 · ${health.version} · ${status.configured ? '后端已配置' : '等待同步配置'}`, 'success');
    } catch (error) {
      setStatus(`连接失败：${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
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

  async function pullBackgroundEvents() {
    if (!window.mcpBackgroundBridge) return;
    const button = document.getElementById('mcp-pull-events-btn');
    if (button) button.disabled = true;
    setStatus('正在拉取 VPS 后台消息…', 'loading');
    try {
      const result = await window.mcpBackgroundBridge.pullEvents();
      setStatus(`已导入 ${result.imported} 条消息${result.skipped ? `，跳过 ${result.skipped} 条` : ''}`, 'success');
    } catch (error) {
      setStatus(`拉取失败：${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function showBackgroundStatus() {
    if (!window.mcpBackgroundBridge) return;
    const button = document.getElementById('mcp-background-status-btn');
    if (button) button.disabled = true;
    setStatus('正在读取后台副本…', 'loading');
    try {
      const result = await window.mcpBackgroundBridge.getStatus();
      const contextCount = (result.snapshots || []).reduce((sum, item) => sum + item.contextCount, 0);
      setStatus(`${result.snapshots.length} 个角色 · ${contextCount} 条上下文 · ${result.pendingEvents} 条待回传`, 'success');
    } catch (error) {
      setStatus(`状态读取失败：${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
    }
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

  function bindServerForm() {
    document.getElementById('mcp-save-config-btn')?.addEventListener('click', saveLocalConfig);
    document.getElementById('mcp-save-local-btn')?.addEventListener('click', saveLocalConfig);
    document.getElementById('mcp-test-connection-btn')?.addEventListener('click', testBackend);
    document.getElementById('mcp-sync-config-btn')?.addEventListener('click', syncConfigToBackend);
    document.getElementById('mcp-pull-events-btn')?.addEventListener('click', pullBackgroundEvents);
    document.getElementById('mcp-background-status-btn')?.addEventListener('click', showBackgroundStatus);
    document.getElementById('mcp-authorize-api-btn')?.addEventListener('click', () => runBridgeAction(
      'mcp-authorize-api-btn', '正在安全授权后台 API…', result => `后台 API 已授权 · ${result.model}`, () => window.mcpBackgroundBridge.authorizeBackgroundApi()
    ));
    document.getElementById('mcp-enable-push-btn')?.addEventListener('click', () => runBridgeAction(
      'mcp-enable-push-btn', '正在连接 iOS Web Push…', 'Web Push 已连接到当前设备', () => window.mcpBackgroundBridge.subscribePush()
    ));
    restoreLocalConfig();
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
