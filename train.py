"""
B站弹幕过滤器 —— 微调 TinyBERT-zh + 导出 ONNX

用法：
  1. 首次使用：python train.py           # 自动创建 conda 环境、安装依赖、开始训练
  2. 后续使用：python train.py --resume   # 继续训练已有 checkpoint

输出文件：
  model/checkpoint/    ← PyTorch 检查点
  model/model.onnx     ← 浏览器可用的 ONNX 模型（量化后约 14MB）
  model/tokenizer/     ← 分词器文件（浏览器端也需要）
"""

import os
import sys
import json
import argparse
import subprocess
import shutil

# =============================================================
# 第1部分：环境检查与自动配置
# =============================================================

CONDA_ENV_NAME = "danmaku-train"
PYTHON_VERSION = "3.12"

# pip 安装的包（conda 环境中用 pip 装）
REQUIRED_PACKAGES = [
    "transformers>=4.30",
    "datasets>=2.10",
    "onnx>=1.14",
    "scikit-learn",
    "tqdm",
    "protobuf",
]

# PyTorch：用 CPU 版（CUDA 版 2.5GB 在你这台机器上下载不稳定）
TORCH_PACKAGES = ["torch", "torchvision", "torchaudio"]

# ONNX Runtime：推理加速
ONNX_PACKAGES = [
    "onnxruntime-gpu>=1.15",
    "onnxruntime-tools",
]


def run_cmd(cmd, capture=False):
    """执行系统命令，返回输出"""
    print(f"  $ {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=capture, text=True)
    if capture:
        return result.stdout.strip()
    return result.returncode


def ensure_conda_env():
    """检查 conda 环境是否存在，不存在则创建并安装依赖"""
    # 检查环境是否已存在
    output = run_cmd(f"conda env list", capture=True)
    if CONDA_ENV_NAME not in output:
        print(f"[...] 正在创建 conda 环境: {CONDA_ENV_NAME} (Python {PYTHON_VERSION})")
        ret = run_cmd(f"conda create -n {CONDA_ENV_NAME} python={PYTHON_VERSION} -y")
        if ret != 0:
            print("[FAIL] 创建 conda 环境失败！请手动运行:")
            print(f"    conda create -n {CONDA_ENV_NAME} python={PYTHON_VERSION} -y")
            return False
        freshly_created = True
    else:
        print(f"[OK] 环境 {CONDA_ENV_NAME} 已存在")
        freshly_created = False

    # 检查 PyTorch 是否已安装，缺失则安装
    torch_ok = run_cmd(
        f"conda run -n {CONDA_ENV_NAME} python -X utf8 -c \"import torch; print('OK')\"",
        capture=True,
    )
    if "OK" not in torch_ok:
        print(f"[...] PyTorch 未安装，正在安装（约 2-3 分钟）...")
        ret = run_cmd(
            f"conda run -n {CONDA_ENV_NAME} pip install {' '.join(TORCH_PACKAGES)} --index-url https://download.pytorch.org/whl/cpu"
        )
        if ret != 0:
            print("[WARN] 官方源安装失败，尝试默认源...")
            run_cmd(f"conda run -n {CONDA_ENV_NAME} pip install {' '.join(TORCH_PACKAGES)}")

    # 检查关键依赖是否安装
    pip_list = run_cmd(
        f"conda run -n {CONDA_ENV_NAME} pip list --format=json 2>nul",
        capture=True,
    )
    import json
    try:
        installed = {p["name"].lower() for p in json.loads(pip_list)}
    except:
        installed = set()

    all_pips = REQUIRED_PACKAGES + ONNX_PACKAGES
    for pkg in all_pips:
        pkg_name = pkg.split(">=")[0].split("<=")[0].split("==")[0].lower()
        if pkg_name not in installed:
            print(f"  [INSTALL] {pkg}...")
            run_cmd(f"conda run -n {CONDA_ENV_NAME} pip install {pkg} -q")

    print(f"[OK] 环境就绪！")
    return True


# =============================================================
# 第2部分：数据准备
# =============================================================

TRAINING_SCRIPT = r'''
import json
import torch
import numpy as np
from transformers import (
    AutoTokenizer,
    AutoModelForSequenceClassification,
    TrainingArguments,
    Trainer,
    EarlyStoppingCallback,
)
from datasets import Dataset, DatasetDict
from sklearn.metrics import accuracy_score, precision_recall_fscore_support
from tqdm import tqdm
import os

# ---------- 配置 ----------
MODEL_NAME = "ckiplab/bert-tiny-chinese"  # 6.6M参数的中文BERT微型模型
DATA_PATH = "danmaku_dataset.json"
OUTPUT_DIR = "model"
MAX_LENGTH = 16          # 弹幕很短，16 token 足够（避免 PAD 稀释信号）
BATCH_SIZE = 16
EPOCHS = 8
LEARNING_RATE = 3e-5

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(f"{OUTPUT_DIR}/checkpoint", exist_ok=True)

# ---------- 加载数据 ----------
print("[1/6] 加载数据集...")
with open(DATA_PATH, "r", encoding="utf-8") as f:
    raw_data = json.load(f)

texts = [d["text"] for d in raw_data]
labels = [d["label"] for d in raw_data]

# 计算类别权重（处理数据不平衡）
class_counts = np.bincount(labels)
total = len(labels)
class_weights = total / (len(class_counts) * class_counts)
print(f"  类别分布: label 0={class_counts[0]}, label 1={class_counts[1]}")
print(f"  类别权重: {class_weights}")

# 划分训练/验证集（8:2）
from sklearn.model_selection import train_test_split
train_texts, val_texts, train_labels, val_labels = train_test_split(
    texts, labels, test_size=0.2, random_state=42, stratify=labels
)
print(f"  训练集: {len(train_texts)} 条")
print(f"  验证集: {len(val_texts)} 条")

# ---------- 加载分词器和模型 ----------
print("[2/6] 下载 TinyBERT-zh 预训练模型（首次约 55MB）...")
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModelForSequenceClassification.from_pretrained(
    MODEL_NAME,
    num_labels=2,  # 二分类：正常 / 弱智
)

# ---------- 分词 ----------
print("[3/6] 分词...")
def tokenize_function(examples):
    return tokenizer(
        examples["text"],
        padding="max_length",
        truncation=True,
        max_length=MAX_LENGTH,
    )

train_dataset = Dataset.from_dict({"text": train_texts, "label": train_labels})
val_dataset = Dataset.from_dict({"text": val_texts, "label": val_labels})

train_dataset = train_dataset.map(tokenize_function, batched=True)
val_dataset = val_dataset.map(tokenize_function, batched=True)

# 设置 PyTorch 格式
train_dataset.set_format("torch", columns=["input_ids", "attention_mask", "label"])
val_dataset.set_format("torch", columns=["input_ids", "attention_mask", "label"])

# ---------- 训练 ----------
print("[4/6] 开始训练（约 3-10 分钟，取决于 CPU/GPU）...")
print(f"  模型: {MODEL_NAME}")
print(f"  batch_size: {BATCH_SIZE}")
print(f"  epochs: {EPOCHS}")
print(f"  learning_rate: {LEARNING_RATE}")
print(f"  max_length: {MAX_LENGTH}")

training_args = TrainingArguments(
    output_dir=f"{OUTPUT_DIR}/checkpoint",
    num_train_epochs=EPOCHS,
    per_device_train_batch_size=BATCH_SIZE,
    per_device_eval_batch_size=BATCH_SIZE * 2,
    learning_rate=LEARNING_RATE,
    warmup_ratio=0.1,
    logging_steps=20,
    eval_strategy="epoch",
    save_strategy="epoch",
    save_total_limit=2,
    load_best_model_at_end=True,
    metric_for_best_model="f1",
    greater_is_better=True,
    # CPU 训练（没检测到 GPU 时自动使用 CPU）
    use_cpu=not torch.cuda.is_available(),
)

def compute_metrics(eval_pred):
    logits, labels = eval_pred
    predictions = np.argmax(logits, axis=-1)
    precision, recall, f1, _ = precision_recall_fscore_support(
        labels, predictions, average="binary"
    )
    acc = accuracy_score(labels, predictions)
    return {
        "accuracy": acc,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }

trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=train_dataset,
    eval_dataset=val_dataset,
    compute_metrics=compute_metrics,
    callbacks=[EarlyStoppingCallback(early_stopping_patience=2)],
)

trainer.train()

# ---------- 保存模型 + tokenizer ----------
print("[5/6] 保存模型...")
model.save_pretrained(f"{OUTPUT_DIR}/checkpoint/best")
tokenizer.save_pretrained(f"{OUTPUT_DIR}/tokenizer")
print(f"  PyTorch 模型: {OUTPUT_DIR}/checkpoint/best/")
print(f"  Tokenizer: {OUTPUT_DIR}/tokenizer/")

# 评估最佳模型
print(f"\\n最佳模型评估结果:")
eval_result = trainer.evaluate(f"{OUTPUT_DIR}/checkpoint/best")
for k, v in eval_result.items():
    print(f"  {k}: {v:.4f}")

# ---------- 导出 ONNX ----------
print("[6/6] 导出 ONNX 模型...")
from transformers.onnx import export, FeaturesManager

# TinyBERT 的 ONNX 配置
model_kind, model_onnx_config = FeaturesManager.check_supported_model_or_raise(model, feature="sequence-classification")
onnx_config = model_onnx_config(model.config)

# 导出
onnx_output_path = f"{OUTPUT_DIR}/model.onnx"
export(
    tokenizer=tokenizer,
    model=model,
    config=onnx_config,
    opset=14,
    output=onnx_output_path,
)
print(f"  ONNX 模型: {onnx_output_path}")

# ---------- 量化压缩 ----------
print("\\n[+] 进行 INT8 量化压缩...")
import onnx
from onnxruntime.quantization import quantize_dynamic, QuantType

model_fp32 = onnx.load(onnx_output_path)
quantized_path = f"{OUTPUT_DIR}/model_quantized.onnx"
quantize_dynamic(
    model_fp32,
    quantized_path,
    weight_type=QuantType.QInt8,
)
print(f"  量化前: {os.path.getsize(onnx_output_path) / 1024 / 1024:.1f} MB")
print(f"  量化后: {os.path.getsize(quantized_path) / 1024 / 1024:.1f} MB")
print(f"  量化模型: {quantized_path}")

# ---------- 测试推理（验证导出正确） ----------
print("\\n[+] 验证 ONNX 推理...")
import onnxruntime as ort

session = ort.InferenceSession(quantized_path)
# 用验证集第一条测试
sample = val_texts[0]
inputs = tokenizer(sample, return_tensors="np", padding="max_length", truncation=True, max_length=MAX_LENGTH)
ort_inputs = {k: v for k, v in inputs.items()}
ort_outputs = session.run(None, ort_inputs)
pred = np.argmax(ort_outputs[0][0])
print(f"  测试样本: \"{sample}\"")
print(f"  真实标签: {val_labels[0]} ({'正常' if val_labels[0]==0 else '弱智'})")
print(f"  预测标签: {int(pred)} ({'正常' if pred==0 else '弱智'})")

# 统计验证集准确率
correct = 0
total_val = len(val_texts)
for i in tqdm(range(total_val), desc="验证集评估"):
    inputs = tokenizer(val_texts[i], return_tensors="np", padding="max_length", truncation=True, max_length=MAX_LENGTH)
    ort_inputs = {k: v for k, v in inputs.items()}
    ort_outputs = session.run(None, ort_inputs)
    pred = np.argmax(ort_outputs[0][0])
    if pred == val_labels[i]:
        correct += 1

print(f"[+] ONNX 模型验证集准确率: {correct}/{total_val} = {correct/total_val*100:.1f}%")
print(f"[DONE] 训练完成！生成的模型文件：")
print(f"  {OUTPUT_DIR}/model_quantized.onnx（浏览器端使用这个）")
print(f"  {OUTPUT_DIR}/tokenizer/（分词器，浏览器端也需要）")
print(f"  {OUTPUT_DIR}/checkpoint/best/（PyTorch 原始模型）")
'''


# =============================================================
# 第3部分：主入口
# =============================================================

def main():
    parser = argparse.ArgumentParser(description="微调 TinyBERT-zh 用于弹幕过滤")
    parser.add_argument("--resume", action="store_true", help="继续训练已有 checkpoint")
    parser.add_argument("--skip-env", action="store_true", help="跳过环境配置")
    args = parser.parse_args()

    print("=" * 50)
    print("B站弹幕过滤器 — 模型微调工具")
    print("=" * 50)
    print()

    # 创建 conda 环境
    if not args.skip_env:
        if not ensure_conda_env():
            sys.exit(1)
    else:
        print("[OK] 跳过环境配置")

    # 检查数据集
    if not os.path.exists("danmaku_dataset.json"):
        print("[FAIL] 找不到 danmaku_dataset.json！请先运行 generate_dataset.py")
        sys.exit(1)

    # 确保 model/ 目录存在
    os.makedirs("model", exist_ok=True)

    # 检查 GPU（快速检查，避免训练开始后才发现没装对）
    print("[...] 检测 GPU...")
    # 写临时脚本（不使用 Unicode 字符避免编码问题）
    with open("model/_check_gpu.py", "w", encoding="utf-8") as f:
        f.write("import torch\n")
        f.write("v = torch.__version__\n")
        f.write("cu = torch.cuda.is_available()\n")
        f.write("print('[PyTorch] ' + v)\n")
        f.write("if cu:\n")
        f.write("    print('[GPU] ' + torch.cuda.get_device_name(0))\n")
        f.write("else:\n")
        f.write("    print('[GPU] 未检测到, 使用CPU训练')\n")

    # conda 环境的 python 路径
    py_path = f'"{os.path.expanduser("~")}\\..\\app\\ANACONDA\\envs\\{CONDA_ENV_NAME}\\python.exe"'
    if not os.path.exists(py_path.strip('"')):
        # fallback
        py_path = f"conda run -n {CONDA_ENV_NAME} python"

    gpu_check = run_cmd(
        f"set PYTHONIOENCODING=utf-8 && {py_path} -X utf8 model/_check_gpu.py",
        capture=True,
    )
    print(f"  {gpu_check}")
    print()

    # 写入训练脚本
    script_path = "model/_train_runner.py"
    os.makedirs("model", exist_ok=True)
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(TRAINING_SCRIPT)

    # 执行训练
    print()
    print("[...] 开始训练...")
    print()

    ret = run_cmd(f"set PYTHONIOENCODING=utf-8 && {py_path} -X utf8 model/_train_runner.py")
    if ret == 0:
        print()
        print("=" * 50)
        print("[DONE] 训练完成！")
        print("=" * 50)
        print()
        print("下一步：将 model/model_quantized.onnx 和 model/tokenizer/ 集成到浏览器插件中")
    else:
        print(f"[FAIL] 训练失败（退出码: {ret}），请检查错误信息")


if __name__ == "__main__":
    main()
