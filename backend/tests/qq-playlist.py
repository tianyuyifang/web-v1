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


def scrape_playlist(playlist_id):
    profile_dir = tempfile.mkdtemp(prefix="qq-playlist-chrome-")
    driver = None
    try:
        driver = setup_driver(profile_dir)
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
