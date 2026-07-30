;; Grows until the host refuses, then returns. A guest cannot fault the host by
;; asking for memory; it can only be told no.
(module
  (memory (export "memory") 1)
  (func (export "on_command") (param i32 i32) (result i32)
    (local $grown i32)
    (loop $more
      (local.set $grown (memory.grow (i32.const 16)))
      (br_if $more (i32.ge_s (local.get $grown) (i32.const 0))))
    (i32.const 0)))
