"use client";

import { Badge } from "@fanvue/ui";
import type { BadgeVariant } from "@fanvue/ui";
import type { RiskLevel } from "../api";

const RISK_VARIANT: Record<RiskLevel, BadgeVariant> = {
  low: "success",
  medium: "warning",
  high: "error",
};

const RISK_LABEL: Record<RiskLevel, string> = {
  low: "Low Risk",
  medium: "Medium Risk",
  high: "High Risk",
};

interface RiskBadgeProps {
  risk: RiskLevel;
  className?: string;
}

export function RiskBadge({ risk, className }: RiskBadgeProps) {
  return (
    <Badge variant={RISK_VARIANT[risk]} className={className}>
      {RISK_LABEL[risk]}
    </Badge>
  );
}
