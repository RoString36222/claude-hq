# HQ Notch -> kitty: click a session in the notch and kitty switches to that session's tab.
#
# A kitty watcher, so kitty needs no remote control (no allow_remote_control / listen_on). Add to
# kitty.conf, then restart kitty:
#
#     watcher ~/Library/Application Support/HQNotch/hq_notch_kitty.py
#
# It listens on a private unix socket (~/Library/Application Support/HQNotch/kitty-<pid>.sock,
# directory 0700, socket 0600) and accepts exactly one request, {"focus": <window id>}. Nothing
# it receives can type text, run a command or change a setting. It runs on kitty's own main loop
# (a 0.1 s timer), so it never touches kitty from another thread.
import atexit
import json
import os
import socket

DIR = os.path.expanduser("~/Library/Application Support/HQNotch")
MAX = 64          # a request is {"focus": N}: anything longer is not one
POLL = 0.1

_sock = None
_path = None


def socket_path(pid):
    return os.path.join(DIR, "kitty-%d.sock" % pid)


def parse(data):
    """The window id in a {"focus": N} request, else None. Pure (tested)."""
    if not data or len(data) > MAX:
        return None
    try:
        msg = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(msg, dict) or set(msg) != {"focus"}:
        return None
    wid = msg["focus"]
    if isinstance(wid, bool) or not isinstance(wid, int) or wid <= 0:
        return None
    return wid


def listen(pid):
    """Bind this kitty's socket (replacing a stale one) and return (socket, path)."""
    os.makedirs(DIR, mode=0o700, exist_ok=True)
    os.chmod(DIR, 0o700)
    path = socket_path(pid)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        s.bind(path)
    finally:
        os.umask(old)
    os.chmod(path, 0o600)
    s.listen(8)
    s.setblocking(False)
    return s, path


def drain(sock, focus):
    """Answer every waiting connection: read one request, focus its window."""
    while True:
        try:
            conn, _ = sock.accept()
        except OSError:          # BlockingIOError: nothing waiting
            return
        with conn:
            conn.settimeout(0.05)
            try:
                data = conn.recv(MAX + 1)
            except OSError:
                continue
            wid = parse(data.strip())
            if wid is not None:
                focus(wid)


def cleanup():
    if _sock is not None:
        _sock.close()
    if _path:
        try:
            os.unlink(_path)
        except OSError:
            pass


def on_load(boss, data):
    global _sock, _path
    if _sock is not None:
        return
    from kitty.fast_data_types import add_timer

    try:
        _sock, _path = listen(os.getpid())
    except OSError:
        return

    def focus(wid):
        if wid in boss.window_id_map:
            boss.set_active_window(wid, switch_os_window_if_needed=True)

    def tick(timer_id):
        try:
            drain(_sock, focus)
        except Exception:
            import traceback
            traceback.print_exc()

    add_timer(tick, POLL, True)
    atexit.register(cleanup)
