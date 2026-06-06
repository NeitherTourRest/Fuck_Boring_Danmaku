"""
B站 热门视频弹幕爬虫
- 从 B站 API 获取热门视频列表
- 抓取每条视频的弹幕
- 保存为 CSV
"""
import requests
import xml.etree.ElementTree as ET
import csv
import re
import time
import os

# 输出文件
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "danmaku_crawled.csv")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://www.bilibili.com/",
}

def get_bvid_by_keyword(keyword, pages=3):
    """通过搜索关键词获取视频 BVID"""
    bvids = []
    for pn in range(1, pages + 1):
        url = f"https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword={keyword}&page={pn}"
        try:
            r = requests.get(url, headers=HEADERS, timeout=10)
            data = r.json()
            if data["code"] == 0:
                for v in data["data"]["result"]:
                    bvids.append(v["bvid"])
        except:
            pass
        time.sleep(0.5)
    print(f"  搜索 '{keyword}' 获取到 {len(bvids)} 个视频")
    return bvids

def get_popular_bvids(count=15):
    """从 B站 热门榜单获取视频"""
    bvids = []
    url = "https://api.bilibili.com/x/web-interface/popular"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        data = r.json()
        if data["code"] == 0:
            for v in data["data"]["list"]:
                bvids.append(v["bvid"])
                if len(bvids) >= count:
                    break
    except Exception as e:
        print(f"  热门榜单获取失败: {e}")
    print(f"  热门榜单获取到 {len(bvids)} 个视频")
    return bvids

def get_cid(bvid):
    """获取视频的 cid（弹幕需要）"""
    url = f"https://api.bilibili.com/x/player/pagelist?bvid={bvid}&jsonp=jsonp"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        data = r.json()
        if data["code"] == 0 and len(data["data"]) > 0:
            return data["data"][0]["cid"]
    except:
        pass
    return None

def get_danmaku(cid):
    """从 B站 XML 接口获取弹幕列表"""
    url = f"https://comment.bilibili.com/{cid}.xml"
    texts = []
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        root = ET.fromstring(r.content)
        for d in root.findall("d"):
            text = d.text
            if text:
                texts.append(text.strip())
    except:
        pass
    return texts

def main():
    print("=" * 50)
    print("B站弹幕爬虫 - 获取热门视频弹幕")
    print("=" * 50)

    all_bvids = []

    # 方式1: 热门榜单
    print("\n[1/3] 获取热门视频...")
    all_bvids.extend(get_popular_bvids(15))

    # 方式2: 搜索热门关键词
    keywords = ["搞笑", "游戏", "日常", "美食", "科技", "音乐", "影视"]
    for kw in keywords:
        all_bvids.extend(get_bvid_by_keyword(kw, 1))
        time.sleep(0.5)

    # 去重
    all_bvids = list(set(all_bvids))
    print(f"\n  共 {len(all_bvids)} 个不重复视频")

    # 获取弹幕
    print("\n[2/3] 获取弹幕...")
    all_danmaku = []
    for i, bvid in enumerate(all_bvids):
        print(f"  [{i+1}/{len(all_bvids)}] {bvid}", end="")
        cid = get_cid(bvid)
        if not cid:
            print(" - 无cid")
            continue
        danmaku = get_danmaku(cid)
        print(f" - {len(danmaku)} 条弹幕")
        all_danmaku.extend(danmaku)
        time.sleep(0.3)

    # 去重 + 去空
    all_danmaku = list(set([d.strip() for d in all_danmaku if d.strip()]))
    
    # 过滤太长的（不是正常弹幕）
    all_danmaku = [d for d in all_danmaku if len(d) <= 40]
    
    # 过滤纯英文/数字/符号
    all_danmaku = [d for d in all_danmaku if any('\u4e00' <= c <= '\u9fff' for c in d)]

    print(f"\n[3/3] 保存到 {OUTPUT}")
    print(f"  有效弹幕: {len(all_danmaku)} 条")

    with open(OUTPUT, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["text", "label"])
        for danmaku in all_danmaku:
            writer.writerow([danmaku, ""])

    print(f"\n  ✅ 完成！共保存 {len(all_danmaku)} 条弹幕")
    print(f"  📁 {OUTPUT}")

if __name__ == "__main__":
    main()
