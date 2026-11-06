import { signedOut, sync } from "@notes/sdk";
import { useEffect, useState } from "react";

/** Says so when the server's sign-in has run out mid-session: what is
 *  waiting stays in the outbox, and a reload signs in again and sends it. */
export function SessionBanner() {
  const [ended, setEnded] = useState(signedOut());

  useEffect(() => sync.subscribe(() => setEnded(signedOut())), []);

  if (!ended) return null;
  return (
    <div className="session-banner" role="alert">
      <button type="button" className="session-banner__action" onClick={() => window.location.reload()}>
        Your session has ended. Sign in again
      </button>
    </div>
  );
}
