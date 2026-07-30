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

/// A plugin that is reinstalled keeps what it was allowed, because the user
/// already answered that question — but only as far as the new manifest still
/// asks for the same things.
#[test]
fn an_upgrade_keeps_the_grants_it_still_asks_for() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let mut library = Library::open(root.path().join("plugins")).expect("open");
    library
        .install(&author(root.path(), "echo", ECHO, asked()))
        .expect("install");
    library.set_grants("echo", asked()).expect("grant");

    let installed = library
        .install(&author(root.path(), "echo", ECHO, asked()))
        .expect("reinstall the same version");
    assert!(installed.grants.holds(Permission::SendMessages));

    let narrower = grants(&[Permission::AddCommands]);
    let installed = library
        .install(&author(root.path(), "echo", ECHO, narrower))
        .expect("install a version that asks for less");
    assert_eq!(
        installed.grants,
        Grants::default(),
        "a grant the new version does not ask for is not carried over"
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
