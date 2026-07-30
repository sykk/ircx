;; Asks for the one WASI call that writes bytes to a file descriptor. Nothing in
;; the host defines it, so the module never instantiates. The point is that a
;; wasm module's import list is its complete capability list, declared in the
;; file and checkable before a single instruction runs.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "on_command") (param i32 i32) (result i32)
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 0)))
    (i32.const 0)))
