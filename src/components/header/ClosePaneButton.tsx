import { Icon } from "@/components/common/Icon";
import { useAppStore } from "@/store";
import type { ViewId } from "@/store/types";
import { HeaderButton } from "./HeaderButton";

/**
 * Drawn only once the window is split, for the reason the focus indicator is:
 * `closeView` refuses the last pane, so with one pane this would be a control
 * that declines. #297 — until it existed a pane could be made with a drag and
 * unmade only with a chord, so what people reached for was closing the
 * conversation the pane happened to be showing.
 */
export function ClosePaneButton({ view }: { view: ViewId | null }) {
  const split = useAppStore((s) => s.viewOrder.length > 1);
  const closeView = useAppStore((s) => s.closeView);

  if (!split || view === null) return null;

  return (
    <HeaderButton label="Close pane" title="Close pane (Ctrl+W)" onClick={() => closeView(view)}>
      <Icon name="close" size={16} />
    </HeaderButton>
  );
}
