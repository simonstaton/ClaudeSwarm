"use client";

import { SettingsLayout } from "../../../components/SettingsLayout";
import { useApi } from "../../../hooks/useApi";
import { ConfigPanel } from "../../../views/Settings";
import { ProtectedShell } from "../../protected-shell";

export default function SettingsConfigPage() {
  const api = useApi();
  return (
    <ProtectedShell>
      <SettingsLayout>
        <ConfigPanel api={api} />
      </SettingsLayout>
    </ProtectedShell>
  );
}
