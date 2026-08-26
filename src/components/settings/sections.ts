import type { IconName } from "@/components/common/Icon";

export type SectionId =
  | "appearance"
  | "notifications"
  | "uploads"
  | "transfers"
  | "privacy"
  | "plugins"
  | "diagnostics"
  | "networks";

export interface Section {
  id: SectionId;
  name: string;
  icon: IconName;
}

/**
 * The sections, in the order the sidebar lists them.
 *
 * The order is how far each one reaches: what the window looks like, then what
 * is allowed to interrupt you, then where files go — to a host, then straight
 * between two clients — then what is written down about you, then what other people's code is allowed to do, then what those
 * connections report, and last the machines this client talks to — the only
 * one of the seven that reaches off this computer.
 *
 * Networks was the deliberate gap while settings was a window of its own:
 * configuring a network is the onboarding flow, its last step watches the
 * connection, and that window ran no event bridge to watch it with. A dialog
 * inside the client does, so the gap closed with the window.
 *
 * Appearance stays first, and so stays what `openSettings` lands on when
 * nobody named a section.
 */
export const SECTIONS: readonly Section[] = [
  { id: "appearance", name: "Appearance", icon: "droplet" },
  { id: "notifications", name: "Notifications", icon: "bell" },
  { id: "uploads", name: "Uploads", icon: "paperclip" },
  { id: "transfers", name: "Transfers", icon: "tray" },
  { id: "privacy", name: "Privacy", icon: "shield" },
  { id: "plugins", name: "Plugins", icon: "plug" },
  { id: "diagnostics", name: "Diagnostics", icon: "settings" },
  { id: "networks", name: "Networks", icon: "globe" },
];
