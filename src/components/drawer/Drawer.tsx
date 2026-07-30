import { useEffect } from "react";
import { useAppStore } from "@/store";
import { useContextViewId } from "@/store/selectors";
import { ContextPanel } from "./ContextPanel";

/** The context panel's place in the shared sidebar. Mount unconditionally: it
 * renders nothing while closed, but it owns the shortcut that opens it. */
export function Drawer() {
  const open = useAppStore((s) => s.drawerOpen);
  const embedded = useAppStore((s) => s.contextMode === "embedded");
  const toggleDrawer = useAppStore((s) => s.toggleDrawer);
  const view = useContextViewId();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "m"
      ) {
        event.preventDefault();
        toggleDrawer();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleDrawer]);

  // Embedded, the panel is drawn by its pane instead.
  if (!open || embedded) return null;
  return <ContextPanel view={view} />;
}
