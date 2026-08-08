/* Types and clicks into an X display, for driving the assembled app on Xvfb.
 *
 *   xsend type <text>     insert the text a character at a time
 *   xsend key <name>      a keysym by name, with ctrl+/shift+/alt+ prefixes
 *   xsend click <x> <y>   move the pointer there and click button 1
 *
 * Every character goes through XKeysymToKeycode, so a keysym the layout does
 * not carry is reported rather than typed as something else.
 */
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

static Display *dpy;

/* Between keystrokes. GTK drops one from a path typed into a file chooser at
 * 6 ms — 3 of 3 attempts lost a character, at varying positions — and does not
 * at 20, where 9 of 9 came through whole. WebKit's textarea took 247 characters
 * at either. Measured on the second walk; see docs/manual-verification.md. */
static const useconds_t GAP_US = 20000;

/* Whether this keysym sits on the shifted level of the keycode it maps to. */
static int needs_shift(KeyCode code, KeySym want) {
  int per = 0;
  KeySym *syms = XGetKeyboardMapping(dpy, code, 1, &per);
  int shifted = per > 1 && syms[1] == want && syms[0] != want;
  XFree(syms);
  return shifted;
}

static int tap(KeySym sym, unsigned mods) {
  KeyCode code = XKeysymToKeycode(dpy, sym);
  if (!code) {
    fprintf(stderr, "no keycode for keysym 0x%lx\n", (unsigned long)sym);
    return 1;
  }
  KeyCode shift = XKeysymToKeycode(dpy, XK_Shift_L);
  KeyCode ctrl = XKeysymToKeycode(dpy, XK_Control_L);
  KeyCode alt = XKeysymToKeycode(dpy, XK_Alt_L);
  int with_shift = (mods & 1) || needs_shift(code, sym);

  if (with_shift) XTestFakeKeyEvent(dpy, shift, True, 0);
  if (mods & 2) XTestFakeKeyEvent(dpy, ctrl, True, 0);
  if (mods & 4) XTestFakeKeyEvent(dpy, alt, True, 0);
  XTestFakeKeyEvent(dpy, code, True, 0);
  XTestFakeKeyEvent(dpy, code, False, 0);
  if (mods & 4) XTestFakeKeyEvent(dpy, alt, False, 0);
  if (mods & 2) XTestFakeKeyEvent(dpy, ctrl, False, 0);
  if (with_shift) XTestFakeKeyEvent(dpy, shift, False, 0);
  XFlush(dpy);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: xsend type <text> | key <name> | click <x> <y>\n");
    return 2;
  }
  dpy = XOpenDisplay(NULL);
  if (!dpy) {
    fprintf(stderr, "cannot open display\n");
    return 1;
  }

  if (!strcmp(argv[1], "type")) {
    /* The rest of the line, so spaces need no quoting from the caller. */
    for (int a = 2; a < argc; a++) {
      for (const char *p = argv[a]; *p; p++) {
        char name[2] = {*p, 0};
        KeySym sym = *p == ' ' ? XK_space : XStringToKeysym(name);
        if (sym == NoSymbol) sym = (KeySym)(unsigned char)*p;
        if (tap(sym, 0)) return 1;
        usleep(GAP_US);
      }
      if (a + 1 < argc) { tap(XK_space, 0); usleep(GAP_US); }
    }
  } else if (!strcmp(argv[1], "key")) {
    unsigned mods = 0;
    char *spec = argv[2];
    for (;;) {
      if (!strncmp(spec, "shift+", 6)) { mods |= 1; spec += 6; }
      else if (!strncmp(spec, "ctrl+", 5)) { mods |= 2; spec += 5; }
      else if (!strncmp(spec, "alt+", 4)) { mods |= 4; spec += 4; }
      else break;
    }
    KeySym sym = XStringToKeysym(spec);
    if (sym == NoSymbol) { fprintf(stderr, "unknown keysym %s\n", spec); return 1; }
    if (tap(sym, mods)) return 1;
  } else if (!strcmp(argv[1], "click")) {
    if (argc < 4) { fprintf(stderr, "click needs x and y\n"); return 2; }
    XTestFakeMotionEvent(dpy, -1, atoi(argv[2]), atoi(argv[3]), 0);
    XFlush(dpy);
    usleep(60000);
    XTestFakeButtonEvent(dpy, 1, True, 0);
    XTestFakeButtonEvent(dpy, 1, False, 0);
    XFlush(dpy);
  } else {
    fprintf(stderr, "unknown command %s\n", argv[1]);
    return 2;
  }

  XCloseDisplay(dpy);
  return 0;
}
