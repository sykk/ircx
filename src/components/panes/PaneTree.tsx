import { useAppStore } from "@/store";
import type { Layout } from "@/store/types";
import { ChatPane } from "./ChatPane";

export function PaneTree() {
  const layout = useAppStore((s) => s.layout);
  if (!layout) return <ChatPane view={null} />;
  return <PaneNode node={layout} />;
}

function PaneNode({ node }: { node: Layout }) {
  if (node.type === "view") return <ChatPane view={node.id} />;

  const row = node.direction === "row";
  return (
    <div className={row ? "flex h-full min-h-0 min-w-0" : "flex h-full min-h-0 min-w-0 flex-col"}>
      <div className="min-h-0 min-w-0 flex-1">
        <PaneNode node={node.children[0]} />
      </div>
      <div
        aria-hidden
        className={
          row
            ? "w-px shrink-0 bg-[var(--border-default)]"
            : "h-px shrink-0 bg-[var(--border-default)]"
        }
      />
      <div className="min-h-0 min-w-0 flex-1">
        <PaneNode node={node.children[1]} />
      </div>
    </div>
  );
}
