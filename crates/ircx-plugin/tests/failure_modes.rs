//! The requirement is that a broken plugin cannot take the host with it, so it
//! is asserted rather than described. Each test misbehaves one way, then makes
//! the same process load a fresh plugin and answer — if the host were gone the
//! second half could not run.

use std::time::{Duration, Instant};

use ircx_plugin::{fixtures, Failure, Manifest, Sandbox};

/// Generous next to the 100 ms deadline: the assertion is that termination
/// happens on the deadline's order rather than never, not that it is prompt to
/// the millisecond on a loaded machine.
const SLACK: Duration = Duration::from_millis(2000);

fn manifest() -> Manifest {
    Manifest::command_only("test")
}

#[cfg(feature = "js")]
mod js {
    use super::*;
    use ircx_plugin::js::JsSandbox;
    use ircx_plugin::Permission;

    fn survives(source: &str) -> (Failure, Duration) {
        let mut plugin = JsSandbox::load(manifest(), source.as_bytes()).expect("load");
        let at = Instant::now();
        let failure = plugin
            .call_command(&fixtures::call())
            .expect_err("plugin misbehaves");
        let took = at.elapsed();
        drop(plugin);

        let mut fresh = JsSandbox::load(manifest(), fixtures::JS_ECHO.as_bytes()).expect("load");
        assert!(fresh
            .call_command(&fixtures::call())
            .expect("host still runs")
            .starts_with("pong:"));
        (failure, took)
    }

    #[test]
    fn a_throwing_plugin_reports_and_leaves_the_host_running() {
        let (failure, _) = survives(fixtures::JS_PANIC);
        assert!(
            matches!(&failure, Failure::Raised(m) if m.contains("boom")),
            "{failure}"
        );
    }

    #[test]
    fn a_looping_plugin_is_terminated_on_its_deadline() {
        let (failure, took) = survives(fixtures::JS_LOOP);
        assert_eq!(failure, Failure::Timeout);
        assert!(took < manifest().call_timeout + SLACK, "took {took:?}");
    }

    #[test]
    fn a_plugin_looping_inside_the_regex_engine_is_also_terminated() {
        let (failure, took) = survives(fixtures::JS_REGEX);
        assert_eq!(failure, Failure::Timeout);
        assert!(took < manifest().call_timeout + SLACK, "took {took:?}");
    }

    /// The interrupt handler runs between bytecodes, so anything that parks in
    /// C is invisible to it. `Atomics.wait` is the only such thing a plugin can
    /// reach, and this build refuses it rather than blocking, which is what lets
    /// the write-up say a QuickJS plugin can spin but cannot hang.
    #[test]
    fn a_plugin_cannot_park_itself_where_the_deadline_cannot_see_it() {
        let (failure, took) = survives(fixtures::JS_ATOMICS);
        assert!(
            matches!(&failure, Failure::Raised(m) if m.contains("cannot block")),
            "{failure}"
        );
        assert!(took < manifest().call_timeout, "took {took:?}");
    }

    #[test]
    fn a_plugin_that_allocates_without_end_hits_its_memory_limit() {
        let (failure, _) = survives(fixtures::JS_MEMORY);
        assert_eq!(failure, Failure::OutOfMemory);
    }

    #[test]
    fn a_terminated_plugin_is_not_asked_to_run_again() {
        let mut plugin = JsSandbox::load(manifest(), fixtures::JS_LOOP.as_bytes()).expect("load");
        assert_eq!(
            plugin.call_command(&fixtures::call()),
            Err(Failure::Timeout)
        );
        assert_eq!(
            plugin.call_command(&fixtures::call()),
            Err(Failure::Timeout),
            "a runtime QuickJS interrupted mid-call is not offered more work"
        );
    }

    #[test]
    fn sending_needs_the_grant() {
        let mut granted =
            JsSandbox::load(manifest(), fixtures::JS_SENDER.as_bytes()).expect("load");
        granted.call_command(&fixtures::call()).expect("sends");
        assert_eq!(granted.outbox().len(), 1);

        let mut bare = manifest();
        bare.permissions = vec![Permission::AddCommands];
        let mut denied = JsSandbox::load(bare, fixtures::JS_SENDER.as_bytes()).expect("load");
        assert!(
            matches!(
                denied.call_command(&fixtures::call()),
                Err(Failure::Denied(_))
            ),
            "host.send must refuse without the grant"
        );
        assert!(denied.outbox().is_empty());
    }

    /// The permission table rests on this: QuickJS hands out no way to reach
    /// the network or the disk, so those permissions mean something. If this
    /// starts failing the runtime grew an intrinsic and the table is wrong.
    #[test]
    fn a_plugin_finds_no_network_or_filesystem_global() {
        let mut bare = manifest();
        bare.permissions = vec![Permission::AddCommands];
        let mut plugin = JsSandbox::load(bare, fixtures::JS_REACH.as_bytes()).expect("load");
        let json = plugin.call_command(&fixtures::call()).expect("call");
        let found: serde_json::Value = serde_json::from_str(&json).expect("reach answers json");
        let reachable = found["reachable"].as_array().expect("reachable is a list");
        assert!(reachable.is_empty(), "plugin reached {reachable:?}");
    }
}

#[cfg(feature = "wasm")]
mod wasm {
    use super::*;
    use ircx_plugin::wasm::WasmSandbox;
    use ircx_plugin::Permission;

    fn survives(source: &[u8]) -> (Failure, Duration) {
        let mut plugin = WasmSandbox::load(manifest(), source).expect("load");
        let at = Instant::now();
        let failure = plugin
            .call_command(&fixtures::call())
            .expect_err("plugin misbehaves");
        let took = at.elapsed();
        drop(plugin);

        let mut fresh = WasmSandbox::load(manifest(), fixtures::WASM_ECHO).expect("load");
        assert!(fresh
            .call_command(&fixtures::call())
            .expect("host still runs")
            .starts_with("pong:"));
        (failure, took)
    }

    #[test]
    fn a_trapping_plugin_reports_and_leaves_the_host_running() {
        let (failure, _) = survives(fixtures::WASM_PANIC);
        assert!(
            matches!(&failure, Failure::Raised(m) if m.contains("unreachable")),
            "{failure}"
        );
    }

    #[test]
    fn a_looping_plugin_is_terminated_on_its_deadline() {
        let (failure, took) = survives(fixtures::WASM_LOOP);
        assert_eq!(failure, Failure::Timeout);
        assert!(took < manifest().call_timeout + SLACK, "took {took:?}");
    }

    #[test]
    fn a_plugin_that_grows_without_end_is_capped_and_carries_on() {
        let mut plugin = WasmSandbox::load(manifest(), fixtures::WASM_MEMORY).expect("load");
        plugin.call_command(&fixtures::call()).expect("no trap");
        assert!(
            plugin.memory_bytes() <= manifest().memory_limit,
            "guest holds {} bytes",
            plugin.memory_bytes()
        );
    }

    #[test]
    fn sending_needs_the_grant() {
        let mut granted = WasmSandbox::load(manifest(), fixtures::WASM_SENDER).expect("load");
        granted.call_command(&fixtures::call()).expect("sends");
        assert_eq!(granted.outbox().len(), 1);

        let mut bare = manifest();
        bare.permissions = vec![Permission::AddCommands];
        assert!(
            matches!(
                WasmSandbox::load(bare, fixtures::WASM_SENDER),
                Err(Failure::Denied(_))
            ),
            "without the grant the import does not exist and the module cannot instantiate"
        );
    }

    /// The wasm equivalent of the QuickJS global check. A module's imports are
    /// its whole capability list, so asking for WASI is asking for something
    /// the host never defined, and it is refused before any code runs.
    #[test]
    fn a_module_that_imports_wasi_cannot_be_instantiated() {
        let mut bare = manifest();
        bare.permissions = vec![Permission::AddCommands];
        assert!(
            matches!(
                WasmSandbox::load(bare, fixtures::WASM_WASI),
                Err(Failure::Denied(_))
            ),
            "an import the host does not define must stop instantiation"
        );
    }

    #[test]
    fn a_precompiled_module_behaves_like_the_one_it_came_from() {
        let compiled = WasmSandbox::precompile(fixtures::WASM_ECHO).expect("precompile");
        let mut plugin =
            unsafe { WasmSandbox::load_precompiled(manifest(), &compiled) }.expect("load");
        assert!(plugin
            .call_command(&fixtures::call())
            .expect("call")
            .starts_with("pong:"));
    }
}

#[cfg(feature = "proc")]
mod proc {
    use super::*;
    use ircx_plugin::proc::ProcSandbox;
    use ircx_plugin::Permission;
    use std::path::Path;

    fn exe() -> &'static Path {
        Path::new(env!("CARGO_BIN_EXE_plugin-child"))
    }

    fn survives(mode: &str) -> (Failure, Duration) {
        let mut plugin = ProcSandbox::spawn(manifest(), exe(), mode).expect("spawn");
        let at = Instant::now();
        let failure = plugin
            .call_command(&fixtures::call())
            .expect_err("plugin misbehaves");
        let took = at.elapsed();
        drop(plugin);

        let mut fresh = ProcSandbox::spawn(manifest(), exe(), "echo").expect("spawn");
        assert!(fresh
            .call_command(&fixtures::call())
            .expect("host still runs")
            .starts_with("pong:"));
        (failure, took)
    }

    #[test]
    fn a_panicking_plugin_reports_and_leaves_the_host_running() {
        let (failure, _) = survives("panic");
        assert!(
            matches!(&failure, Failure::Raised(m) if m.contains("exited")),
            "{failure}"
        );
    }

    #[test]
    fn a_looping_plugin_is_killed_on_its_deadline() {
        let (failure, took) = survives("loop");
        assert_eq!(failure, Failure::Timeout);
        assert!(took < manifest().call_timeout + SLACK, "took {took:?}");
    }

    #[test]
    fn a_plugin_that_answers_nothing_is_killed_on_its_deadline() {
        let (failure, took) = survives("hang");
        assert_eq!(failure, Failure::Timeout);
        assert!(took < manifest().call_timeout + SLACK, "took {took:?}");
    }

    #[test]
    fn a_plugin_that_allocates_without_end_dies_under_its_rlimit() {
        let (failure, took) = survives("memory");
        assert!(
            matches!(&failure, Failure::Raised(m) if m.contains("exited")),
            "the kernel refuses the allocation and the plugin aborts: {failure}"
        );
        assert!(took < manifest().call_timeout, "took {took:?}");
    }

    #[test]
    fn sending_needs_the_grant() {
        let mut granted = ProcSandbox::spawn(manifest(), exe(), "sender").expect("spawn");
        granted.call_command(&fixtures::call()).expect("sends");
        assert_eq!(granted.outbox().len(), 1);

        let mut bare = manifest();
        bare.permissions = vec![Permission::AddCommands];
        let mut denied = ProcSandbox::spawn(bare, exe(), "sender").expect("spawn");
        assert!(
            matches!(
                denied.call_command(&fixtures::call()),
                Err(Failure::Denied(_))
            ),
            "the parent is the only thing that can refuse"
        );
    }

    /// This one asserts the hole rather than the guarantee. If it ever starts
    /// failing, something began sandboxing the child and the permission table
    /// in `docs/plugin-isolation.md` needs revisiting.
    #[test]
    fn nothing_stops_a_plugin_process_reading_files_it_was_never_granted() {
        let mut bare = manifest();
        bare.permissions = vec![Permission::AddCommands];
        let mut rogue = ProcSandbox::spawn(bare, exe(), "rogue").expect("spawn");
        let reply = rogue.call_command(&fixtures::call()).expect("call");
        assert!(reply.contains("read /etc/passwd"), "{reply}");
    }
}
