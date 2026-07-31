// Re-exports the ts-rs output so application code imports from one place and
// never reaches into ./generated directly. Regenerate with `npm run bindings`.

/**
 * Where core files what the server says to you rather than to a channel: the
 * connection line, notices, the MOTD, your own umode, unhandled numerics.
 *
 * ts-rs generates types, not values, so this mirrors `SERVER_TARGET` in
 * `crates/ircx-core/src/session.rs`; `contract.test.ts` asserts they agree.
 */
export const SERVER_TARGET = "*";

export type { AppSnapshot } from "./generated/AppSnapshot";
export type { Attachment } from "./generated/Attachment";
export type { AttachmentPreview } from "./generated/AttachmentPreview";
export type { Channel } from "./generated/Channel";
export type { ChannelListing } from "./generated/ChannelListing";
export type { ChatMessage } from "./generated/ChatMessage";
export type { CommandOutcome } from "./generated/CommandOutcome";
export type { ConnectionStatus } from "./generated/ConnectionStatus";
export type { Delivery } from "./generated/Delivery";
export type { EncryptionState } from "./generated/EncryptionState";
export type { HistoryRequest } from "./generated/HistoryRequest";
export type { InstalledPlugin } from "./generated/InstalledPlugin";
export type { IrcxEvent } from "./generated/IrcxEvent";
export type { Member } from "./generated/Member";
export type { MessageKind } from "./generated/MessageKind";
export type { MessageSource } from "./generated/MessageSource";
export type { Network } from "./generated/Network";
export type { NetworkConfig } from "./generated/NetworkConfig";
export type { PluginCommand } from "./generated/PluginCommand";
export type { PluginGrants } from "./generated/PluginGrants";
export type { FileToUpload } from "./generated/FileToUpload";
export type { UploadMethod } from "./generated/UploadMethod";
export type { S3Credentials } from "./generated/S3Credentials";
export type { UploadProvider } from "./generated/UploadProvider";
export type { UploadedFile } from "./generated/UploadedFile";
export type { PluginPermission } from "./generated/PluginPermission";
export type { PluginPermissionInfo } from "./generated/PluginPermissionInfo";
export type { Query } from "./generated/Query";
export type { Annotation } from "./generated/Annotation";
export type { Reaction } from "./generated/Reaction";
export type { SaslConfig } from "./generated/SaslConfig";
export type { SaslMechanism } from "./generated/SaslMechanism";
export type { SaslStatus } from "./generated/SaslStatus";
export type { SearchHit } from "./generated/SearchHit";
export type { SearchRequest } from "./generated/SearchRequest";
export type { Sender } from "./generated/Sender";
export type { Severity } from "./generated/Severity";
export type { ThemeSource } from "./generated/ThemeSource";
export type { Topic } from "./generated/Topic";
