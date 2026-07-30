//! Installing, granting and revoking. Everything a plugin says about itself is
//! hostile input, so this is mostly about what the library refuses.

use std::fs;

use ircx_plugin::{net, Grants, Library, LibraryError, Limits, Permission, PluginRuntime};

mod common;
use common::{author, grants, in_channels};

const ECHO: &str = include_str!("plugins/echo.js");

fn asked() -> Grants {
    in_channels(
        grants(&[
            Permission::AddCommands,
            Permission::SendMessages,
            Permission::RenderContent,
        ]),
        &["#ircx"],
    )
}

#[test]
fn a_library_with_no_folder_holds_no_plugins() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let library = Library::open(root.path().join("never-created")).expect("open");
    assert!(library.installed().is_empty());
}

#[test]
fn installing_grants_nothing_until_the_user_says_otherwise() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let mut library = Library::open(root.path().join("plugins")).expect("open");
    let source = author(root.path(), "echo", ECHO, asked());

    let installed = library.install(&source).expect("install");
    assert_eq!(installed.manifest.requests, asked());
    assert_eq!(
        installed.grants,
        Grants::default(),
        "what it asked for is not what it got"
    );
}

/// The source is a folder the user picked, so picking the wrong one is the
/// ordinary mistake rather than a corrupt install. Both halves of "a plugin is
/// a manifest and the file it names" say which half is missing.
#[test]
fn a_folder_that_is_not_a_plugin_says_what_it_is_missing() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let mut library = Library::open(root.path().join("plugins")).expect("open");

    let empty = root.path().join("holiday-photos");
    fs::create_dir_all(&empty).expect("a test can write to its own temporary directory");
    let refused = library
        .install(&empty)
        .expect_err("there is no plugin here");
    assert!(
        matches!(&refused, LibraryError::NotAPlugin(_)),
        "{refused:?}"
    );
    assert!(refused.to_string().contains("plugin.json"), "{refused}");

    let source = author(root.path(), "echo", ECHO, asked());
    fs::remove_file(source.join("main.js")).expect("take the code away");
    let refused = library.install(&source).expect_err("the code is gone");
    assert!(
        matches!(&refused, LibraryError::MissingEntry(id, entry) if id == "echo" && entry == "main.js"),
        "{refused:?}"
    );
}

#[test]
fn nothing_can_be_granted_that_was_not_asked_for() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let mut library = Library::open(root.path().join("plugins")).expect("open");
    let source = author(root.path(), "echo", ECHO, asked());
    library.install(&source).expect("install");

    let too_much = grants(&[Permission::AddCommands, Permission::NetworkRequests]);
    assert!(
        matches!(
            library.set_grants("echo", too_much),
            Err(LibraryError::Refused(id, _)) if id == "echo"
        ),
        "a permission the manifest never asked for cannot be granted"
    );

    let elsewhere = in_channels(grants(&[Permission::SendMessages]), &["#somewhere-else"]);
    assert!(
        matches!(
            library.set_grants("echo", elsewhere),
            Err(LibraryError::Refused(_, _))
        ),
        "nor a channel it never asked for"
    );
}

#[test]
fn granting_less_is_the_way_a_grant_is_revoked() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let mut library = Library::open(root.path().join("plugins")).expect("open");
    let source = author(root.path(), "echo", ECHO, asked());
    library.install(&source).expect("install");

    let installed = library.set_grants("echo", asked()).expect("grant");
    assert!(installed.grants.holds(Permission::SendMessages));

    let less = grants(&[Permission::AddCommands, Permission::RenderContent]);
    let installed = library.set_grants("echo", less).expect("revoke sending");
    assert!(!installed.grants.holds(Permission::SendMessages));

    // And it is on disk, not only in memory: the next launch reads the same.
    let library = Library::open(root.path().join("plugins")).expect("reopen");
    let installed = library.get("echo").expect("still installed");
    assert!(!installed.grants.holds(Permission::SendMessages));
    assert!(installed.grants.holds(Permission::AddCommands));
}

/// Install copies the manifest and the code, and nothing else, so a plugin
/// cannot arrive with the grants it would like to have already written.
#[test]
fn a_plugin_cannot_ship_its_own_grants() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let mut library = Library::open(root.path().join("plugins")).expect("open");
    let source = author(root.path(), "echo", ECHO, asked());
    let planted = serde_json::to_vec(&asked()).expect("serialise");
    fs::write(source.join("grants.json"), planted).expect("plant a grants file");

    let installed = library.install(&source).expect("install");
    assert_eq!(installed.grants, Grants::default());
}

#[test]
fn a_manifest_that_could_read_outside_its_own_folder_is_refused() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let mut library = Library::open(root.path().join("plugins")).expect("open");

    for (id, entry) in [
        ("escaper", "../../../etc/passwd"),
        ("escaper", "sub/main.js"),
        ("escaper", "main.txt"),
        ("../escaper", "main.js"),
        ("Escaper", "main.js"),
    ] {
        let source = root.path().join("bad-source");
        fs::create_dir_all(&source).expect("write a plugin");
        let manifest = format!(
            r#"{{"id":"{id}","name":"n","version":"1","entry":"{entry}","permissions":[]}}"#
        );
        fs::write(source.join("plugin.json"), manifest).expect("write the manifest");
        fs::write(source.join("main.js"), ECHO).expect("write the code");

        assert!(
            matches!(library.install(&source), Err(LibraryError::Rejected(_))),
            "id {id:?} with entry {entry:?} should not install"
        );
    }
}

#[test]
fn a_manifest_that_asks_for_a_scope_without_naming_one_is_refused() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let mut library = Library::open(root.path().join("plugins")).expect("open");

    for asked in [
        grants(&[Permission::AccessChannels]),
        grants(&[Permission::NetworkRequests]),
    ] {
        let source = author(root.path(), "vague", ECHO, asked);
        assert!(matches!(
            library.install(&source),
            Err(LibraryError::Rejected(_))
        ));
    }
}

/// Reinstalling grants nothing, exactly like a first install. The user answered
/// for the code they were shown, and an id is only a folder name: a second
/// install claiming the same one would otherwise inherit that answer and be
/// able to act on it before anybody was asked again.
#[test]
fn an_upgrade_starts_from_no_grants() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let mut library = Library::open(root.path().join("plugins")).expect("open");
    library
        .install(&author(root.path(), "echo", ECHO, asked()))
        .expect("install");
    library.set_grants("echo", asked()).expect("grant");

    let installed = library
        .install(&author(root.path(), "echo", ECHO, asked()))
        .expect("reinstall the same version");
    assert_eq!(
        installed.grants,
        Grants::default(),
        "the grants belong to the code the user was asked about"
    );

    // And on disk, so a launch after the reinstall reads the same.
    let library = Library::open(root.path().join("plugins")).expect("reopen");
    assert_eq!(
        library.get("echo").expect("still installed").grants,
        Grants::default()
    );
}

/// The same rule seen from the routing table: code installed under a name the
/// user has already answered for adds no command until they answer again.
#[test]
fn code_installed_over_a_granted_plugin_routes_nothing() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = PluginRuntime::open(
        root.path().join("plugins"),
        Limits::default(),
        net::refuses(),
    )
    .expect("open");
    runtime
        .install(&author(root.path(), "echo", ECHO, asked()))
        .expect("install");
    runtime.set_grants("echo", asked()).expect("grant");
    assert!(runtime.route("echo").is_some(), "granted, so it routes");

    runtime
        .install(&author(root.path(), "echo", ECHO, asked()))
        .expect("install different code under the same id");

    assert!(
        runtime.route("echo").is_none(),
        "the new code has no command until the user allows it one"
    );
}

#[test]
fn removing_a_plugin_takes_its_commands_with_it() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = PluginRuntime::open(
        root.path().join("plugins"),
        Limits::default(),
        net::refuses(),
    )
    .expect("open");
    runtime
        .install(&author(root.path(), "echo", ECHO, asked()))
        .expect("install");
    runtime.set_grants("echo", asked()).expect("grant");
    assert!(runtime.route("echo").is_some());

    runtime.remove("echo").expect("remove");
    assert!(runtime.route("echo").is_none());
    assert!(runtime.installed().is_empty());
    assert!(!root.path().join("plugins/echo").exists());
}
