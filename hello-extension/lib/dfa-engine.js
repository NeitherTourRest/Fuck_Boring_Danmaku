/**
 * ============================================================
 * DFA（确定性有限自动机）关键词匹配引擎
 * ============================================================
 *
 * 【这是什么】
 *   一个"多关键词同时搜索"的工具。比如你有 100 个要过滤的词，
 *   这个引擎能在一次文本扫描中全部检出，不需要逐个关键词去比对。
 *
 * 【为什么用这个而不是 indexOf/includes？】
 *   假设你有 500 个关键词，每条弹幕都用 indexOf 逐个检查：
 *     500 个词 × 每条弹幕 = 500 次字符串查找，很慢。
 *   DFA 的做法：不管有多少关键词，只扫描弹幕文本一次。
 *   关键词越多，优势越明显。
 *
 * 【原理：前缀树（Trie）】
 *   把所有关键词的每个字组织成一棵树，共享相同的前缀。
 *   例子：关键词 = ["你好", "你坏", "他们"]
 *
 *       根节点
 *       ├─ 你 ─ 好 （命中！关键词："你好"）
 *       │    └─ 坏 （命中！关键词："你坏"）
 *       └─ 他 ─ 们 （命中！关键词："他们"）
 *
 *   扫描 "你好啊" 时：从"你"进入→找到"好"=命中"你好"→返回 true
 *   扫描 "他们来"时：从"他"进入→找到"们"=命中"他们"→返回 true
 *   扫描 "不好"  时：从"不"进入→根节点没有"不"→跳过，继续从"好"开始
 *
 * 【性能】
 *   时间复杂度 O(n × L)，n=文本长度，L=最长关键词长度
 *   弹幕通常 1-30 字，关键词通常 1-8 字
 *   单次匹配 <0.01ms，完全满足实时过滤需求
 */

class DFAEngine {
  constructor() {
    /**
     * 根节点 —— 整棵前缀树的起点
     *
     * 每个节点的结构：
     * {
     *   children: Map<char, node>  —— 子节点映射（字符 → 下一个节点）
     *   isEnd: boolean              —— 这个节点是否是某个关键词的结尾？
     *   keyword: string | null      —— 如果是结尾，记录完整的关键词文本
     * }
     */
    this.root = this._createNode();
  }

  /**
   * 创建一个新节点（工厂方法，保证节点结构一致）
   * @returns {{children: Map, isEnd: boolean, keyword: null}}
   */
  _createNode() {
    return {
      children: new Map(), // 用 Map 而不是 {} 对象，因为中文字符做 key 更安全
      isEnd: false,
      keyword: null,
    };
  }

  /**
   * 向引擎中添加一个关键词
   *
   * 过程：从根节点出发，逐字沿着树往下走。
   * 如果某个字对应的子节点不存在，就创建一个。
   * 走到最后一个字时，标记 isEnd = true。
   *
   * 例子：添加 "你好"
   *   根 → 找"你" → 没有 → 创建节点A
   *   节点A → 找"好" → 没有 → 创建节点B，标记 isEnd=true, keyword="你好"
   *
   * @param {string} keyword - 要添加的关键词
   */
  addKeyword(keyword) {
    // 跳过空字符串（用户可能误添加了空白行）
    if (!keyword || keyword.trim().length === 0) return;

    const trimmed = keyword.trim();
    let node = this.root;

    // 逐字构建/遍历前缀树
    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];

      // 如果当前字符对应的子节点不存在，创建一个
      if (!node.children.has(char)) {
        node.children.set(char, this._createNode());
      }

      // 继续往下走
      node = node.children.get(char);
    }

    // 走到关键词末尾，打上"命中标记"
    node.isEnd = true;
    node.keyword = trimmed;
  }

  /**
   * 批量添加关键词
   * @param {string[]} keywords - 关键词数组
   */
  addKeywords(keywords) {
    for (const kw of keywords) {
      this.addKeyword(kw);
    }
  }

  /**
   * 判断文本是否包含任意一个关键词
   *
   * 算法：从文本的每个字符位置开始，尝试在树上匹配。
   * 只要有一处完整匹配到某个关键词，立即返回 true。
   *
   * 例子：树里有 "你好"
   *   matchesAny("你好啊")  → 从位置0开始，"你"→"好"→命中！→ return true
   *   matchesAny("不好")   → 位置0"不"不在树里→跳过；位置1"好"没有"你"作为前缀→跳过 → return false
   *
   * @param {string} text - 要检查的文本
   * @returns {boolean} - 是否包含关键词
   */
  matchesAny(text) {
    if (!text || text.length === 0) return false;

    // 从文本的每个位置作为起点，尝试匹配
    // 比如文本 "ABC"，先尝试从 A 开始匹配，再从 B 开始，再从 C 开始
    for (let start = 0; start < text.length; start++) {
      let node = this.root;

      // 从 start 位置向后逐字尝试，看能不能走到一个 isEnd 节点
      for (let pos = start; pos < text.length; pos++) {
        const char = text[pos];
        node = node.children.get(char);

        // 树里没有这个字 → 当前起点匹配失败，换下一个起点
        if (!node) break;

        // 走到了一个关键词的末尾 → 命中！
        if (node.isEnd) return true;
      }
    }

    // 所有起点都试过了，没找到任何关键词
    return false;
  }

  /**
   * 在文本中搜索所有命中的关键词（去重）
   *
   * 和 matchesAny 逻辑一样，但不是找到第一个就返回，
   * 而是收集所有命中的关键词。
   *
   * @param {string} text - 要搜索的文本
   * @returns {string[]} - 命中的关键词列表（已去重）
   */
  searchAll(text) {
    if (!text || text.length === 0) return [];

    const found = new Set(); // 用 Set 自动去重

    for (let start = 0; start < text.length; start++) {
      let node = this.root;

      for (let pos = start; pos < text.length; pos++) {
        const char = text[pos];
        node = node.children.get(char);
        if (!node) break;
        if (node.isEnd) found.add(node.keyword);
      }
    }

    return Array.from(found);
  }

  /**
   * 获取当前引擎中的关键词总数
   * （遍历整棵树数 isEnd 节点数）
   * @returns {number}
   */
  getKeywordCount() {
    let count = 0;
    const stack = [this.root];

    while (stack.length > 0) {
      const node = stack.pop();
      if (node.isEnd) count++;
      // 把所有子节点加入待检查列表
      for (const child of node.children.values()) {
        stack.push(child);
      }
    }

    return count;
  }

  /**
   * 清空所有关键词（重建根节点）
   */
  clear() {
    this.root = this._createNode();
  }
}
