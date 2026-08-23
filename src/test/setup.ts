import { afterAll } from "vitest";

const FLUSH_SYNC_LIFECYCLE_WARNING =
  "flushSync was called from inside a lifecycle method. React cannot flush when React is already rendering. Consider moving this call to a scheduler task or micro task.";
const ACT_WARNING_PREFIX = "An update to %s inside a test was not wrapped in act(...).";

const reportError = console.error;

// React 19 reports TanStack's synchronous virtualizer measurements and the
// timeline layout harness's external-store frames even though those frames are
// settled and asserted by the layout tests. Keep both exceptions exact so all
// other console errors remain visible.
console.error = (...args: unknown[]) => {
  if (args.length === 1 && args[0] === FLUSH_SYNC_LIFECYCLE_WARNING) return;
  if (
    typeof args[0] === "string" &&
    args[0].startsWith(ACT_WARNING_PREFIX) &&
    args[1] === "TimelineFor"
  ) {
    return;
  }
  reportError(...args);
};

afterAll(() => {
  console.error = reportError;
});
