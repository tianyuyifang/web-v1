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
import signal

# Force UTF-8 output on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# The importer kills this script on timeout (SIGTERM) and a closed ssh session
# sends SIGHUP. By default Python then dies on the spot, `finally:
# driver.quit()` never runs and headless Chrome is left behind (2026-11-10:
# five of them on the VM since September, ~1 GB of swap). Exit normally instead.
for _sig in (signal.SIGTERM, getattr(signal, "SIGHUP", None)):
    if _sig is not None:
        signal.signal(_sig, lambda signum, frame: sys.exit(128 + signum))

# Windows has no SIGTERM to catch: the importer's timeout there ends Python on
# the spot, no handler and no `finally`, and chromedriver + Chrome live on (two
# found on the dev PC, 2026-11-10). A job object set to kill-on-close takes
# every process this script starts down with it, however it ends.
if sys.platform == "win32":
    try:
        import ctypes
        from ctypes import wintypes

        class _BasicLimits(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _BasicLimits),
                ("IoInfo", ctypes.c_ulonglong * 6),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _k32.CreateJobObjectW.restype = wintypes.HANDLE
        _k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        _k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        _k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        _k32.GetCurrentProcess.restype = wintypes.HANDLE
        _limits = _ExtendedLimits()
        _limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        _job = _k32.CreateJobObjectW(None, None)  # stays open until this process is gone
        # 9 = JobObjectExtendedLimitInformation
        if _job and _k32.SetInformationJobObject(_job, 9, ctypes.byref(_limits), ctypes.sizeof(_limits)):
            _k32.AssignProcessToJobObject(_job, _k32.GetCurrentProcess())
    except Exception:
        pass  # the scrape still works; only the clean-up on a kill is lost
import os
import shutil
import tempfile
import time
from datetime import datetime, timezone
from opencc import OpenCC
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By


def _linux_processes():
    """pid -> (parent pid, command line) for every process we can read."""
    procs = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat", "rb") as f:
                stat = f.read().decode("utf-8", "replace")
            ppid = int(stat[stat.rindex(")") + 2:].split()[1])
            with open(f"/proc/{name}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode("utf-8", "replace")
            procs[int(name)] = (ppid, cmd)
        except (OSError, ValueError, IndexError):
            continue
    return procs


def _kill_browser(driver_pid, profile_dir):
    """End chromedriver's Chrome however this run ends: everything below
    chromedriver, plus anything naming this run's own profile directory (the
    crash handler is re-parented away from chromedriver at once)."""
    if not sys.platform.startswith("linux"):
        return  # Windows: the job object above takes them all down
    procs = _linux_processes()
    doomed = {pid for pid, (_, cmd) in procs.items() if profile_dir and profile_dir in cmd}
    if driver_pid:
        frontier = [driver_pid]
        while frontier:
            parent = frontier.pop()
            for pid, (ppid, _) in procs.items():
                if ppid == parent and pid not in doomed:
                    doomed.add(pid)
                    frontier.append(pid)
    doomed.discard(os.getpid())
    for pid in doomed:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def setup_driver(profile_dir):
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    # This run's own profile: removed afterwards, and how its processes are found.
    chrome_options.add_argument(f"--user-data-dir={profile_dir}")
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


# How long to wait for the song list once the page has loaded. It used to be a
# 10 s implicit wait, and on the VM QQ's list often came in after it: 44% of
# QQ imports on 2026-11-18..22 came back as "0 songs" (each after 12-14 s) and
# users had to retry several times. Delaying only QQ's data request by 13 s
# reproduces exactly that (0 songs in 16 s; 118 with this wait). The list is taken the
# moment it shows up, so a fast import is not slowed down.
LIST_WAIT_S = 45
# QQ's playlist data has come back, yet no list this long after it, and the
# page's 「歌曲(N)」 tab shows no songs: the playlist really is empty or the id
# is wrong. Unchanged from before: 0 songs.
EMPTY_GRACE_S = 15
TIMEOUT_MESSAGE = "导入超时，请重试"
# Has the page's request for the playlist data (c.y.qq.com) come back with a 200?
# A failed request is listed too, with status 0: that is not "empty", it waits
# out LIST_WAIT_S. (A wrong id also gets a 200, with no songs in it.) Only the
# XHR counts: the page's stats beacons carry the same URL in their query string.
DATA_DONE_JS = (
    "return performance.getEntriesByType('resource').some(function (e) {"
    " return e.initiatorType === 'xmlhttprequest'"
    " && e.name.indexOf('fcg_v8_playlist_cp') >= 0 && e.responseStatus === 200; });"
)
# The song count on the page's 「歌曲(118)」 tab, or null when there is no such
# tab (a wrong id has none).
SONG_COUNT_JS = (
    "var tabs = document.querySelectorAll('.mod_tab__item');"
    " for (var i = 0; i < tabs.length; i++) {"
    "  var m = tabs[i].textContent.match(/^\\s*歌曲\\s*\\((\\d+)\\)\\s*$/);"
    "  if (m) return parseInt(m[1], 10); }"
    " return null;"
)
# Every row has its title element (rows are drawn whole, this is a safety net).
ROWS_READY_JS = (
    "var r = document.querySelectorAll('.songlist__item');"
    " for (var i = 0; i < r.length; i++) if (!r[i].querySelector('.mod_songname__name')) return false;"
    " return true;"
)
# One line per run: how long each step took, so a slow import says where it was slow.
TIMING_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs", "qq-playlist.log")
TIMING_LOG_MAX_BYTES = 5 * 1024 * 1024  # then it is moved to qq-playlist.log.1


class ListTimeout(Exception):
    pass


def _log_timing(timing):
    try:
        os.makedirs(os.path.dirname(TIMING_LOG), exist_ok=True)
        if os.path.exists(TIMING_LOG) and os.path.getsize(TIMING_LOG) > TIMING_LOG_MAX_BYTES:
            os.replace(TIMING_LOG, TIMING_LOG + ".1")
        with open(TIMING_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(timing, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _js(driver, script, default=None):
    try:
        return driver.execute_script(script)
    except Exception:
        return default


def _wait_for_list(driver, timing, t0):
    """The song items, [] for an empty playlist; raises on timeout."""
    loaded = time.monotonic()
    deadline = loaded + LIST_WAIT_S
    data_at = None
    while True:
        items = driver.find_elements(By.CSS_SELECTOR, ".songlist__item")
        now = time.monotonic()
        if items:
            timing["list"] = round(now - t0, 2)
            return items
        if data_at is None and _js(driver, DATA_DONE_JS, False):
            data_at = now
            timing["data"] = round(now - t0, 2)
            # Late data still gets its full grace before anything is decided.
            deadline = max(deadline, data_at + EMPTY_GRACE_S)
        if data_at is not None and now - data_at >= EMPTY_GRACE_S:
            count = _js(driver, SONG_COUNT_JS)
            if not count:
                timing["outcome"] = "empty"
                timing["count"] = count
                return []
            # QQ says it has songs, they are just not drawn yet: keep waiting.
            timing["count"] = count
        if now >= deadline:
            timing["outcome"] = "timeout"
            raise ListTimeout(TIMEOUT_MESSAGE)
        time.sleep(0.2)


def _wait_rows_ready(driver, timeout_s=5):
    end = time.monotonic() + timeout_s
    while time.monotonic() < end and not _js(driver, ROWS_READY_JS, True):
        time.sleep(0.2)


def scrape_playlist(playlist_id):
    profile_dir = tempfile.mkdtemp(prefix="qq-playlist-chrome-")
    driver = None
    t0 = time.monotonic()
    timing = {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "id": playlist_id}
    try:
        driver = setup_driver(profile_dir)
        timing["chrome"] = round(time.monotonic() - t0, 2)
        url = f"https://y.qq.com/musicmac/v6/playlist/detail.html?id={playlist_id}"
        driver.get(url)
        timing["loaded"] = round(time.monotonic() - t0, 2)

        items = _wait_for_list(driver, timing, t0)
        # No implicit wait for the rows' parts: a row without singers used to
        # cost the whole implicit wait (10 s) for an empty find_elements.
        # Rows are drawn whole; _wait_rows_ready covers the moment just after.
        _wait_rows_ready(driver)
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

        timing["items"] = len(songs)
        timing["parsed"] = round(time.monotonic() - t0, 2)
        timing.setdefault("outcome", "ok")
        return songs
    except Exception as e:
        timing.setdefault("outcome", "error")
        timing.setdefault("error", str(e)[:200])
        raise
    except BaseException:
        # SIGTERM/SIGHUP from the importer's 180 s kill (sys.exit in the handler).
        timing.setdefault("outcome", "killed")
        raise
    finally:
        # The importer's kill must not land in the middle of the clean-up.
        for _sig in (signal.SIGTERM, getattr(signal, "SIGHUP", None)):
            if _sig is not None:
                signal.signal(_sig, signal.SIG_IGN)
        driver_pid = None
        if driver is not None:
            try:
                driver_pid = driver.service.process.pid
            except Exception:
                pass
        # Chrome first: quit() can wait on a chromedriver that is still busy
        # with a page, which is how Chrome was left behind. A page that never
        # finished loading, then the importer's kill at 180 s: quit() hung,
        # chromedriver and its Chrome were orphaned (2 of 9 imports on
        # 2026-11-11; reproduced on the VM with a never-ending local page).
        # With Chrome gone, quit() answers at once and stops chromedriver.
        # This also covers a Chrome started by a webdriver.Chrome() that
        # never returned.
        _kill_browser(driver_pid, profile_dir)
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass
        shutil.rmtree(profile_dir, ignore_errors=True)
        timing["total"] = round(time.monotonic() - t0, 2)
        _log_timing(timing)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python qq-playlist.py <playlist_id>"}))
        sys.exit(1)

    playlist_id = sys.argv[1]
    try:
        songs = scrape_playlist(playlist_id)
        print(json.dumps(songs, ensure_ascii=False))
    except ListTimeout as e:
        # Exit 0 on purpose: the importer (import-playlist-by-qq.js) reads our
        # JSON only on a clean exit and passes its "error" to the user as is.
        # On exit 1 it shows "QQ Music scraper failed: Command failed: python ..."
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)
