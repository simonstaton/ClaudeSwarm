"use client";

import { SettingsLayout } from "../../../components/SettingsLayout";
import { useApi } from "../../../hooks/useApi";
import { ApiKeyPanel } from "../../../views/Settings";
import { ProtectedShell } from "../../protected-shell";

export default function SettingsApiKeyPage() {
  const api = useApi();
  return (
    <ProtectedShell>
      <SettingsLayout>
        <ApiKeyPanel api={api} />
      </SettingsLayout>
    </ProtectedShell>
  );
}
