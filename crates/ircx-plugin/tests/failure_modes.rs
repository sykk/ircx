//! The hard requirement in #13 is that a broken plugin cannot take the host
//! with it, so it is asserted rather than described. Each test misbehaves one
//! way and then makes the same process run a working plugin — if the host were
//! gone the second half could not run.

use std::path::Path;
use std::time::{Duration, Instant};

use ircx_plugin::{net, Failure, Grants, Limits, Permission, PluginRuntime, Route, Sandbox};

mod common;
use common::{author, call, grants, in_channels, TARGET};

/// Generous next to the 100 ms deadline: the assertion is that termination
/// happens on the deadline's order rather than never, not that it is prompt to
/// the millisecond on a loaded machine.
const SLACK: Duration = Duration::from_millis(2_000);

fn limits() -> Limits {
    Limits {
        call: Duration::from_millis(100),
        memory: 8 << 20,
        grace: Duration::from_millis(250),
    }
}

fn allowed() -> Grants {
    grants(&[Permission::AddCommands, Permission::RenderContent])
}

fn load(directory: &Path, source: &str) -> Sandbox {
    Sandbox::load(
        &allowed(),
        limits(),
        net::refuses(),
        source,
        directory.join("data.json"),
    )
    .expect("the fixture loads")
}

/// Runs a misbehaving plugin, then loads a fresh one in the same process and
/// makes it answer.
fn survives(command: &str, source: &str) -> (Failure, Duration) {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let mut plugin = load(directory.path(), source);
    let at = Instant::now();
    let failure = plugin
        .call(&call(command, "hello"))
        .expect_err("plugin misbehaves");
    let took = at.elapsed();
    drop(plugin);

    let mut fresh = load(directory.path(), include_str!("plugins/echo.js"));
    let reply = fresh
        .call(&call("echo", "hello"))
        .expect("the host still runs");
    assert_eq!(reply.content.as_deref(), Some("pong: hello"));
    (failure, took)
}

/// One runtime with the two plugins named, both granted, both routed.
fn runtime_with(root: &Path, plugins: &[(&str, &str)]) -> PluginRuntime {
    let runtime =
        PluginRuntime::open(root.join("plugins"), limits(), net::refuses()).expect("open");
    for (id, source) in plugins {
        let source = author(root, id, source, allowed());
        runtime.install(&source).expect("install");
        runtime.set_grants(id, allowed()).expect("grant");
    }
    runtime
}

fn route(runtime: &PluginRuntime, command: &str) -> Route {
    runtime.route(command).expect("the plugin owns its command")
}

#[test]
fn a_throwing_plugin_reports_and_leaves_the_host_running() {
    let (failure, _) = survives("panic", include_str!("plugins/panic.js"));
    assert!(
        matches!(&failure, Failure::Raised(message) if message.contains("boom")),
        "{failure}"
    );
}

#[test]
fn a_looping_plugin_is_terminated_on_its_deadline() {
    let (failure, took) = survives("loop", include_str!("plugins/loop.js"));
    assert_eq!(failure, Failure::Timeout);
    assert!(took < limits().call + SLACK, "took {took:?}");
}

/// The interrupt handler runs between bytecodes, so a loop inside QuickJS's own
/// C could be invisible to it. This build calls the handler from the regex
/// engine too, which is a property of the build rather than of QuickJS: a
/// version bump could regress it silently, and this is what would catch it.
#[test]
fn a_plugin_looping_inside_the_regex_engine_is_also_terminated() {
    let (failure, took) = survives("regex", include_str!("plugins/regex.js"));
    assert_eq!(failure, Failure::Timeout);
    assert!(took < limits().call + SLACK, "took {took:?}");
}

/// `Atomics.wait` is the one way a plugin could park in C where the deadline
/// cannot see it. This build refuses it, which is what lets the host say a
/// plugin can spin but cannot hang — for as long as no host function waits.
#[test]
fn a_plugin_cannot_park_itself_where_the_deadline_cannot_see_it() {
    let (failure, took) = survives("atomics", include_str!("plugins/atomics.js"));
    assert!(
        matches!(&failure, Failure::Raised(message) if message.contains("cannot block")),
        "{failure}"
    );
    assert!(took < limits().call, "took {took:?}");
}

/// Hooks are synchronous, so a promise that never settles is refused rather
/// than waited for. Making them asynchronous would give that away: nothing
/// would be executing to trip the deadline while a job queue sat empty, and the
/// host would have to time out the pump itself.
#[test]
fn a_promise_that_never_settles_is_refused_rather_than_waited_for() {
    let (failure, took) = survives("hang", include_str!("plugins/hang.js"));
    assert!(
        matches!(&failure, Failure::Raised(message) if message.contains("answer with text now")),
        "{failure}"
    );
    assert!(took < limits().call, "took {took:?}");
}

#[test]
fn a_plugin_that_allocates_without_end_hits_its_memory_limit() {
    let (failure, _) = survives("memory", include_str!("plugins/memory.js"));
    assert_eq!(failure, Failure::OutOfMemory);
}

#[test]
fn a_terminated_runtime_is_not_asked_to_run_again() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let mut plugin = load(directory.path(), include_str!("plugins/loop.js"));
    assert_eq!(plugin.call(&call("loop", "one")), Err(Failure::Timeout));
    assert_eq!(
        plugin.call(&call("loop", "two")),
        Err(Failure::Timeout),
        "a runtime interrupted mid-call is not offered more work"
    );
}

#[test]
fn one_broken_plugin_leaves_the_others_answering() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = runtime_with(
        root.path(),
        &[
            ("loop", include_str!("plugins/loop.js")),
            ("echo", include_str!("plugins/echo.js")),
        ],
    );

    let failure = runtime
        .run(&route(&runtime, "loop"), call("loop", "hello"))
        .expect_err("the loop is terminated");
    assert_eq!(failure.failure, Failure::Timeout);
    assert!(
        failure.to_string().contains("loop"),
        "an error names the plugin: {failure}"
    );

    let reply = runtime
        .run(&route(&runtime, "echo"), call("echo", "hello"))
        .expect("the host runs");
    assert_eq!(reply.content.as_deref(), Some("pong: hello"));
}

/// The reload path that #13's "terminated and reported" needs to mean
/// anything: a plugin stopped on its deadline is not dead for the session, it
/// is loaded again the next time the user asks for it.
#[test]
fn a_terminated_plugin_is_loaded_again_for_the_next_command() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = runtime_with(root.path(), &[("loop", include_str!("plugins/loop.js"))]);
    let route = route(&runtime, "loop");

    for _ in 0..2 {
        let failure = runtime
            .run(&route, call("loop", "hello"))
            .expect_err("it loops every time");
        assert_eq!(
            failure.failure,
            Failure::Timeout,
            "a fresh runtime is loaded rather than the dead one being handed back"
        );
    }
}

/// A command that sends without end is the flood the spec names. The call is
/// stopped at the cap and nothing goes out, because a half-sent flood is still
/// a flood.
#[test]
fn a_plugin_that_floods_is_stopped_at_the_cap() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let allowed = in_channels(
        grants(&[
            Permission::AddCommands,
            Permission::SendMessages,
            Permission::RenderContent,
        ]),
        &[TARGET],
    );
    let mut plugin = Sandbox::load(
        &allowed,
        limits(),
        net::refuses(),
        include_str!("plugins/flooder.js"),
        directory.path().join("data.json"),
    )
    .expect("load");
    assert_eq!(
        plugin.call(&call("flooder", "hello")),
        Err(Failure::Flooded)
    );
}
