import type { IconName } from "@/components/common/Icon";

export type SectionId = "appearance" | "uploads" | "privacy" | "plugins";

export interface Section {
  id: SectionId;
  name: string;
  icon: IconName;
}

/**
 * The settings window's sections, in the order the sidebar lists them.
 *
 * The order is how far each one reaches: what the window looks like, then
 * where files go, then what is written down about you, then what other
 * people's code is allowed to do.
 *
 * Networks are not here, and that is the one deliberate gap. Configuring a
 * network is the onboarding flow — pick, fill in, connect — and its last step
 * watches the connection, which this window cannot see: it runs no event
 * bridge, on purpose. Adding a network ends in connecting, and connecting is
 * the client's. So the sidebar's `+` and the channel header's `⋮` still open
 * that form where the conversation is.
 */
export const SECTIONS: readonly Section[] = [
  { id: "appearance", name: "Appearance", icon: "droplet" },
  { id: "uploads", name: "Uploads", icon: "paperclip" },
  { id: "privacy", name: "Privacy", icon: "shield" },
  { id: "plugins", name: "Plugins", icon: "plug" },
];

/** Whether a string names a section. The query a window opens at is a URL the
 * user can edit, and so is untrusted input rather than what was written. */
export function isSectionId(value: string): value is SectionId {
  return SECTIONS.some((section) => section.id === value);
}
