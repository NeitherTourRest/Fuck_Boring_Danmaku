/**
 * popup.js —— 弹幕过滤器设置面板
 * DFA（关键词）+ ML（AI）双模式独立控制
 */

// == DOM 引用 ==
const dfaToggle = document.getElementById('dfaToggle');
const mlToggle = document.getElementById('mlToggle');
const mlStatus = document.getElementById('mlStatus');
const dfaCount = document.getElementById('dfaCount');
const mlCount = document.getElementById('mlCount');
const dfaTotal = document.getElementById('dfaTotal');
const mlTotal = document.getElementById('mlTotal');
const totalCount = document.getElementById('totalCount');
const keywordList = document.getElementById('keywordList');
const addInput = document.getElementById('addInput');
const addBtn = document.getElementById('addBtn');
const resetCountsBtn = document.getElementById('resetCountsBtn');
const resetKeywordsBtn = document.getElementById('resetKeywordsBtn');
const logList = document.getElementById('logList');
const logSectionTitle = document.getElementById('logSectionTitle');
const logToggle = document.getElementById('logToggle');
let logVisible = false;

// == 工具函数 ==

async function sendToContent(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: '*://*.bilibili.com/*' });
  if (!tab) return null;
  try { return await chrome.tabs.sendMessage(tab.id, message); }
  catch { return null; }
}

// == UI 更新 ==

function renderKeywordList(keywords) {
  keywordList.innerHTML = '';
  if (keywords.length === 0) {
    keywordList.innerHTML = '<div class="empty-hint">暂无关键词，在上方添加</div>';
    return;
  }
  for (const kw of keywords) {
    const item = document.createElement('div');
    item.className = 'keyword-item';
    const text = document.createElement('span');
    text.className = 'keyword-text';
    text.textContent = kw;
    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = '\u00d7';
    delBtn.addEventListener('click', () => removeKeyword(kw));
    item.appendChild(text);
    item.appendChild(delBtn);
    keywordList.appendChild(item);
  }
}

function updateUI(state) {
  // 更新开关
  if (state.dfaEnabled !== undefined) dfaToggle.checked = state.dfaEnabled;
  if (state.mlEnabled !== undefined) mlToggle.checked = state.mlEnabled;

  // 更新统计
  dfaTotal.textContent = state.dfaCount ?? 0;
  mlTotal.textContent = state.mlCount ?? 0;
  totalCount.textContent = (state.dfaCount ?? 0) + (state.mlCount ?? 0);
  dfaCount.textContent = state.dfaCount ?? 0;
  mlCount.textContent = state.mlCount ?? 0;

  // ML 状态
  if (state.mlReady) {
    mlStatus.textContent = '就绪';
    mlStatus.className = 'ml-status ready';
  } else if (state.mlLoading) {
    mlStatus.textContent = '加载中';
    mlStatus.className = 'ml-status loading';
  } else {
    mlStatus.textContent = '不可用';
    mlStatus.className = 'ml-status';
  }
}

// == 业务逻辑 ==

async function loadSettings() {
  // 直接读 storage 拿开关状态（不依赖 content.js）
  const storage = await chrome.storage.sync.get(['dfaEnabled', 'mlEnabled']);
  dfaToggle.checked = storage.dfaEnabled !== false;
  mlToggle.checked = storage.mlEnabled !== false;

  // 从 content.js 拿关键词和实时统计
  const reply = await sendToContent({ action: 'GET_SETTINGS' });
  if (reply) {
    if (reply.keywords) renderKeywordList(reply.keywords);
    if (reply.stats) updateUI({
      dfaEnabled: reply.dfaEnabled,
      mlEnabled: reply.mlEnabled,
      ...reply.stats,
    });
  } else {
    // content.js 不可达时从 storage 读关键词
    const fallback = await chrome.storage.sync.get(['keywords']);
    if (fallback.keywords) renderKeywordList(fallback.keywords);
  }
}

async function addKeyword(keyword) {
  const trimmed = keyword.trim();
  if (!trimmed) return;
  const reply = await sendToContent({ action: 'ADD_KEYWORD', keyword: trimmed });
  if (reply && reply.success) {
    renderKeywordList(reply.keywords);
    addInput.value = '';
  } else if (reply) {
    addInput.style.borderColor = '#ff4444';
    setTimeout(() => addInput.style.borderColor = '#2a2a4a', 500);
  }
}

async function removeKeyword(keyword) {
  const reply = await sendToContent({ action: 'REMOVE_KEYWORD', keyword });
  if (reply && reply.success) renderKeywordList(reply.keywords);
}

// == 事件绑定 ==

dfaToggle.addEventListener('change', async () => {
  const enabled = dfaToggle.checked;
  await chrome.storage.sync.set({ dfaEnabled: enabled });
  sendToContent({ action: 'SET_DFA_ENABLED', enabled });
});

mlToggle.addEventListener('change', async () => {
  const enabled = mlToggle.checked;
  await chrome.storage.sync.set({ mlEnabled: enabled });
  sendToContent({ action: 'SET_ML_ENABLED', enabled });
});

addBtn.addEventListener('click', () => addKeyword(addInput.value));
addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(addInput.value); } });

resetCountsBtn.addEventListener('click', () => {
  sendToContent({ action: 'RESET_COUNT' });
  dfaTotal.textContent = '0';
  mlTotal.textContent = '0';
  totalCount.textContent = '0';
  dfaCount.textContent = '0';
  mlCount.textContent = '0';
});

resetKeywordsBtn.addEventListener('click', async () => {
  const reply = await sendToContent({ action: 'RESET_KEYWORDS' });
  if (reply && reply.success) renderKeywordList(reply.keywords);
});

// 监听 content.js 推送的统计更新
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STATS_UPDATE') updateUI(message.stats);
  if (message.type === 'INTERCEPTIONS_DATA') renderLog(message.interceptions);
});

// == 拦截记录 ==

logSectionTitle.addEventListener('click', () => {
  logVisible = !logVisible;
  logList.style.display = logVisible ? 'block' : 'none';
  logToggle.textContent = logVisible ? '▼' : '▶';
  if (logVisible) {
    sendToContent({ action: 'GET_INTERCEPTIONS' });
  }
});

function renderLog(interceptions) {
  if (!interceptions || interceptions.length === 0) {
    logList.innerHTML = '<div class="empty-hint">暂无拦截记录</div>';
    return;
  }
  logList.innerHTML = '';
  for (const item of interceptions) {
    const div = document.createElement('div');
    div.className = 'log-item';

    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = item.text;

    const source = document.createElement('span');
    source.className = 'log-source ' + item.source;
    source.textContent = item.source === 'dfa' ? '关键词' : 'AI';

    const okBtn = document.createElement('button');
    okBtn.className = 'log-btn ok';
    okBtn.textContent = '👍';
    okBtn.onclick = (e) => { e.stopPropagation(); okBtn.style.opacity = '0.3'; };

    const fpBtn = document.createElement('button');
    fpBtn.className = 'log-btn fp';
    fpBtn.textContent = '❌';
    fpBtn.onclick = (e) => {
      e.stopPropagation();
      fpBtn.style.opacity = '0.3';
      sendToContent({ action: 'REPORT_FALSE_POSITIVE', text: item.text, source: item.source });
    };

    div.appendChild(text);
    div.appendChild(source);
    div.appendChild(okBtn);
    div.appendChild(fpBtn);
    logList.appendChild(div);
  }
}

// == 启动 ==
loadSettings();
