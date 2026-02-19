"use client";

import { SettingsLayout } from "../../../components/SettingsLayout";
import { useApi } from "../../../hooks/useApi";
import { ContextPanel } from "../../../views/Settings";
import { ProtectedShell } from "../../protected-shell";

export default function SettingsContextPage() {
  const api = useApi();
  return (
    <ProtectedShell>
      <SettingsLayout>
        <ContextPanel api={api} />
      </SettingsLayout>
    </ProtectedShell>
  );
}
