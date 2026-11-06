import { Download, History, Trash2, Upload } from "lucide-react";
import { forgetThisDevice } from "@notes/sdk";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useUi } from "../../app/ui-context";
import { useWorkspace } from "../../app/workspace-context";
import { MenuItem } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { backupFileName, downloadBlob, lastExport, markExported } from "./data-export";

type Stage = { file: Blob; step: "choose" | "confirm-replace" } | null;

/** Settings' "Data": export everything to a file, import one back (adding
 *  what is missing, or replacing all), and when the last export was. The
 *  menu items go in the Settings menu; the import dialog is drawn beside it,
 *  so it outlives the menu closing. `onDone` closes the menu. */
export function useDataMenu(onDone: () => void): { items: ReactNode; dialog: ReactNode } {
  const { platform } = useWorkspace();
  const { toast } = useUi();
  const [exporting, setExporting] = useState(false);
  const [stage, setStage] = useState<Stage>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const [, rerender] = useState(0);

  const exportAll = useCallback(async () => {
    if (!platform || exporting) return;
    setExporting(true);
    try {
      const blob = await platform.backup.export();
      downloadBlob(blob, backupFileName());
      markExported();
      rerender((count) => count + 1);
      onDone();
    } catch {
      toast("Could not export: try again", "error");
    } finally {
      setExporting(false);
    }
  }, [exporting, onDone, platform, toast]);

  const runImport = useCallback(async (file: Blob, mode: "merge" | "replace") => {
    if (!platform) return;
    setBusy(true);
    try {
      const done = await platform.backup.import(file, mode);
      toast(`Imported ${done.records} records and ${done.files} files`, "success");
      setStage(null);
    } catch (error) {
      toast((error as { code?: string } | null)?.code === "bad_backup" ? "That is not a valid backup file" : "Could not import: try again", "error");
      setStage(null);
    } finally {
      setBusy(false);
    }
  }, [platform, toast]);

  const last = lastExport();
  const items = (
    <>
      <div className="menu__section-title">Data</div>
      <MenuItem
        icon={<Download size={16} />}
        label={exporting ? "Exporting…" : "Export all data"}
        disabled={exporting || !platform}
        onSelect={() => void exportAll()}
      />
      <MenuItem
        icon={<Upload size={16} />}
        label="Import data…"
        disabled={!platform}
        onSelect={() => picker.current?.click()}
      />
      <MenuItem
        icon={<Trash2 size={16} />}
        label="Clear this device"
        tone="danger"
        onSelect={() => {
          onDone();
          void forgetThisDevice().then((outcome) => {
            if (outcome === "pending") toast("Some changes have not reached the server yet: wait for sync to finish", "error");
            else window.location.reload();
          });
        }}
      />
      <MenuItem
        icon={<History size={16} />}
        label="Last export"
        hint={last ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(last) : "Never"}
        disabled
        onSelect={() => undefined}
      />
    </>
  );

  const dialog = (
    <>
      <input
        ref={picker}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          onDone();
          setStage({ file, step: "choose" });
        }}
      />
      <Modal open={stage !== null} label="Import data" className="confirm" onClose={() => { if (!busy) setStage(null); }}>
        {stage?.step === "confirm-replace" ? (
          <>
            <h2 className="confirm__title">Replace everything on this device?</h2>
            <p className="confirm__body">Every page, file and setting in this browser is replaced by the file's. This cannot be undone.</p>
            <div className="confirm__actions">
              <button type="button" className="btn" autoFocus disabled={busy} onClick={() => setStage(null)}>Cancel</button>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void runImport(stage.file, "replace")}>Replace</button>
            </div>
          </>
        ) : (
          <>
            <h2 className="confirm__title">Import data</h2>
            <p className="confirm__body">Merge adds what is not in this browser yet and keeps everything here. Replace makes the file all there is.</p>
            <div className="confirm__actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setStage(null)}>Cancel</button>
              <button type="button" className="btn btn--outline" disabled={busy} onClick={() => stage && setStage({ file: stage.file, step: "confirm-replace" })}>Replace…</button>
              <button type="button" className="btn btn--primary" autoFocus disabled={busy} onClick={() => stage && void runImport(stage.file, "merge")}>Merge</button>
            </div>
          </>
        )}
      </Modal>
    </>
  );

  return { items, dialog };
}
