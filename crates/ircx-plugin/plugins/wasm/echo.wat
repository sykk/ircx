;; Host writes the argument at ARG_PTR and reads the reply from REPLY_PTR.
;; on_command(arg_ptr, arg_len) -> reply_len
(module
  (memory (export "memory") 1)
  (data (i32.const 0) "pong:")
  (func (export "on_command") (param $p i32) (param $l i32) (result i32)
    (memory.copy (i32.const 1024) (i32.const 0) (i32.const 5))
    (memory.copy (i32.const 1029) (local.get $p) (local.get $l))
    (i32.add (local.get $l) (i32.const 5))))
