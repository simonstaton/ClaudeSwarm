"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function GuardrailField({
  label,
  labelHint,
  value,
  onChange,
  hint,
}: {
  label: string;
  labelHint?: string;
  value: number;
  onChange: (value: number) => void;
  hint: string;
}) {
  const id = `guardrail-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div>
      <Label htmlFor={id} className="text-sm text-zinc-400 mb-1 block">
        {label}
        {labelHint != null && <span className="text-xs text-zinc-400 ml-2">({labelHint})</span>}
      </Label>
      <Input
        id={id}
        type="number"
        value={value.toString()}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-10 w-full"
      />
      <p className="text-xs text-zinc-400 mt-1">{hint}</p>
    </div>
  );
}
