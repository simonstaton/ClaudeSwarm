"use client";

import { Badge } from "@/components/ui/badge";
import type { RiskLevel } from "../api";
import type { BadgeVariant } from "../constants";

const RISK_VARIANT: Record<RiskLevel, BadgeVariant> = {
  low: "success",
  medium: "warning",
  high: "destructive",
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
