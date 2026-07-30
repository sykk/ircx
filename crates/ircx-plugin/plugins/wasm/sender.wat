;; Needs the host to hand it `host.send`. Without the SendMessages grant the
;; host does not define that import and the module cannot be instantiated.
(module
  (import "host" "send" (func $send (param i32 i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "PRIVMSG from plugin")
  (func (export "on_command") (param i32 i32) (result i32)
    (call $send (i32.const 0) (i32.const 19))
    (i32.const 0)))
