"""qq-playlist.py

Scrape a QQ Music playlist and output song list as JSON to stdout.

Usage: python scripts/qq-playlist.py <playlist_id>

Output format (JSON):
  [{"title": "song title", "artist": "artist1_artist2"}, ...]
"""

import sys
import io
import json
import html

# Force UTF-8 output on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from opencc import OpenCC
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By


def setup_driver():
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--disable-web-security")
    chrome_options.add_argument("--disable-features=IsolateOrigins,site-per-process")
    chrome_options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    )
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
    chrome_options.add_argument("--log-level=3")

    service = Service()
    driver = webdriver.Chrome(service=service, options=chrome_options)
    return driver


def to_simplified(text):
    """Convert Traditional Chinese to Simplified Chinese."""
    converter = OpenCC('t2s')
    return converter.convert(text)


def scrape_playlist(playlist_id):
    driver = setup_driver()
    try:
        url = f"https://y.qq.com/musicmac/v6/playlist/detail.html?id={playlist_id}"
        driver.get(url)
        driver.implicitly_wait(10)

        items = driver.find_elements(By.CSS_SELECTOR, ".songlist__item")
        songs = []
        for item in items:
            title = html.unescape(
                item.find_element(By.CSS_SELECTOR, ".mod_songname__name").get_attribute("title")
            )
            singer_elements = item.find_elements(By.CSS_SELECTOR, ".singer_name")
            artist = "_".join(
                html.unescape(elem.get_attribute("title")) for elem in singer_elements
            )
            songs.append({
                "title": to_simplified(title),
                "artist": to_simplified(artist),
            })

        return songs
    finally:
        driver.quit()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python qq-playlist.py <playlist_id>"}))
        sys.exit(1)

    playlist_id = sys.argv[1]
    try:
        songs = scrape_playlist(playlist_id)
        print(json.dumps(songs, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)
