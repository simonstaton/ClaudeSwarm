"use client";

import { SettingsLayout } from "../../../components/SettingsLayout";
import { useApi } from "../../../hooks/useApi";
import { IntegrationsPanel } from "../../../views/Settings";
import { ProtectedShell } from "../../protected-shell";

export default function SettingsIntegrationsPage() {
  const api = useApi();
  return (
    <ProtectedShell>
      <SettingsLayout>
        <IntegrationsPanel api={api} />
      </SettingsLayout>
    </ProtectedShell>
  );
}
