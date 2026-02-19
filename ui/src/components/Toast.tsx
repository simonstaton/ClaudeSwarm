"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

type ToastVariant = "success" | "error" | "warning" | "info";

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant, duration?: number) => void;
}

// ── Context ──────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

// ── Variant styles ───────────────────────────────────────────────────────────

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success: "border-green-500/40 bg-green-950/80 text-green-300",
  error: "border-red-500/40 bg-red-950/80 text-red-300",
  warning: "border-amber-500/40 bg-amber-950/80 text-amber-300",
  info: "border-zinc-500/40 bg-zinc-900/90 text-zinc-300",
};

const VARIANT_ICONS: Record<ToastVariant, string> = {
  success: "\u2713",
  error: "\u2717",
  warning: "\u26A0",
  info: "\u2139",
};

// ── Provider ─────────────────────────────────────────────────────────────────

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, variant: ToastVariant = "info", duration = 4000) => {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, message, variant, duration }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {/* Toast container — top-right, above all content */}
      <div className="fixed top-3 right-3 z-50 flex flex-col gap-2 pointer-events-none" style={{ maxWidth: 380 }}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Individual toast ─────────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    timerRef.current = setTimeout(() => setExiting(true), toast.duration);
    return () => clearTimeout(timerRef.current);
  }, [toast.duration]);

  useEffect(() => {
    if (exiting) {
      const t = setTimeout(() => onDismiss(toast.id), 300);
      return () => clearTimeout(t);
    }
  }, [exiting, toast.id, onDismiss]);

  return (
    <div
      className={`pointer-events-auto flex items-start gap-2 px-3 py-2.5 rounded-lg border text-sm shadow-lg backdrop-blur-sm transition-all duration-300 ${VARIANT_CLASSES[toast.variant]} ${
        exiting ? "opacity-0 translate-x-4" : "opacity-100 translate-x-0"
      }`}
    >
      <span className="text-xs mt-0.5 shrink-0">{VARIANT_ICONS[toast.variant]}</span>
      <span className="flex-1 leading-snug">{toast.message}</span>
      <button
        type="button"
        className="shrink-0 text-xs opacity-60 hover:opacity-100 transition-opacity mt-0.5"
        onClick={() => setExiting(true)}
      >
        \u2715
      </button>
    </div>
  );
}
