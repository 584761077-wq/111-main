(function () {
  const serverStorageKey = 'ephone_mcp_servers';

  function getActiveServer() {
    try {
      const store = JSON.parse(localStorage.getItem(serverStorageKey) || 'null');
      return store?.servers?.find(server => server.id === store.activeServerId) || null;
    } catch {
      return null;
    }
  }

  function headers(server, jsonBody) {
    return {
      ...(jsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...(server.apiToken ? { Authorization: `Bearer ${server.apiToken}` } : {})
    };
  }

  function toContextMessage(message) {
    return {
      id: message.id || `${message.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant',
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''),
      type: message.type || 'text',
      timestamp: Number(message.timestamp) || Date.now()
    };
  }

  function buildSnapshots() {
    if (!window.state?.globalSettings?.enableBackgroundActivity || !window.state?.chats) return [];
    return Object.values(window.state.chats)
      .filter(chat => !chat.isGroup && chat.relationship?.status === 'friend' && chat.settings?.enableBackgroundActivity !== false)
      .map(chat => {
        const contextLimit = Math.max(1, parseInt(chat.settings.maxMemory, 10) || 10);
        const history = (chat.history || [])
          .filter(message => !message.isExcluded && message.type !== 'thought_chain_block')
          .slice(-contextLimit)
          .map(toContextMessage);
        return {
          chatId: String(chat.id),
          name: chat.name || chat.originalName || '未命名角色',
          enabled: true,
          contextLimit,
          actionCooldownMinutes: Number(chat.settings.actionCooldownMinutes) || 15,
          lastActionTimestamp: Number(chat.lastActionTimestamp) || null,
          persona: chat.settings.aiPersona || '',
          userPersona: chat.settings.myPersona || '',
          history,
          backgroundSettings: {
            intervalSeconds: Number(window.state.globalSettings.backgroundActivityInterval) || 60,
            temperature: Number(window.state.globalSettings.apiTemperature) || 0.9
          },
          syncedFrom: 'pwa'
        };
      });
  }

  async function syncSnapshots() {
    const server = getActiveServer();
    if (!server?.backendUrl || !server.enableJobs) return { skipped: true, reason: 'remote-background-disabled' };
    const snapshots = buildSnapshots();
    const response = await fetch(`${server.backendUrl}/api/background/snapshots`, {
      method: 'POST',
      headers: headers(server, true),
      body: JSON.stringify({ snapshots })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error || `同步失败（${response.status}）`);
    return result;
  }

  async function getStatus() {
    const server = getActiveServer();
    if (!server?.backendUrl) return null;
    const response = await fetch(`${server.backendUrl}/api/background/status`, { headers: headers(server, false), cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error || `状态读取失败（${response.status}）`);
    return result;
  }

  async function acknowledge(server, eventId) {
    const response = await fetch(`${server.backendUrl}/api/background/events/${encodeURIComponent(eventId)}/ack`, {
      method: 'POST',
      headers: headers(server, true),
      body: '{}'
    });
    if (!response.ok) throw new Error(`确认事件失败（${response.status}）`);
  }

  async function importEvent(event) {
    if (event.type !== 'single_chat_message' || !event.chatId || !event.message) return false;
    const chat = window.state?.chats?.[event.chatId];
    if (!chat || chat.isGroup || !window.db?.chats) return false;
    chat.history = Array.isArray(chat.history) ? chat.history : [];
    if (chat.history.some(message => message.mcpEventId === event.id || message.id === event.message.id)) return true;
    const message = {
      ...event.message,
      id: event.message.id,
      role: 'assistant',
      type: event.message.type || 'text',
      timestamp: Number(event.message.timestamp) || Date.now(),
      mcpEventId: event.id,
      source: 'mcp-background'
    };
    chat.history.push(message);
    const isViewing = window.state.activeChatId === event.chatId && document.getElementById('chat-interface-screen')?.classList.contains('active');
    if (!isViewing) chat.unreadCount = (chat.unreadCount || 0) + 1;
    await window.db.chats.put(chat);
    if (isViewing && typeof window.appendMessage === 'function') window.appendMessage(message, chat);
    if (typeof window.renderChatList === 'function') window.renderChatList();
    return true;
  }

  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  }

  async function authorizeBackgroundApi() {
    const server = getActiveServer();
    const apiConfig = window.state?.apiConfig;
    if (!server?.backendUrl || !apiConfig) throw new Error('MCP 后端或 PWA API 配置不可用');
    const useBackground = apiConfig.backgroundProxyUrl && apiConfig.backgroundApiKey && apiConfig.backgroundModel;
    const payload = useBackground
      ? { baseUrl: apiConfig.backgroundProxyUrl, apiKey: apiConfig.backgroundApiKey, model: apiConfig.backgroundModel }
      : { baseUrl: apiConfig.proxyUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
    if (!payload.baseUrl || !payload.apiKey || !payload.model) throw new Error('请先在 PWA 配置后台 API 或主 API');
    payload.temperature = Number(window.state.globalSettings?.apiTemperature) || 0.9;
    const response = await fetch(`${server.backendUrl}/api/background/credentials`, {
      method: 'POST', headers: headers(server, true), body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error || '后台 API 授权失败');
    return result;
  }

  async function subscribePush() {
    const server = getActiveServer();
    if (!server?.backendUrl) throw new Error('请先选择 MCP 后端');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('当前环境不支持 Web Push');
    if (Notification.permission !== 'granted') throw new Error('请先在 PWA 中允许通知权限');
    const keyResponse = await fetch(`${server.backendUrl}/api/push/vapid-public-key`, { headers: headers(server, false) });
    const keyResult = await keyResponse.json();
    if (!keyResponse.ok || !keyResult.publicKey) throw new Error(keyResult.error || '无法获取 VAPID 公钥');
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyResult.publicKey) });
    }
    const response = await fetch(`${server.backendUrl}/api/push/subscriptions`, {
      method: 'POST', headers: headers(server, true), body: JSON.stringify(subscription)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error || 'Push Subscription 上传失败');
    return result;
  }

  async function pullEvents() {
    const server = getActiveServer();
    if (!server?.backendUrl || !server.enableJobs) return { imported: 0, skipped: 0 };
    const response = await fetch(`${server.backendUrl}/api/background/events`, { headers: headers(server, false), cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error || `消息拉取失败（${response.status}）`);
    let imported = 0;
    let skipped = 0;
    for (const event of result.events || []) {
      if (await importEvent(event)) {
        await acknowledge(server, event.id);
        imported += 1;
      } else {
        skipped += 1;
      }
    }
    return { imported, skipped };
  }

  window.mcpBackgroundBridge = {
    buildSnapshots,
    syncSnapshots,
    getStatus,
    pullEvents,
    importEvent,
    authorizeBackgroundApi,
    subscribePush
  };

  window.addEventListener('focus', () => pullEvents().catch(error => console.warn('[MCP] 自动拉取后台消息失败', error)));
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'MCP_PULL_EVENTS') pullEvents().catch(error => console.warn('[MCP] 通知后拉取失败', error));
  });
})();
