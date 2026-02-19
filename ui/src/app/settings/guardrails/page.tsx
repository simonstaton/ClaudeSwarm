"use client";

import { SettingsLayout } from "../../../components/SettingsLayout";
import { useApi } from "../../../hooks/useApi";
import { GuardrailsPanel } from "../../../views/Settings";
import { ProtectedShell } from "../../protected-shell";

export default function SettingsGuardrailsPage() {
  const api = useApi();
  return (
    <ProtectedShell>
      <SettingsLayout>
        <GuardrailsPanel api={api} />
      </SettingsLayout>
    </ProtectedShell>
  );
}
