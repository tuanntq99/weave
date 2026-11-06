import { useEffect } from "react";
import { pageName } from "../core/block-tree";
import { useUi } from "./ui-context";
import { useWorkspace } from "./workspace-context";

/** Says, as a toast, when the window did not keep a change: one to a page
 *  this member may only view. Draws nothing itself. */
export function RefusalToasts() {
  const { document } = useWorkspace();
  const { toast } = useUi();

  useEffect(() => {
    if (!document) return;
    return document.onRefused((refusal) => {
      const page = refusal.pageId ? document.state.pages[refusal.pageId] : undefined;
      const title = (page && pageName(page)) || "Untitled";
      if (refusal.reason === "read_only") toast(`You can only view “${title}”`, "error");
      else toast(`A change to “${title}” could not be saved and was undone`, "error");
    });
  }, [document, toast]);

  return null;
}
