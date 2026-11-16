import { useCallback, useState } from "react";
import type { ServerSummary } from "@mineserver/shared";
import { useAuth } from "../../auth";
import { AddonsTab } from "./AddonsTab";
import { BrowseTab } from "./BrowseTab";

export function ModsTab({
  server,
  marketplaceEnabled,
  refresh,
}: {
  server: ServerSummary;
  marketplaceEnabled: boolean;
  refresh(): void;
}) {
  const { role } = useAuth();
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => {
    setRevision((value) => value + 1);
    refresh();
  }, [refresh]);
  return (
    <div
      className={`mods-workspace${role === "admin" && marketplaceEnabled ? " split" : ""}`}
    >
      {role === "admin" && (
        <section className="mods-pane" aria-label="Downloaded mods">
          <div className="mods-pane-heading">
            <h2>Downloaded</h2>
            <span className="muted">Latest added first</span>
          </div>
          <AddonsTab
            server={server}
            refreshVersion={revision}
            onChanged={changed}
          />
        </section>
      )}
      {marketplaceEnabled && (
        <section className="mods-pane" aria-label="Browse mods">
          <div className="mods-pane-heading">
            <h2>Browse</h2>
            <span className="muted">Modrinth</span>
          </div>
          <BrowseTab
            server={server}
            refreshVersion={revision}
            refresh={changed}
          />
        </section>
      )}
    </div>
  );
}
