"use client";

import { Messages } from "../../views/Messages";
import { ProtectedShell } from "../protected-shell";

export default function MessagesPage() {
  return (
    <ProtectedShell>
      <Messages />
    </ProtectedShell>
  );
}
