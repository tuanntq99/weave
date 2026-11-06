import { useEffect } from "react";
import { useUi } from "./ui-context";
import { useWorkspace } from "./workspace-context";

const WARNED = "notes:persistWarned";

/** Asks the browser, once Notes has opened, to keep its data when it runs
 *  short of space — and says so, once, when it will not: then exporting now
 *  and then is what keeps the pages safe. Draws nothing. */
export function StorageGuard() {
  const { platform } = useWorkspace();
  const { toast } = useUi();

  useEffect(() => {
    if (!platform) return;
    let active = true;
    void platform.storage.ensurePersistent().then((answer) => {
      if (!active || answer !== "denied") return;
      try {
        if (localStorage.getItem(WARNED)) return;
        localStorage.setItem(WARNED, new Date().toISOString());
      } catch {
        return;
      }
      toast("This browser may clear its data when space runs low: export a backup now and then (Settings → Export)", "info");
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [platform, toast]);

  return null;
}
