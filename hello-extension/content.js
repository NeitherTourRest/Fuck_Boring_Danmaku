/**
 * ============================================================
 * content.js —— 弹幕过滤器的"通信中心"
 * ============================================================
 *
 * 【这个文件在哪个环境运行？】
 *   运行在 Chrome 扩展的 content script 隔离世界中。
 *   它能调用 chrome.storage 等扩展 API，也能操作页面 DOM，
 *   但不能访问页面主世界的 JS 变量。
 *
 * 【职责】
 *   它是 inject.js（主世界）和 popup.js（设置面板）之间的桥梁：
 *
 *   popup.js  ──chrome.tabs.sendMessage──→  content.js
 *                                               │
 *                                     window.postMessage
 *                                               │
 *   inject.js ←────────────────────────────────┘
 *
 * 【为什么要这么绕？】
 *   - popup 和 inject.js 在不同的执行环境中，不能直接通信
 *   - content.js 是唯一可以同时和两边通信的角色
 */


// =============================================================
// 第1部分：关键词管理（读写 chrome.storage）
// =============================================================

/**
 * 默认关键词列表
 *
 * 这些关键词会在用户第一次安装插件时写入 chrome.storage.sync。
 * chrome.storage.sync 会自动同步到用户登录了同一 Google 账号的其他设备。
 *
 * 为什么用 sync 而不是 local？
 * → sync 跨设备同步，用户体验更好。而且我们的关键词量很小（<100KB），
 *   远低于 sync 的 100KB 限额。
 */
const DEFAULT_KEYWORDS = [
  // --- 刷屏复读 ---
  '？？？？？', '？？？？', '111111', '222222', '333333',
  '666666', 
  // --- 无意义水 ---
  '第一', '前排', '火钳刘明', '考古',
  // --- 烂梗 ---
  '你干嘛', '小黑子', '香精煎鱼', '食不食油饼',
  // --- 引战句式 ---
  '只有我觉得', '难道只有我', '不会只有我',
  // --- 日期时间签到（常见弹幕"报时/打卡"废话） ---
  '打卡',
  '签到',
  '2024年', '2025年', '2026年',
  // --- 测试用 ---
  '还没领'
];

/**
 * 从 chrome.storage.sync 读取关键词列表和开关状态
 *
 * 如果用户从来没设置过（新安装），就用默认值
 *
 * @returns {Promise<{keywords: string[], dfaEnabled: boolean, mlEnabled: boolean}>}
 */
async function loadKeywords() {
  const result = await chrome.storage.sync.get(['keywords', 'dfaEnabled', 'mlEnabled']);
  if (!result.keywords) {
    const defaults = {
      keywords: DEFAULT_KEYWORDS,
      dfaEnabled: true,
      mlEnabled: true,
    };
    await chrome.storage.sync.set(defaults);
    return defaults;
  }
  return {
    keywords: result.keywords,
    dfaEnabled: result.dfaEnabled !== false,
    mlEnabled: result.mlEnabled !== false,
  };
}

/**
 * 保存关键词列表到 chrome.storage.sync
 * @param {string[]} keywords
 */
async function saveKeywords(keywords) {
  await chrome.storage.sync.set({ keywords });
}


// =============================================================
// 第2部分：注入 inject.js 到页面主世界
// =============================================================

/**
 * 将 inject.js 注入到页面主世界
 *
 * 方法：创建一个 <script> 标签，src 指向扩展目录下的 inject.js 文件。
 * 因为 inject.js 在 manifest.json 的 web_accessible_resources 中声明了，
 * 所以页面可以加载它。
 *
 * @param {string[]} keywords - 初始关键词
 * @param {boolean} enabled - 初始开关状态
 */
function injectFilterScript(keywords, dfaEnabled, mlEnabled) {
  document.documentElement.dataset.dmFilterKeywords = JSON.stringify(keywords);
  document.documentElement.dataset.dmDfaEnabled = String(dfaEnabled);
  document.documentElement.dataset.dmMlEnabled = String(mlEnabled);
  document.documentElement.dataset.dmModelUrl = chrome.runtime.getURL('model_data/');

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');

  // 脚本加载完后清理 script 标签（不留下痕迹）
  script.onload = () => {
    script.remove();
    console.log('[弹幕过滤器] inject.js 注入完成');
  };

  script.onerror = () => {
    console.error('[弹幕过滤器] inject.js 注入失败！请检查 manifest.json 中的 web_accessible_resources 配置');
  };

  // 插入到页面中，浏览器会自动执行
  (document.head || document.documentElement).appendChild(script);
}


// =============================================================
// 第3部分：统计缓存 + 消息桥接
// =============================================================

/**
 * 缓存最新的统计信息
 *
 * inject.js 每次拦截弹幕都会通过 postMessage 发送 STATS_UPDATE。
 * 但 popup 可能没打开，所以 chrome.runtime.sendMessage 会失败。
 * 我们把最新值缓存在这里，等 popup 打开时可以直接响应。
 */
let cachedStats = {
  filterCount: 0, dfaCount: 0, mlCount: 0,
  mlReady: false, mlLoading: false,
  keywordCount: 0,
};

/**
 * 监听来自 inject.js 的消息（主世界 → content script）
 *
 * inject.js 通过 window.postMessage 发送统计数据，
 * 我们在这里缓存并转发给 popup（如果 popup 打开着的话）
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'danmaku-filter') return;

  const { type } = event.data;

  if (type === 'STATS_UPDATE') {
    cachedStats = {
      filterCount: event.data.filterCount,
      dfaCount: event.data.dfaCount || 0,
      mlCount: event.data.mlCount || 0,
      mlReady: !!event.data.mlReady,
      mlLoading: !!event.data.mlLoading,
      keywordCount: event.data.keywordCount,
    };
    chrome.runtime.sendMessage({
      type: 'STATS_UPDATE',
      stats: cachedStats,
    }).catch(() => {});
  } else if (type === 'INTERCEPTIONS_DATA') {
    chrome.runtime.sendMessage({
      type: 'INTERCEPTIONS_DATA',
      interceptions: event.data.interceptions,
    }).catch(() => {});
  }
});

/**
 * 监听来自 popup 的消息（popup → content script）
 *
 * popup 通过 chrome.tabs.sendMessage 发送命令，
 * 我们转发给 inject.js（通过 postMessage）
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 命令格式：{ action: 'xxx', ...data }
  switch (message.action) {
    // --- 关键词相关 ---

    case 'GET_KEYWORDS':
      // popup 打开时请求关键词列表
      loadKeywords().then((keywords) => {
        sendResponse({ keywords });
      });
      return true; // 保持消息通道开启（因为用了 async）

    case 'ADD_KEYWORD':
      // 用户添加了一个关键词
      loadKeywords().then(async (keywords) => {
        // 去重：已经存在的关键词不重复添加
        if (!keywords.includes(message.keyword.trim())) {
          keywords.push(message.keyword.trim());
          await saveKeywords(keywords);
          // 同步到 inject.js
          window.postMessage(
            { source: 'danmaku-filter', type: 'UPDATE_KEYWORDS', keywords },
            '*'
          );
          sendResponse({ success: true, keywords });
        } else {
          sendResponse({ success: false, error: '关键词已存在' });
        }
      });
      return true;

    case 'REMOVE_KEYWORD':
      // 用户删除了一个关键词
      loadKeywords().then(async (keywords) => {
        const updated = keywords.filter((k) => k !== message.keyword);
        await saveKeywords(updated);
        // 同步到 inject.js
        window.postMessage(
          { source: 'danmaku-filter', type: 'UPDATE_KEYWORDS', keywords: updated },
          '*'
        );
        sendResponse({ success: true, keywords: updated });
      });
      return true;

    case 'RESET_KEYWORDS':
      // 用户恢复了默认关键词
      saveKeywords(DEFAULT_KEYWORDS).then(() => {
        window.postMessage(
          { source: 'danmaku-filter', type: 'UPDATE_KEYWORDS', keywords: DEFAULT_KEYWORDS },
          '*'
        );
        sendResponse({ success: true, keywords: DEFAULT_KEYWORDS });
      });
      return true;

    // --- DFA / ML 独立开关 ---

    case 'SET_DFA_ENABLED':
      chrome.storage.sync.set({ dfaEnabled: message.enabled });
      window.postMessage(
        { source: 'danmaku-filter', type: 'SET_DFA_ENABLED', enabled: message.enabled },
        '*'
      );
      sendResponse({ success: true });
      break;

    case 'SET_ML_ENABLED':
      chrome.storage.sync.set({ mlEnabled: message.enabled });
      window.postMessage(
        { source: 'danmaku-filter', type: 'SET_ML_ENABLED', enabled: message.enabled },
        '*'
      );
      sendResponse({ success: true });
      break;

    case 'GET_SETTINGS':
      loadKeywords().then((config) => {
        sendResponse({
          keywords: config.keywords,
          dfaEnabled: config.dfaEnabled,
          mlEnabled: config.mlEnabled,
          stats: cachedStats,
        });
      });
      return true;

    // --- 拦截记录 ---

    case 'GET_INTERCEPTIONS':
      // 请求 inject.js 返回拦截记录
      window.postMessage(
        { source: 'danmaku-filter', type: 'GET_INTERCEPTIONS' },
        '*'
      );
      sendResponse({ success: true });
      break;

    case 'REPORT_FALSE_POSITIVE':
      // 用户标记误杀 → 存到本地 + 通知 inject.js
      chrome.storage.local.get({ falsePositives: [] }, (res) => {
        res.falsePositives.push({
          text: message.text,
          source: message.source || 'unknown',
          time: Date.now(),
        });
        chrome.storage.local.set({ falsePositives: res.falsePositives.slice(-500) });
      });
      window.postMessage(
        { source: 'danmaku-filter', type: 'REPORT_FALSE_POSITIVE', text: message.text },
        '*'
      );
      sendResponse({ success: true });
      break;

    case 'GET_FALSE_POSITIVES':
      chrome.storage.local.get({ falsePositives: [] }, (res) => {
        sendResponse({ falsePositives: res.falsePositives });
      });
      return true;

    // --- 统计 ---

    case 'REQUEST_STATS':
      sendResponse({ success: true, stats: cachedStats });
      break;

    case 'RESET_COUNT':
      window.postMessage(
        { source: 'danmaku-filter', type: 'RESET_COUNT' },
        '*'
      );
      sendResponse({ success: true });
      break;
  }
});


// =============================================================
// 第4部分：启动流程
// =============================================================

/**
 * content.js 的入口
 *
 * 执行顺序：
 * 1. 从 storage 加载关键词和开关状态（或初始化默认值）
 * 2. 注入 inject.js 到主世界，同时传入初始配置
 * 3. inject.js 拿到配置后自动开始监控弹幕
 */
(async function () {
  console.log('[弹幕过滤器] content.js 启动中...');

  const config = await loadKeywords();
  console.log(`[弹幕过滤器] 已加载 ${config.keywords.length} 个关键词`);

  injectFilterScript(config.keywords, config.dfaEnabled, config.mlEnabled);
})();
