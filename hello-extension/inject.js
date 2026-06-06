/**
 * ============================================================
 * inject.js —— 弹幕过滤器的"引擎"
 * ============================================================
 *
 * 【这个文件在哪个环境运行？】
 *   它被 content.js 通过 <script> 标签注入到 B站页面里，
 *   运行在页面的"主世界"（main world）中。
 *
 *   为什么不能在 content script 里直接运行？
 *   → Chrome 的 content script 运行在"隔离世界"里，虽然能访问 DOM，
 *     但不能拦截页面自身的网络请求、也访问不到页面上的 JS 变量。
 *     注入到主世界后，我们就能用 MutationObserver 监控弹幕容器了。
 *
 * 【和 content.js 怎么通信？】
 *   主世界不能直接调用 chrome.storage 等扩展 API。
 *   所以通过 window.postMessage 和 content.js 通信：
 *     - content.js → inject.js：传递关键词、开关指令
 *     - inject.js → content.js：报告拦截统计
 *
 * 【文件结构说明】
 *   这个文件自包含以下三个部分：
 *     第1部分：DFA 关键词匹配引擎
 *     第2部分：弹幕过滤核心逻辑
 *     第3部分：和 content.js 的消息通信
 */


// =============================================================
// 第1部分：DFA 关键词匹配引擎
// （和 lib/dfa-engine.js 一样的代码，但因为注入到页面里不能 import，所以直接写在这里）
// =============================================================

class DFAEngine {
  constructor() {
    /** 根节点 —— 前缀树的起点 */
    this.root = this._createNode();
  }

  _createNode() {
    return {
      children: new Map(),  // 子节点映射：字符 → 节点
      isEnd: false,          // 是某个关键词的结尾吗？
      keyword: null,         // 如果是结尾，完整关键词是什么
    };
  }

  /**
   * 添加一个关键词到前缀树
   * 过程：从根节点出发，逐字符往下走，不存在的子节点就创建
   */
  addKeyword(keyword) {
    if (!keyword || keyword.trim().length === 0) return;
    const trimmed = keyword.trim();
    let node = this.root;
    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (!node.children.has(char)) {
        node.children.set(char, this._createNode());
      }
      node = node.children.get(char);
    }
    node.isEnd = true;
    node.keyword = trimmed;
  }

  /** 批量添加 */
  addKeywords(keywords) {
    for (const kw of keywords) {
      this.addKeyword(kw);
    }
  }

  /**
   * 核心方法：判断文本是否包含任意关键词
   *
   * 算法：从文本的每个位置作为起点，在树上往下走。
   * 走到 isEnd 节点 → 命中！
   *
   * @param {string} text - 弹幕文字
   * @returns {boolean}
   */
  matchesAny(text) {
    if (!text || text.length === 0) return false;

    // 从文本的每个字符位置开始尝试
    for (let start = 0; start < text.length; start++) {
      let node = this.root;
      for (let pos = start; pos < text.length; pos++) {
        node = node.children.get(text[pos]);
        if (!node) break;       // 匹配中断，换个起点重来
        if (node.isEnd) return true;  // 命中！
      }
    }
    return false;
  }

  /** 获取关键词总数 */
  getKeywordCount() {
    let count = 0;
    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.isEnd) count++;
      for (const child of node.children.values()) {
        stack.push(child);
      }
    }
    return count;
  }

  /** 清空重建 */
  clear() {
    this.root = this._createNode();
  }
}


// =============================================================
// 第2部分：弹幕过滤核心逻辑
// =============================================================

const DanmakuFilter = {
  // ---------- 状态变量 ----------
  dfaEnabled: true,     // 关键词过滤开关
  mlEnabled: true,      // ML 过滤开关
  dfa: new DFAEngine(), // DFA 引擎实例
  observer: null,       // MutationObserver 实例
  filterCount: 0,       // 总拦截数
  dfaCount: 0,          // DFA 拦截数
  mlCount: 0,           // ML 拦截数
  /** 拦截记录列表（每条含文本、来源、时间戳） */
  interceptions: [],
  /** 最多保留多少条记录 */
  maxLogSize: 200,

  /**
   * 初始化过滤器
   *
   * 做三件事：
   * 1. 用传入的关键词构建 DFA 引擎
   * 2. 等待弹幕容器出现（B站播放器是异步加载的）
   * 3. 容器出现后，开始监听弹幕元素的增删
   *
   * @param {string[]} keywords - 初始关键词列表
   */
  init(keywords) {
    // 第一步：构建关键词匹配引擎
    if (keywords && keywords.length > 0) {
      this.dfa.addKeywords(keywords);
      console.log(
        `[弹幕过滤器] DFA 引擎初始化完成，已加载 ${this.dfa.getKeywordCount()} 个关键词`
      );
    } else {
      console.log('[弹幕过滤器] 关键词列表为空，过滤功能待激活');
    }

    // 第二步：等页面加载出弹幕容器，然后开始监控
    this._waitForContainer();
  },

  /**
   * 工具函数：在 DOM 树中搜索弹幕元素（穿透 Shadow DOM）
   *
   * 为什么需要这个？
   * → B站播放器可能使用 Web Component + Shadow DOM，
   *   普通的 document.querySelector 找不到 Shadow DOM 里的元素。
   *   这个函数递归搜索所有 open Shadow Root，确保不漏掉。
   *
   * @param {string} selector - CSS 选择器
   * @param {Node} root - 搜索起点（默认 document）
   * @returns {Element[]}
   */
  _qsaShadow(selector, root = document) {
    const results = [];
    try {
      // 在当前根节点下搜索
      results.push(...root.querySelectorAll(selector));
      // 再搜索当前根节点下所有元素的 Shadow DOM
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) {
          // 递归搜索 Shadow DOM
          results.push(...this._qsaShadow(selector, el.shadowRoot));
        }
      }
    } catch (e) {
      // 某些节点可能不允许遍历（closed Shadow DOM），静默跳过
    }
    return results;
  },

  /**
   * 启动弹幕过滤
   *
   * 策略：三个层叠的拦截手段
   * 1. MutationObserver（主体）：监听 body 变化，实时处理新增/复用的弹幕
   * 2. 兜底轮询（fallback）：每 2 秒扫描一次，捕获 Shadow DOM 里漏掉的弹幕
   * 3. 容器观察器（寻获后精确定位）：找到弹幕容器后建立精细监听
   *
   * 三层叠加确保不管 B站怎么更新播放器，弹幕都不会漏过。
   */
  _waitForContainer() {
    // --- 兜底轮询：每 2 秒扫描所有弹幕元素 ---
    // 为什么需要轮询？
    // → MutationObserver 看不到 Shadow DOM 内部的变化，
    //   如果弹幕容器在 Shadow DOM 里，observer 不会触发。
    //   轮询虽然笨，但一定能抓到。
    this._startFallbackScan();

    // --- MutationObserver 监听 body（覆盖普通 DOM） ---
    // 监听 body 上所有子节点和属性变化。
    // 一旦发现弹幕元素（bili-danmaku-x-dm）出现就直接处理，
    // 不是等容器出现再处理——这样更快。
    console.log('[弹幕过滤器] 启动 DOM 监听...');
    this._startDOMObserver();

    // --- 也尝试找到弹幕容器，建立精确监听（多一个保障） ---
    this._tryFindContainer();
  },

  /**
   * 兜底轮询：每 2 秒暴力扫描所有弹幕元素
   *
   * 这是最简单的方案——不改 B站怎么渲染弹幕，不管 DOM 在哪里，
   * 每隔 2 秒把页面上所有弹幕元素翻一遍，有命中的就隐藏。
   *
   * 缺点：不是实时的，弹幕出现后最多 2 秒才会被拦截。
   * 但弹幕在屏幕上停留的时间通常 > 5 秒，所以实际效果 OK。
   */
  _startFallbackScan() {
    // 每 2 秒执行一次（如果关闭了过滤就跳过）
    setInterval(() => {
      if (!DanmakuFilter.dfaEnabled && !DanmakuFilter.mlEnabled) return;

      // 搜索所有弹幕元素（普通 DOM + Shadow DOM）
      // 多个候选选择器，防止 B站改名
      const selectors = [
        '.bili-danmaku-x-dm',
        '[class*="bili-danmaku"]',
        '[class*="danmaku"]',
      ];

      for (const sel of selectors) {
        const elements = this._qsaShadow(sel);
        for (const el of elements) {
          // 始终检查并重新隐藏（弹幕被回收时 display:none 会被 B站清除）
          // dataset.danmakuFiltered 只用来防止重复计数，不影响隐藏效果
          this._checkElement(el);
        }
      }
    }, 2000);

    console.log('[弹幕过滤器] 兜底轮询已启动（每 2 秒扫描一次）');
  },

  /**
   * MutationObserver：监听 body 上所有变化
   *
   * 实时捕获普通 DOM 树中的弹幕元素。
   * 因为开了 subtree:true，能覆盖整个页面。
   *
   * 和轮询的区别：observer 是事件驱动的，弹幕出现就处理，延迟 <16ms。
   * 但 observer 看不到 Shadow DOM，所以还要搭配轮询。
   */
  _startDOMObserver() {
    // 如果 body 还不存在，等它出现再开始监听
    const target = document.body || document.documentElement;

    console.log('[弹幕过滤器] 启动 body 级 DOM 监听...');

    const domObserver = new MutationObserver((mutations) => {
      if (!DanmakuFilter.dfaEnabled && !DanmakuFilter.mlEnabled) return;

      for (const mutation of mutations) {
        // 有新元素加入 → 检查是否是弹幕
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // 这个节点本身可能是弹幕
              if (this._isDanmakuElement(node)) {
                this._checkElement(node);
              }
              // 它的子元素里也可能有弹幕（B站有时会包一层容器）
              if (node.querySelectorAll) {
                const nested = node.querySelectorAll(
                  '.bili-danmaku-x-dm, [class*="bili-danmaku"]'
                );
                for (const el of nested) {
                  this._checkElement(el);
                }
              }
            }
          }
        }

        // class 变了 → 可能是弹幕被回收复用
        if (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'class'
        ) {
          const el = mutation.target;
          if (
            (el.classList.contains('bili-danmaku-x-show') ||
             el.classList.contains('bili-danmaku-x-dm'))
          ) {
            this._checkElement(el);
          }
        }
      }
    });

    domObserver.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  },

  /**
   * 判断一个元素是否是弹幕元素
   * @param {Element} el
   * @returns {boolean}
   */
  _isDanmakuElement(el) {
    if (!el.classList) return false;
    // 检查类名是否包含弹幕特征
    return (
      el.classList.contains('bili-danmaku-x-dm') ||
      el.matches('[class*="bili-danmaku"]') ||
      el.matches('[class*="danmaku"]')
    );
  },

  /**
   * 尝试找到弹幕容器，建立精确监听
   *
   * 这和 _startDOMObserver 的区别：
   * 一旦找到容器，我们在这个容器上再建一个 observer，
   * 专门盯着弹幕元素属性变化（class 增删）——这比 body 级的 observer 更精确。
   */
  _tryFindContainer() {
    // B站弹幕容器选择器候选
    const selectors = [
      '.bpx-player-row-dm-wrap',
      '.bilibili-player-danmaku',
      '#bilibili-player .bpx-player-container',
      '.bpx-player-video-wrap',
    ];

    // 先尝试立即找到（可能在普通 DOM 里）
    for (const sel of selectors) {
      const containers = this._qsaShadow(sel);
      if (containers.length > 0) {
        console.log(`[弹幕过滤器] 找到弹幕容器：${sel}`);
        this._startObserving(containers[0]);
        return;
      }
    }

    // 找不到就在 body 上等它出现
    const waitObserver = new MutationObserver(() => {
      for (const sel of selectors) {
        const containers = this._qsaShadow(sel);
        if (containers.length > 0) {
          waitObserver.disconnect();
          console.log(`[弹幕过滤器] 容器出现：${sel}`);
          this._startObserving(containers[0]);
          return;
        }
      }
    });
    waitObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  },

  /**
   * 在弹幕容器上启动 MutationObserver
   *
   * 为什么既要监听 childList 又要监听 attributes？
   * → B站的弹幕元素是"回收利用"的。一条弹幕飞出屏幕后，
   *   它的 DOM 元素不会被删除，而是留在 DOM 池里，
   *   下次要显示新弹幕时，改一下 textContent 和 class 就拿来用。
   *
   *   所以：
   *   - childList：捕获池中新增的元素（第一次创建时）
   *   - attributes（class 变化）：捕获复用元素的"激活"（class 被加上 show）
   *
   * @param {Element} container - 弹幕容器 DOM 元素
   */
  _startObserving(container) {
    // 如果过滤已关闭，只启动"空"的监控（不处理任何弹幕，等开关打开后再生效）
    // 但 Observer 还是要建立，因为开关随时可能被用户打开
    if (!this.dfaEnabled && !this.mlEnabled) {
      console.log('[弹幕过滤器] 过滤已关闭，监控待命中');
    } else {
      // 先处理已经在容器里的弹幕（页面加载时已有的）
      this._scanExisting(container);
    }

    // 然后开始监听后续变化
    this.observer = new MutationObserver((mutations) => {
      // 如果全部关闭，跳过处理
      if (!this.dfaEnabled && !this.mlEnabled) return;

      for (const mutation of mutations) {
        // 情况1：有新的 DOM 节点加进来了
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            // 只处理元素节点（跳过文本节点、注释节点等）
            if (node.nodeType === Node.ELEMENT_NODE) {
              this._checkElement(node);
            }
          }
        }

        // 情况2：已有元素的 class 属性变了（弹幕复用）
        if (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'class'
        ) {
          // 只有当元素"变可见"时才检查
          // B站弹幕可见时有 bili-danmaku-x-show 类
          const el = mutation.target;
          if (el.classList && el.classList.contains('bili-danmaku-x-show')) {
            this._checkElement(el);
          }
        }
      }
    });

    // 启动监听
    this.observer.observe(container, {
      childList: true,       // 监听子节点增删
      subtree: true,         // 监听所有后代（弹幕元素可能嵌套）
      attributes: true,      // 监听属性变化
      attributeFilter: ['class'], // 只关心 class 属性的变化
    });

    console.log('[弹幕过滤器] 弹幕监控已启动');
  },

  /**
   * 扫描容器中已有的弹幕（启动时一次性处理）
   * @param {Element} container
   */
  _scanExisting(container) {
    // 用 _qsaShadow 确保即使在 Shadow DOM 里也能找到
    const existingDanmaku = this._qsaShadow(
      '.bili-danmaku-x-dm, [class*="bili-danmaku"]',
      container
    );
    let checked = 0;
    for (const el of existingDanmaku) {
      this._checkElement(el);
      checked++;
    }
    if (checked > 0) {
      console.log(`[弹幕过滤器] 容器扫描完成，检查了 ${checked} 条已有弹幕`);
    }
  },

  /**
   * 检查单个弹幕元素，如果命中关键词就隐藏
   *
   * 【关键行为变化】
   *   以前：隐藏后打上 data-danmakuFiltered 标记，之后跳过不再检查
   *   现在：每次调用都重新检查并重新隐藏
   *
   * 为什么改？因为 B站回收弹幕元素时会清除 display:none，
   * 所以被回收后同一个元素上的新弹幕需要再次隐藏。
   * data-danmakuFiltered 现在只用于"不重复计数"，不用于"不重复隐藏"。
   *
   * @param {Element} el - DOM 元素
   */
  _checkElement(el) {
    const text = (el.textContent || '').trim();
    if (text.length === 0) return;

    // === 第一阶段：DFA 关键词匹配（已开启时） ===
    if (this.dfaEnabled && this.dfa.matchesAny(text)) {
      el.style.setProperty('display', 'none', 'important');
      if (!el.dataset.danmakuFiltered) {
        el.dataset.danmakuFiltered = 'true';
        this.filterCount++;
        this.dfaCount++;
        this._logInterception(text, 'dfa');
        console.log(`[弹幕过滤器] DFA拦截: "${text}"（共 ${this.filterCount} 条）`);
        this._notifyStats();
      }
      return;
    }

    // === 第二阶段：ML 语义判断（DFA 未命中且 ML 开启时） ===
    if (this.mlEnabled) {
      MLClassifier.submit(el, text);
    }
  },

  /**
   * 更新关键词列表（用户通过 popup 修改后触发）
   *
   * 过程：
   * 1. 清空 DFA 引擎
   * 2. 重新加载所有关键词
   * 3. 重新扫描当前屏幕上已有的弹幕
   *
   * @param {string[]} keywords - 新的关键词列表
   */
  updateKeywords(keywords) {
    this.dfa.clear();
    if (keywords && keywords.length > 0) {
      this.dfa.addKeywords(keywords);
    }
    console.log(
      `[弹幕过滤器] 关键词已更新，当前 ${this.dfa.getKeywordCount()} 个`
    );

    // 重新扫描已有弹幕（因为新关键词可能匹配到旧的弹幕）
    const containers = document.querySelectorAll(
      '.bpx-player-row-dm-wrap, .bilibili-player-danmaku'
    );
    for (const container of containers) {
      this._scanExisting(container);
    }
  },

  /**
   * 设置 DFA 过滤开关
   */
  setDfaEnabled(enabled) {
    const wasDisabled = !this.dfaEnabled;
    this.dfaEnabled = enabled;

    // 从关切换到开：立即扫描当前屏幕上的弹幕
    if (wasDisabled && enabled) {
      const containers = document.querySelectorAll(
        '.bpx-player-row-dm-wrap, .bilibili-player-danmaku'
      );
      for (const container of containers) {
        this._scanExisting(container);
      }
    }
  },

  /**
   * 设置 ML 过滤开关
   */
  setMlEnabled(enabled) {
    this.mlEnabled = enabled;
  },

  /**
   * 重置拦截计数
   */
  resetCount() {
    this.filterCount = 0;
    this._notifyStats();
  },

  /**
   * 记录拦截日志（供弹窗查看）
   */
  _logInterception(text, source) {
    this.interceptions.unshift({ text, source, time: Date.now() });
    if (this.interceptions.length > this.maxLogSize) {
      this.interceptions.length = this.maxLogSize;
    }
  },

  /**
   * 通知 content.js：统计数据更新了
   *
   * postMessage 是主世界和 content script 之间的唯一通信方式。
   * source 字段标记这是来自过滤器的消息，避免和其他页面脚本混淆。
   */
  _notifyStats() {
    window.postMessage(
      {
        source: 'danmaku-filter',
        type: 'STATS_UPDATE',
        filterCount: this.filterCount,
        dfaCount: this.dfaCount,
        mlCount: this.mlCount,
        mlReady: MLClassifier.ready,
        mlLoading: MLClassifier.loading,
        keywordCount: this.dfa.getKeywordCount(),
      },
      '*'
    );
  },
};


// =============================================================
// 第2.5部分：ML 模型分类器（DFA 没命中时的兜底）
// =============================================================

/**
 * MLClassifier —— 浏览器端 ML 推理模块
 *
 * 加载 Transformers.js 和微调后的 ONNX 模型，
 * 对 DFA 未命中的弹幕做语义级别判断。
 *
 * 为什么不用 Transformers.js 也做关键词过滤？
 * → DFA 是 O(n) 时间复杂度，一次匹配 <0.01ms；
 *   ML 推理每次 ~10-200ms。DFA 能秒杀的没必要让 ML 跑。
 *
 * 所以策略是：
 *   DFA 先跑 → 命中则隐藏（<1ms）
 *   DFA 没命中 → 交给 ML 判断（~10-200ms 异步返回）
 */
const MLClassifier = {
  // ---------- 状态 ----------
  session: null,       // ONNX Runtime 推理会话
  vocab: null,         // 分词器词表 { token: id }
  config: null,        // 模型配置
  ready: false,        // 模型是否已加载完成
  queue: [],
  processing: false,
  modelUrl: null,

  // BERT 特殊 token 的 ID
  CLS_ID: 101,
  SEP_ID: 102,
  PAD_ID: 0,
  UNK_ID: 100,

  /**
   * 初始化 ML 分类器
   *
   * 步骤：
   * 1. 从 CDN 加载 onnxruntime-web（负责运行 ONNX 模型）
   * 2. 下载 config.json + tokenizer.json + model.onnx
   * 3. 创建推理会话
   */
  async init() {
    this.modelUrl = document.documentElement.dataset.dmModelUrl;
    if (!this.modelUrl) {
      console.log('[弹幕过滤器] ML: 未找到模型 URL，使用 DFA-only 模式');
      return;
    }

    this.loading = true;
    try {
      // Step 1: 加载 onnxruntime-web
      await this._loadONNXRuntime();
      console.log('[弹幕过滤器] ML: onnxruntime-web 已加载');

      // Step 2: 下载所有文件（模型已合并为单文件，无外部依赖）
      console.log('[弹幕过滤器] ML: 下载模型文件（44.5MB，首次较慢）...');
      const [configJson, tokenizerJson, modelBuffer] = await Promise.all([
        fetch(this.modelUrl + 'config.json').then(r => r.json()),
        fetch(this.modelUrl + 'tokenizer.json').then(r => r.json()),
        fetch(this.modelUrl + 'model.onnx').then(r => r.arrayBuffer()),
      ]);
      this.config = configJson;
      this.vocab = tokenizerJson.model.vocab;
      console.log(`[弹幕过滤器] ML: 词表大小 ${Object.keys(this.vocab).length}`);

      // Step 3: 配置 WASM 路径并从内存创建推理会话
      if (!ort.env.wasm) ort.env.wasm = {};
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
      console.log('[弹幕过滤器] ML: 初始化 ONNX Runtime...');
      this.session = await ort.InferenceSession.create(modelBuffer);
      this.ready = true;
      console.log('[弹幕过滤器] ML: 模型已加载，双轨过滤就绪 (DFA + ML)');

      // 处理积压的队列
      this._processQueue();
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e || '未知错误');
      console.warn('[弹幕过滤器] ML: 加载失败，使用 DFA-only 模式:', msg);
    } finally {
      this.loading = false;
    }
  },

  /**
   * 加载 onnxruntime-web
   *
   * 用 <script src="..."> 加载 UMD 构建，
   * 加载后全局可用 `window.ort`
   */
  async _loadONNXRuntime() {
    // onnxruntime-web 的 UMD 构建（可用普通 <script> 加载）
    // 注：版本号需要和 npm 上的实际版本一致
    const CDN_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js';
    const CDN_FALLBACK = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js';

    // 如果已经被加载了，跳过
    if (typeof window.ort !== 'undefined' && window.ort && window.ort.InferenceSession) {
      return;
    }

    const urls = [CDN_URL, CDN_FALLBACK];
    
    for (const url of urls) {
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = url;
          const timer = setTimeout(() => reject(new Error('加载超时（30s）')), 30000);
          script.onload = () => {
            clearTimeout(timer);
            // 给 ORT 一点时间初始化 WASM 上下文
            setTimeout(() => {
              if (window.ort) {
                resolve();
              } else {
                reject(new Error('ort 未定义，可能 URL 不是 UMD 构建'));
              }
            }, 500);
          };
          script.onerror = () => {
            clearTimeout(timer);
            reject(new Error('CDN 不可达'));
          };
          (document.head || document.documentElement).appendChild(script);
        });
        return; // 成功
      } catch (e) {
        console.log(`[弹幕过滤器] ML: CDN 加载失败: ${e.message}`);
      }
    }
    throw new Error('所有 CDN 源都失败');
  },

  /**
   * BERT 中文分词器
   *
   * BERT 中文模型的分词规则：
   * - 中文字符：逐字分割，每个字单独成 token
   * - ASCII：按空格分词后，查 vocab，找不到则拆成字符
   * - 添加 [CLS] 和 [SEP]
   * - 填充到固定长度
   *
   * @param {string} text - 输入文本
   * @param {number} maxLen - 最大长度（含特殊 token）
   * @returns {{ inputIds: number[], attentionMask: number[] }}
   */
  _tokenize(text, maxLen = 32) {
    // 初始化 token 列表，以 [CLS] 开头
    const tokens = [this.CLS_ID];
    const CHINESE_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

    let i = 0;
    while (i < text.length) {
      const char = text[i];

      if (CHINESE_RE.test(char)) {
        // 中文字符：查词表
        tokens.push(this.vocab[char] !== undefined ? this.vocab[char] : this.UNK_ID);
        i++;
      } else if (/\s/.test(char)) {
        // 空白字符：跳过
        i++;
      } else {
        // ASCII / 标点等：收集连续的非中文字符
        let word = '';
        while (i < text.length && !CHINESE_RE.test(text[i]) && !/\s/.test(text[i])) {
          word += text[i];
          i++;
        }
        // 尝试查词表
        if (this.vocab[word] !== undefined) {
          tokens.push(this.vocab[word]);
        } else {
          // 词表找不到，逐个字符处理
          for (let j = 0; j < word.length; j++) {
            const c = word[j];
            tokens.push(this.vocab[c] !== undefined ? this.vocab[c] : this.UNK_ID);
          }
        }
      }

      // 截断到 maxLen-1（给 [SEP] 留位置）
      if (tokens.length >= maxLen - 1) break;
    }

    // 添加 [SEP]
    tokens.push(this.SEP_ID);

    // 填充到 maxLen
    const inputIds = new Array(maxLen).fill(this.PAD_ID);
    const attentionMask = new Array(maxLen).fill(0);
    for (let j = 0; j < tokens.length && j < maxLen; j++) {
      inputIds[j] = tokens[j];
      attentionMask[j] = 1;
    }

    return { inputIds, attentionMask };
  },

  /**
   * 提交一条弹幕给 ML 判断
   */
  submit(el, text) {
    if (!this.ready) return;
    this.queue.push({ el, text });
    if (!this.processing) this._processQueue();
  },

  /**
   * 处理队列
   */
  async _processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const { el, text } = this.queue.shift();

      try {
        // 分词
        const { inputIds, attentionMask } = this._tokenize(text);

        // 创建 ONNX tensor（BigInt64Array 适用于 int64 输入）
        // 注：如果报 "unsupported type"，换成 Int32Array + 'int32'
        const inputIdsTensor = new ort.Tensor(
          'int64', BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]
        );
        const maskTensor = new ort.Tensor(
          'int64', BigInt64Array.from(attentionMask.map(BigInt)), [1, attentionMask.length]
        );

        // 推理
        const results = await this.session.run({
          input_ids: inputIdsTensor,
          attention_mask: maskTensor,
        });

        // 解析结果
        // logits shape: [1, 2] — [label_0_score, label_1_score]
        const logits = results.logits.data;
        const isStupid = logits[1] > logits[0];

        if (isStupid) {
          el.style.setProperty('display', 'none', 'important');
          if (!el.dataset.danmakuFiltered) {
            el.dataset.danmakuFiltered = 'true';
            DanmakuFilter.filterCount++;
            DanmakuFilter.mlCount++;
            DanmakuFilter._logInterception(text, 'ml');
            console.log(
              `[弹幕过滤器] ML拦截: "${text.slice(0, 15)}"（DFA:${DanmakuFilter.dfaCount} ML:${DanmakuFilter.mlCount}）`
            );
            DanmakuFilter._notifyStats();
          }
        }
      } catch (e) {
        // 单条推理失败，静默跳过
      }
    }

    this.processing = false;
  },
};


// =============================================================
// 第3部分：初始化 —— 脚本被注入后立即执行
// =============================================================

(function () {
  /**
   * 整个脚本的入口点
   *
   * 这是一个"立即执行函数"（IIFE）。
   * 为什么要包在函数里？
   * → 防止变量污染页面全局作用域。B站页面本身有大量 JS，
   *   我们不希望自己的变量和页面的变量冲突。
   */

  // =============================================================
  // 从 content script 的隔离世界读取初始配置
  // =============================================================
  //
  // Chrome 把 content script 和主世界的 JS 隔离在不同的环境里。
  // content.js 设置的 window.__XXX__ 变量，主世界读不到。
  //
  // 解决方案：content.js 把数据写到了 document.documentElement 的
  // dataset 属性上（data-dm-filter-keywords / data-dm-filter-enabled）。
  // DOM 是共享的，两个世界都能读写。

  let initialKeywords = [];
  let initialDfaEnabled = true;
  let initialMlEnabled = true;

  try {
    const keywordsRaw = document.documentElement.dataset.dmFilterKeywords;
    if (keywordsRaw) initialKeywords = JSON.parse(keywordsRaw);

    const dfaRaw = document.documentElement.dataset.dmDfaEnabled;
    if (dfaRaw === 'false') initialDfaEnabled = false;

    const mlRaw = document.documentElement.dataset.dmMlEnabled;
    if (mlRaw === 'false') initialMlEnabled = false;
  } catch (e) {
    console.warn('[弹幕过滤器] 读取初始配置失败:', e);
  }

  DanmakuFilter.dfaEnabled = initialDfaEnabled;
  DanmakuFilter.mlEnabled = initialMlEnabled;

  // 初始化过滤器（如果 enabled=false，init 会记录日志但不启动监控）
  DanmakuFilter.init(initialKeywords);

  // 异步加载 ML 模型（不阻塞过滤，加载完成前使用 DFA-only 模式）
  // 初始化 ML 分类器（从 CDN 加载 Transformers.js + 加载 ONNX 模型）
  MLClassifier.init();

  /**
   * 监听来自 content.js 的指令
   *
   * content.js 通过 window.postMessage 发送命令，
   * 我们在主世界里监听这些消息。
   *
   * 注意：需要验证消息来源！
   * → 页面上可能有其他脚本也在用 postMessage，
   *   我们只处理 source === 'danmaku-filter' 的消息。
   */
  window.addEventListener('message', (event) => {
    // 安全检查：只处理我们自己的消息
    if (event.data && event.data.source === 'danmaku-filter') {
      const { type } = event.data;

      switch (type) {
        case 'UPDATE_KEYWORDS':
          // 用户修改了关键词列表
          DanmakuFilter.updateKeywords(event.data.keywords);
          break;

        case 'SET_DFA_ENABLED':
          DanmakuFilter.setDfaEnabled(event.data.enabled);
          break;

        case 'SET_ML_ENABLED':
          DanmakuFilter.setMlEnabled(event.data.enabled);
          break;

        case 'GET_STATS':
          // content.js 请求当前统计数据
          DanmakuFilter._notifyStats();
          break;

        case 'RESET_COUNT':
          DanmakuFilter.resetCount();
          break;

        case 'GET_INTERCEPTIONS':
          // 弹窗请求拦截记录
          window.postMessage({
            source: 'danmaku-filter',
            type: 'INTERCEPTIONS_DATA',
            interceptions: DanmakuFilter.interceptions.slice(0, 100),
          }, '*');
          break;

        case 'REPORT_FALSE_POSITIVE':
          // 用户标记了一条误杀
          DanmakuFilter._logInterception(event.data.text, '👍fp');
          break;
      }
    }
  });

  // 清理注入标记（避免 content.js 重复注入）
  // delete 操作放在这里确保只注入一次
  // 注意：实际防重复逻辑在 content.js 里

  console.log('[弹幕过滤器] v0.1.0 已启动');
})();
