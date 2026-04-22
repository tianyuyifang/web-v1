"""kugou-playlist.py

Scrape a KuGou playlist by specialID (long gcid: collection_3_{uid}_{listid}_0)
and output song list as JSON to stdout.

Usage: python kugou-playlist.py <specialid>

Output format (JSON):
  [{"title": "song title", "artist": "artist1_artist2"}, ...]

Uses signed requests to pubsongscdn.kugou.com/v2/get_other_list_file with the
salt reverse-engineered from KuGou's infSign.min.js. No cookies required.
"""

import hashlib
import io
import json
import sys
import time

import requests


# Force UTF-8 output on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

SALT = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt"
USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 "
    "Mobile/15E148 MicroMessenger/8.0.16(0x18001029)"
)
ENDPOINT = "https://pubsongscdn.kugou.com/v2/get_other_list_file"


def _sign_get(params):
    sorted_keys = sorted(params.keys())
    inner = "".join(f"{k}={params[k]}" for k in sorted_keys)
    return hashlib.md5((SALT + inner + SALT).encode()).hexdigest()


def fetch_page(session, specialid, userid, page, pagesize):
    t = str(int(time.time() * 1000))
    params = {
        "srcappid": "2919",
        "clientver": "20000",
        "clienttime": t,
        "mid": t,
        "uuid": t,
        "dfid": "-",
        "appid": "1058",
        "type": "0",
        "module": "playlist",
        "page": str(page),
        "pagesize": str(pagesize),
        "userid": str(userid),
        "global_collection_id": specialid,
    }
    params["signature"] = _sign_get(params)
    headers = {
        "Referer": "https://m.kugou.com/",
        "User-Agent": USER_AGENT,
        "clienttime": t,
        "mid": t,
        "uuid": t,
        "dfid": "-",
    }
    r = session.get(ENDPOINT, params=params, headers=headers, timeout=15)
    r.raise_for_status()
    return r.json()


def fetch_playlist(specialid):
    if not specialid.startswith("collection_"):
        raise ValueError(
            "Expected specialid of form 'collection_3_{uid}_{listid}_0'"
        )
    parts = specialid.split("_")
    if len(parts) < 4:
        raise ValueError("malformed specialid")
    owner_uid = int(parts[2])

    session = requests.Session()
    results = []
    page = 1
    pagesize = 100
    total = None

    while True:
        resp = fetch_page(session, specialid, owner_uid, page, pagesize)
        if resp.get("error_code") != 0:
            raise RuntimeError(f"KuGou API error: {resp}")

        data = resp.get("data", {})
        if total is None:
            total = data.get("count", 0)

        songs = data.get("info", [])
        if not songs:
            break

        for s in songs:
            filename = s.get("name", "") or s.get("filename", "")
            if " - " in filename:
                artist, title = filename.split(" - ", 1)
            else:
                artist, title = "", filename
            artist = "_".join(a.strip() for a in artist.split("、") if a.strip())
            results.append({"title": title.strip(), "artist": artist})

        if len(results) >= total or len(songs) < pagesize:
            break
        page += 1

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python kugou-playlist.py <specialid>"}))
        sys.exit(1)

    try:
        songs = fetch_playlist(sys.argv[1])
        print(json.dumps(songs, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)
