/* Takes the keyboard focus away from the client's window, and gives it back.
 *
 *     xfocus <display> away        focus nothing, so every window sees FocusOut
 *     xfocus <display> back        focus the window called ircx again
 *     xfocus <display> which       print what currently holds the focus
 *
 * The focus half of the notification rule is the half no test can drive:
 * `startNotifications` reads `getCurrentWindow().isFocused()` once and then
 * follows `onFocusChanged`, and both come from the window manager's idea of
 * focus rather than from anything the page can dispatch.
 *
 * There is no `xdotool` on this machine and no window manager under `Xvfb`, so
 * this walks the root's children looking for WM_NAME `ircx` and calls
 * XSetInputFocus itself. `away` focuses `None` rather than another window,
 * because there is no other window to focus and PointerRoot would hand the
 * focus straight back to whatever the pointer sits over — which, on a display
 * holding one full-screen window, is the window we are trying to blur.
 *
 *     cc -o xfocus xfocus.c -lX11
 */

#include <stdio.h>
#include <string.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>

/* Depth-first, because the top-level ircx window is a child of the root but a
 * reparenting server would put it one deeper. */
static Window find(Display *dpy, Window at, const char *want) {
    char *name = NULL;
    if (XFetchName(dpy, at, &name) && name) {
        int hit = strcmp(name, want) == 0;
        XFree(name);
        if (hit) return at;
    }
    Window root, parent, *kids = NULL;
    unsigned int count = 0;
    if (!XQueryTree(dpy, at, &root, &parent, &kids, &count)) return 0;
    Window found = 0;
    for (unsigned int i = 0; i < count && !found; i++) found = find(dpy, kids[i], want);
    if (kids) XFree(kids);
    return found;
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: xfocus <display> away|back|which\n"); return 2; }
    Display *dpy = XOpenDisplay(argv[1]);
    if (!dpy) { fprintf(stderr, "xfocus: cannot open %s\n", argv[1]); return 1; }

    if (strcmp(argv[2], "away") == 0) {
        XSetInputFocus(dpy, None, RevertToNone, CurrentTime);
    } else if (strcmp(argv[2], "back") == 0) {
        /* PointerRoot rather than the window itself, which is what `which`
         * reports before anything here has run: there is no window manager, so
         * nothing ever gave the window the focus explicitly, and the client has
         * it only because the pointer sits over it. Focusing the top-level
         * directly answers BadMatch — the window `find` returns is not the
         * viewable one — and restoring the state that was actually there is the
         * more honest instrument anyway. */
        XSetInputFocus(dpy, PointerRoot, RevertToPointerRoot, CurrentTime);
    } else if (strcmp(argv[2], "which") == 0) {
        Window win = 0;
        int revert = 0;
        XGetInputFocus(dpy, &win, &revert);
        Window ircx = find(dpy, DefaultRootWindow(dpy), "ircx");
        printf("focus=0x%lx ircx=0x%lx same=%d\n", win, ircx, ircx && win == ircx);
    } else {
        fprintf(stderr, "xfocus: unknown command %s\n", argv[2]);
        XCloseDisplay(dpy);
        return 2;
    }

    XSync(dpy, False);
    XCloseDisplay(dpy);
    return 0;
}
