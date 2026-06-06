"""检查生成的数据集"""
import json

with open("D:\\No_Danmaku\\danmaku_dataset.json", "r", encoding="utf-8") as f:
    data = json.load(f)

print(f"总条数: {len(data)}")
label0 = [d for d in data if d["label"] == 0]
label1 = [d for d in data if d["label"] == 1]
print(f"label=0 (正常): {len(label0)}")
print(f"label=1 (弱智): {len(label1)}")
print()

print("--- label=1 前 20 条 ---")
for d in label1[:20]:
    print(f"  [{d['label']}] {d['text']}")
print()

print("--- label=0 前 20 条 ---")
for d in label0[:20]:
    print(f"  [{d['label']}] {d['text']}")
