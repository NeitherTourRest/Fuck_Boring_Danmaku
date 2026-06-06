# Fuck Boring Danmaku 🛡️

> Bilibili 弹幕过滤器 —— 基于关键词（DFA）+ AI（ONNX）双轨过滤，拦截无意义跟风弹幕。

## 功能

- **🔑 关键词过滤 (DFA)**：使用确定性有限自动机（Aho-Corasick 变体）O(n) 匹配预设关键词，毫秒级响应
- **🧠 智能过滤 (ML)**：基于 TinyBERT（6.6M 参数）的 ONNX 模型，语义理解识别 DFA 漏网的弱智弹幕
- **🔄 双轨并行**：DFA 命中直接隐藏（<0.01ms），未命中的交给 ML 异步判断（~10-200ms）
- **📊 弹窗控制**：独立开关 DFA/ML，分项统计拦截数量，关键词列表管理
- **📋 拦截记录**：查看被拦截的弹幕，标记误杀反馈

## 快速开始

### 安装浏览器插件

1. 打开 Chrome → `chrome://extensions`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」 → 选择 `hello-extension/` 目录
4. 打开 Bilibili 任意视频，按 F12 查看 Console 确认 `[弹幕过滤器]` 已启动

### 模型训练（可选）

插件内置了预训练模型（`model_data/model.onnx`，44.5MB），可直接使用。
如需重新训练：

```bash
# 1. 创建 conda 环境
conda env create -n danmaku-train python=3.12 -y

# 2. 安装依赖
conda activate danmaku-train
conda install -c pytorch pytorch torchvision torchaudio cudatoolkit=12.1 -y
pip install transformers datasets onnx onnxruntime scikit-learn tqdm accelerate

# 3. 生成训练数据 + 训练 + 导出
python train.py
```

> 若 Hugging Face 不可达，设置国内镜像：`$env:HF_ENDPOINT='https://hf-mirror.com'`

## 项目结构

```
.
├── hello-extension/              # Chrome 浏览器插件
│   ├── manifest.json             # 插件配置（Manifest V3）
│   ├── content.js                # 桥接层（主世界 ↔ 扩展世界通信）
│   ├── inject.js                 # 核心逻辑（DFA + ML 双轨过滤）
│   ├── popup/
│   │   ├── popup.html            # 弹窗 UI
│   │   └── popup.js              # 弹窗逻辑
│   ├── model_data/
│   │   ├── model.onnx            # ONNX 推理模型（44.5MB）
│   │   ├── config.json           # 模型配置
│   │   └── tokenizer.json        # BERT 分词器
│   ├── lib/
│   │   ├── dfa-engine.js         # DFA 关键词匹配引擎
│   │   └── keywords.js           # 内置关键词预设
│   └── icons/                    # 扩展图标
│
├── train.py                      # 一键微调脚本（环境配置 + 训练 + 导出）
├── generate_dataset.py           # 合成训练数据生成
├── crawl_danmaku.py              # B站弹幕爬虫
├── label_danmaku.py              # 弹幕规则标注
├── merge_dataset.py              # 标注数据合成
│
├── model/                        # 训练产物
│   ├── checkpoint/best/          # PyTorch 最佳检查点
│   ├── model_consolidated.onnx   # ONNX 导出模型
│   └── tokenizer/                # 分词器配置
│
└── stupid danmaku.md             # 过滤规则定义文档
```

## 技术架构

### 过滤流程

```
弹幕出现
    │
    ▼
_checkElement(el)
    │
    ├─ DFA 引擎（关键词匹配，<0.01ms）
    │    └─ 命中 → display: none ✅
    │
    └─ DFA 未命中 → MLClassifier.submit(el, text)
         │
         └─ ONNX Runtime (WASM) 异步推理
              ├─ 判定 "弱智" → display: none ✅
              └─ 判定 "正常" → 不做操作
```

### 通信架构

```
B站页面（主世界）          Content Script（隔离世界）       Popup
     │                          │                        │
     │──postMessage──→          │──chrome.runtime──→      │
     │←──postMessage──          │←──chrome.runtime──      │
     │                          │                        │
     │                          │──chrome.storage──→     │
     │                          │                        │
  inject.js                  content.js               popup.js
```

### 浏览器端 ML 推理

- **运行时**：onnxruntime-web (WASM)，约 5MB
- **模型格式**：ONNX opset 18，BERT Tiny Chinese（6.6M 参数）
- **量化**：FP32（44.5MB，后续可做 INT8 压缩至 ~11MB）
- **分词器**：手写 Chinese BERT 分词器（约 50 行 JS），支持中文字符逐字分割 + ASCII 词表查询

## 数据集

| 数据源 | 数量 | 标签 |
|---|---|---|
| 合成弹幕（模板生成） | 664 条 | 正常/弱智 |
| 真实弹幕（B站热门视频爬取） | 41,363 条 | 规则标注 |
| 最终训练集 | 3,096 条 | 正常 2322 + 弱智 774 |

标注规则定义在 `stupid danmaku.md`，覆盖三类弱智弹幕：
- **抢沙发**：第一、沙发、前排、火钳刘明、N分钟前
- **跟风刷日期**：202X年X月X日打卡、签到、留名
- **弹幕通话**：还有人在看吗、在的扣1、X个人出来

## 模型性能

| 指标 | 值 |
|---|---|
| 模型 | ckiplab/bert-tiny-chinese (6.6M params) |
| 训练数据 | 3,096 条（真实 + 合成） |
| 验证集准确率 | 94.4% |
| ONNX 大小 | 44.5 MB (FP32) |
| 浏览器推理延迟 | ~10-200ms (WASM) |

## 关键词默认预设

内置 23 个关键词，涵盖：
- 刷屏复读：`？？？`、`111`、`哈哈哈`
- 引战攻击：`就这？`、`典中典`、`急了`
- 无意义占位：`第一`、`前排`、`火钳刘明`
- 日期签到：`打卡`、`2024年`、`早上好`

所有关键词可在弹窗中增删。

## 许可证

MIT
