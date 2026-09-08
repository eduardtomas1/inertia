"""Private Xvfb evidence: identify one owned window or request WM_DELETE_WINDOW.

No process signals, window destruction, shell commands, or global desktop search.
The caller supplies the exact live main PID/start time and its guardian ancestor.
"""
import ctypes as c
import json
import os
import sys

assert sys.platform == "linux" and len(sys.argv) == 6
mode, pid_text, start, ancestor_text, ancestor_start = sys.argv[1:]
assert mode in ("find", "close")
assert all(value.isdecimal() for value in (pid_text, start, ancestor_text, ancestor_start))
pid, ancestor = int(pid_text), int(ancestor_text)
assert pid > 1 and ancestor > 1 and pid != ancestor


def identity(value):
    path = f"/proc/{value}"
    with open(path + "/status", encoding="utf8") as file:
        status = file.read(4097)
    assert len(status) <= 4096
    uids = next(line.split()[1:3] for line in status.splitlines() if line.startswith("Uid:"))
    assert all(int(value) == os.getuid() for value in uids)
    with open(path + "/stat", encoding="utf8") as file:
        record = file.read(4097)
    assert len(record) <= 4096
    fields = record[record.rindex(")") + 2:].split()
    assert fields[0] not in ("Z", "X")
    return int(fields[1]), fields[19]


def owned():
    parent, actual_start = identity(pid)
    assert actual_start == start
    seen = {pid}
    for _ in range(32):
        if parent == ancestor:
            assert identity(ancestor)[1] == ancestor_start
            return
        assert parent > 1 and parent not in seen
        seen.add(parent)
        parent, _ = identity(parent)
    raise AssertionError("Unconfirmed window owner ancestry")


owned()
x = c.CDLL("libX11.so.6")
D, U, I, L = c.c_void_p, c.c_ulong, c.c_int, c.c_long
x.XOpenDisplay.argtypes, x.XOpenDisplay.restype = [c.c_char_p], D
x.XDefaultRootWindow.argtypes, x.XDefaultRootWindow.restype = [D], U
x.XInternAtom.argtypes, x.XInternAtom.restype = [D, c.c_char_p, I], U
x.XQueryTree.argtypes = [D, U, c.POINTER(U), c.POINTER(U), c.POINTER(c.POINTER(U)), c.POINTER(c.c_uint)]
x.XGetWindowProperty.argtypes = [D, U, U, L, L, I, U, c.POINTER(U), c.POINTER(I), c.POINTER(U), c.POINTER(U), c.POINTER(c.POINTER(c.c_ubyte))]
x.XGetWMProtocols.argtypes = [D, U, c.POINTER(c.POINTER(U)), c.POINTER(I)]
x.XFree.argtypes = [D]
x.XSync.argtypes = [D, I]
x.XCloseDisplay.argtypes = [D]


class Attributes(c.Structure):
    _fields_ = [("x", I), ("y", I), ("width", I), ("height", I), ("border_width", I), ("depth", I),
                ("visual", D), ("root", U), ("class_", I), ("bit_gravity", I), ("win_gravity", I),
                ("backing_store", I), ("backing_planes", U), ("backing_pixel", U), ("save_under", I),
                ("colormap", U), ("map_installed", I), ("map_state", I), ("all_event_masks", L),
                ("your_event_mask", L), ("do_not_propagate_mask", L), ("override_redirect", I), ("screen", D)]


x.XGetWindowAttributes.argtypes = [D, U, c.POINTER(Attributes)]


class Data(c.Union):
    _fields_ = [("b", c.c_char * 20), ("s", c.c_short * 10), ("l", L * 5)]


class ClientMessage(c.Structure):
    _fields_ = [("type", I), ("serial", U), ("send_event", I), ("display", D),
                ("window", U), ("message_type", U), ("format", I), ("data", Data)]


class Event(c.Union):
    _fields_ = [("client", ClientMessage), ("pad", L * 24)]


x.XSendEvent.argtypes = [D, U, I, L, c.POINTER(Event)]
display = x.XOpenDisplay(None)
assert display
try:
    cardinal = x.XInternAtom(display, b"CARDINAL", 0)
    pid_atom = x.XInternAtom(display, b"_NET_WM_PID", 0)
    protocols_atom = x.XInternAtom(display, b"WM_PROTOCOLS", 0)
    delete_atom = x.XInternAtom(display, b"WM_DELETE_WINDOW", 0)

    def window_owner(window):
        actual, count, rest = U(), U(), U()
        form, data = I(), c.POINTER(c.c_ubyte)()
        assert x.XGetWindowProperty(display, window, pid_atom, 0, 1, 0, cardinal,
                                    c.byref(actual), c.byref(form), c.byref(count),
                                    c.byref(rest), c.byref(data)) == 0
        try:
            return c.cast(data, c.POINTER(U))[0] if actual.value == cardinal and form.value == 32 and count.value == 1 and rest.value == 0 else None
        finally:
            if data:
                x.XFree(data)

    queue = [(x.XDefaultRootWindow(display), 0)]
    matches, visited = [], 0
    while queue:
        window, depth = queue.pop(0)
        visited += 1
        assert visited <= 128
        if window_owner(window) == pid:
            attributes = Attributes()
            assert x.XGetWindowAttributes(display, window, c.byref(attributes))
            supported, length = c.POINTER(U)(), I()
            if x.XGetWMProtocols(display, window, c.byref(supported), c.byref(length)):
                try:
                    assert 0 <= length.value <= 32
                    if delete_atom in supported[:length.value] and attributes.map_state == 2:
                        matches.append(window)
                finally:
                    x.XFree(supported)
        if depth < 3:
            root, parent, children, length = U(), U(), c.POINTER(U)(), c.c_uint()
            assert x.XQueryTree(display, window, c.byref(root), c.byref(parent), c.byref(children), c.byref(length))
            try:
                assert length.value <= 128 and len(queue) + visited + length.value <= 128
                queue.extend((child, depth + 1) for child in children[:length.value])
            finally:
                if children:
                    x.XFree(children)
    owned()
    assert len(matches) <= 1
    if mode == "close":
        assert len(matches) == 1
        event = Event()
        event.client.type, event.client.send_event = 33, 1
        event.client.display, event.client.window = display, matches[0]
        event.client.message_type, event.client.format = protocols_atom, 32
        event.client.data.l[0] = delete_atom
        event.client.data.l[1] = 0  # CurrentTime
        owned()
        assert window_owner(matches[0]) == pid
        assert x.XSendEvent(display, matches[0], 0, 0, c.byref(event))
        x.XSync(display, 0)
    print(json.dumps({"windowCount": len(matches), "normalCloseRequested": mode == "close"}))
finally:
    x.XCloseDisplay(display)
