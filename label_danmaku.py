"""
基于 LLM 对 stupid danmaku 规则的理解，标注爬取的弹幕

规则来源：stupid danmaku.md
- 抢沙发类型：第一、前排、占位等
- 跟风刷日期：各种日期格式 + 打卡/签到
- 弹幕通话：找人、报时、数人数

输出：danmaku_labeled.json（标注后的完整数据集）
"""
import csv
import json
import re
import os

INPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "danmaku_crawled.csv")
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "danmaku_labeled.json")

def load_crawled():
    with open(INPUT, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return [row["text"] for row in reader]

def save_labeled(data):
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    cnt = sum(1 for d in data if d["label"] == 1)
    print(f"  保存 {len(data)} 条（其中弱智 {cnt} 条）")

def is_stupid(text):
    """判断是否为无意义跟风弹幕，返回 True/False"""

    # === 第1类：抢沙发 / 占位 ===
    # "第一", "沙发", "前排", "板凳", "地板", "广告位"
    # "留名", "火钳", "前10", "前100"
    # "3分钟前", "1小时前"
    # "刚发出来", "还没看先占座"
    if re.search(r'^(第一|第二|第三|第[0-9]+)[！!~]?$', text): return True
    if re.search(r'^(沙发|板凳|地板|地下室)[！!~]?$', text): return True
    if re.search(r'^前(排|10|100)[！!~]?$', text): return True
    if re.search(r'^(火钳|火前)[刘留]明', text): return True
    if re.search(r'^广告位招租', text): return True
    if re.search(r'^[0-9]+分钟前', text): return True
    if re.search(r'^[0-9]+小时前', text): return True
    if re.search(r'^刚发(出来|就来了)', text): return True
    if re.search(r'^第[一二三四五六七八九十0-9]+[名位]', text): return True
    if re.search(r'^我是第一个', text): return True
    if re.search(r'还热乎|凉了$', text): return True
    if re.search(r'^抢到沙发', text): return True
    if text in ["第一", "第二", "第三", "沙发", "板凳", "地板", "前排", "留名"]: return True

    # === 第2类：跟风刷日期 ===
    # "2026年6月6日", "2026/6/6", "2026-6-6"
    # "2024年6月6日打卡", "2026/6/6 签到"
    # "6月6日", "7月7日"
    if re.search(r'(20[0-9]{2})[年/-]([0-9]{1,2})[月/-]([0-9]{1,2})[日]?', text): return True
    if re.search(r'(20[0-9]{2})年[0-9]{1,2}月[0-9]{1,2}日(打卡|签到|留名|来过)', text): return True
    if re.search(r'^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}$', text): return True
    if re.search(r'^(20[0-9]{2})[年/-][0-9]{1,2}月?$', text): return True
    if re.search(r'^[0-9]{1,2}月[0-9]{1,2}日$', text): return True

    # 单独日期：纯日期文本，没有其他含义
    if re.search(r'^(20[0-9]{2})年([0-9]{1,2})月([0-9]{1,2})日$', text): return True
    if re.search(r'^(20[0-9]{2})[/-]([0-9]{1,2})[/-]([0-9]{1,2})$', text): return True

    # 打卡/签到（无具体上下文）
    if text in ["打卡", "签到", "今日打卡"]: return True
    if re.search(r'[0-9]{4}年.*(打卡|签到)', text): return True
    if re.search(r'某年某月某日', text): return True

    # === 第3类：弹幕通话 / 数人数 ===
    # "还有人在看吗", "有人在吗", "有活人吗"
    # "14个人", "28个人你们好"
    # "在的扣1", "在的扣个1"
    # "不会只有我一个人在看吧"
    if re.search(r'^还有.?人在.?', text): return True
    if re.search(r'^有[没活]人', text): return True
    if re.search(r'^就我一个人', text): return True
    if re.search(r'^不会只有我', text): return True
    if re.search(r'^难道只有我', text): return True
    if re.search(r'^[0-9]+个人', text): return True
    if re.search(r'^.*个人.*出来', text): return True
    if re.search(r'^在的扣[1个]', text): return True
    if re.search(r'吱一声|活人吱一声', text): return True
    if re.search(r'交个朋友', text): return True
    if re.search(r'大半夜还有', text): return True
    if re.search(r'都几点了还看', text): return True
    if re.search(r'这个点还在看', text): return True
    if re.search(r'剩下[0-9]*人', text): return True

    # 报时类
    if re.search(r'^几点了', text): return True
    if re.search(r'^现在几点了', text): return True
    if re.search(r'^凌晨[一二三四五六日两三四五六七八九十]点', text): return True
    if re.search(r'^半夜了', text): return True

    # === 第4类：纯符号/数字刷屏 ===
    if re.search(r'^[？?！!。，、\.\~\s]{3,}$', text): return True
    if re.search(r'^[0-9]{4,}$', text): return True

    # === 第5类：只有我一个人觉得类 ===
    if re.search(r'只有我觉得|难道只有我|不会只有我', text): return True

    return False

def main():
    print("加载弹幕...")
    texts = load_crawled()
    print(f"  共 {len(texts)} 条")

    print("标注中...")
    labeled = []
    stupid_count = 0
    for text in texts:
        label = 1 if is_stupid(text) else 0
        if label == 1:
            stupid_count += 1
        labeled.append({"text": text, "label": label})

    print(f"\n标注结果:")
    print(f"  正常: {len(labeled) - stupid_count}")
    print(f"  弱智: {stupid_count}")
    print(f"  合计: {len(labeled)}")

    save_labeled(labeled)

    # 打印一些弱智弹幕样本验证
    print(f"\n弱智弹幕样本（前30条）:")
    count = 0
    for d in labeled:
        if d["label"] == 1:
            print(f"  [1] {d['text']}")
            count += 1
            if count >= 30:
                break

if __name__ == "__main__":
    main()
