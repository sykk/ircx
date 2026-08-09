import type { IconName } from "@/components/common/Icon";

export type SectionId = "appearance";

export interface Section {
  id: SectionId;
  name: string;
  icon: IconName;
  /** Under the heading, saying what the page is for. */
  blurb: string;
}

/**
 * The settings window's sections, in the order the sidebar lists them.
 *
 * One so far, and the list is short for the reason it is a list at all: a row
 * is added when the settings behind it exist. The client already holds four
 * more sets — the networks, the archive's retention, the upload provider and
 * the plugin grants — each in a sheet of its own reachable only from the
 * command palette, and each belongs here. They are not listed yet because a
 * row that opens an empty page is a worse answer than no row.
 */
export const SECTIONS: readonly Section[] = [
  {
    id: "appearance",
    name: "Appearance",
    icon: "droplet",
    blurb: "What the window looks like, and how a conversation is set in it.",
  },
];
