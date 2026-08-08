Build a lightweight, modern desktop IRC client using IRCv3, with Libera.Chat as the initial test network. The client should preserve IRC’s speed, openness, keyboard-driven workflow, nicknames, channels, and /commands, while making IRC approachable for users who do not understand traditional IRC terminology or configuration.

Product direction

The client should feel like a modern developer communication tool, not a Discord clone.

Keep:

Traditional networks, channels, nicknames, and queries
Compact text-focused messages without avatars
Strong keyboard navigation and slash commands
Access to raw IRC events, modes, numerics, and capabilities
Fast startup, low memory usage, and a small installation size

Modernize:

Simple network and account setup
IRCv3 message history, replies, reactions, typing indicators, account tracking, and server timestamps
Inline image, file, and link previews
Searchable command palette
Clear connection, account, security, and encryption indicators
Human-readable error messages
Optional local message history and offline search
Interface

Use a dark, minimal, terminal-inspired interface.

The main layout should contain:

Left sidebar
Networks
Channels
Private messages
Unread counters
Collapsible channel groups
Main conversation area
Compact nickname-based messages
Timestamps
Replies and quoted context
Reactions
Inline attachments
New-message divider
System messages displayed subtly
Message composer with Markdown and /command support
Collapsible right sidebar
Hidden by default or easily toggled
Channel topic and details
Member list grouped by operator, voiced, normal, and away
Search and filtering
User and channel inspector tabs
Bottom status bar
Connected network
TLS and SASL state
Latency
Negotiated IRCv3 capabilities
Plugin or script status

Avoid excessive panels, repeated encryption warnings, large avatars, oversized chat bubbles, and Discord-style visual clutter.

IRCv3 behavior

Use capability negotiation and adapt the interface to each server.

Potential capabilities include:

server-time
message-tags
batch
labeled-response
echo-message
account-notify
account-tag
extended-join
away-notify
chghost
invite-notify
multi-prefix
userhost-in-names
draft/chathistory
message IDs
replies
reactions
typing indicators
standard replies

Unsupported features must degrade gracefully to ordinary IRC messages rather than failing.

Architecture

Keep the core client small and separate it into clear layers:

UI
↓
Client state and message model
↓
IRCv3 capability and feature layer
↓
IRC protocol parser
↓
TLS network connection

Recommended core components:

core/
  connection
  parser
  protocol
  capability negotiation
  state
  commands
  storage

ui/
  networks
  channels
  timeline
  composer
  member drawer
  command palette
  settings

extensions/
  themes
  scripts
  plugins
  protocol adapters

Messages should use a structured internal model containing:

message ID
network
channel or query
sender nickname
sender account
timestamp
message text
IRC tags
reply target
batch ID
delivery state
attachment metadata
encryption state
raw IRC message
Extension system

Extensibility should be a major feature.

Support:

Declarative themes
User scripts
Sandboxed plugins
Custom slash commands
Message renderers
Link and attachment providers
Notification rules
Protocol capability adapters

Plugins should require explicit permissions such as:

read messages
send messages
add commands
store local data
access selected channels
make external network requests
render message content

A broken plugin must not crash the IRC connection or entire application.

Attachments

Do not transfer large files directly through IRC.

Use an attachment-provider system:

Upload through a configured provider.
Send a link and metadata through IRC.
Render previews in compatible clients.
Fall back to a normal link in traditional clients.
Do not automatically download remote files.
Allow encrypted uploads through an optional plugin.

Possible providers include S3-compatible storage, self-hosted storage, temporary file hosts, or no provider.

Storage

Use a lightweight local database such as SQLite.

Support:

Optional local history
Per-channel retention settings
Full-text search
Draft persistence
Saved network configuration
Encrypted credential storage
Easy export and deletion

Clearly distinguish between:

Current-session messages
Server-provided IRCv3 history
Locally archived history
Onboarding

First launch should offer:

Join a public network
Connect to an IRC server
Advanced manual configuration

The Libera.Chat flow should only require:

nickname
optional account credentials
channels to join

Hide TLS, SASL, capability negotiation, and reconnect details behind sensible defaults, while keeping advanced controls available.

Initial MVP

Start with:

TLS IRC connection
IRC parser and state management
IRCv3 capability negotiation
Libera.Chat connection profile
Networks, channels, queries, and member lists
Message timeline
Composer and slash commands
SASL authentication
Server timestamps and account tags
Local SQLite history
Collapsible member drawer
Basic theme and plugin APIs

Do not implement custom encryption, voice chat, file hosting, complex threads, or cloud synchronization in the first milestone. Design clean extension points for those features instead.
