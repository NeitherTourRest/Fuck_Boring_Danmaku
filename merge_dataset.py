"""
合并合成数据 + 真实标注数据，生成最终训练集
"""
import json
import random
import os

random.seed(42)

# 加载合成数据
synth_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "danmaku_dataset.json")
with open(synth_path, "r", encoding="utf-8") as f:
    synth_data = json.load(f)

# 加载真实标注数据
labeled_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "danmaku_labeled.json")
with open(labeled_path, "r", encoding="utf-8") as f:
    labeled_data = json.load(f)

print(f"合成数据: {len(synth_data)} 条")
print(f"  正常: {sum(1 for d in synth_data if d['label']==0)}")
print(f"  弱智: {sum(1 for d in synth_data if d['label']==1)}")

print(f"\n真实数据: {len(labeled_data)} 条")
print(f"  正常: {sum(1 for d in labeled_data if d['label']==0)}")
print(f"  弱智: {sum(1 for d in labeled_data if d['label']==1)}")

# 从真实数据中提取弱智弹幕
real_stupid = [d for d in labeled_data if d["label"] == 1]
real_normal = [d for d in labeled_data if d["label"] == 0]

# 从合成数据中提取
synth_stupid = [d for d in synth_data if d["label"] == 1]
synth_normal = [d for d in synth_data if d["label"] == 0]

# 合并弱智类（全部保留）
all_stupid = real_stupid + synth_stupid

# 正常类：从真实数据采样 + 合成数据全部保留
# 采样数量：让正常:弱智 ≈ 3:1
target_normal = len(all_stupid) * 3
sampled_normal = random.sample(real_normal, min(target_normal - len(synth_normal), len(real_normal)))
all_normal = synth_normal + sampled_normal

# 打乱
all_data = all_stupid + all_normal
random.shuffle(all_data)

print(f"\n=== 最终训练集 ===")
print(f"  正常: {len(all_normal)} 条")
print(f"  弱智: {len(all_stupid)} 条")
print(f"  合计: {len(all_data)} 条")

# 保存
output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "danmaku_dataset_final.json")
with open(output_path, "w", encoding="utf-8") as f:
    json.dump(all_data, f, ensure_ascii=False, indent=2)

print(f"\n保存到: {output_path}")

# 打印一些样本验证
print(f"\n弱智样本（前20条）:")
cnt = 0
for d in all_data:
    if d["label"] == 1:
        print(f"  [1] {d['text']}")
        cnt += 1
        if cnt >= 20:
            break
