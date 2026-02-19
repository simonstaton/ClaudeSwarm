"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SwarmTopology, TopologyNode } from "../api";
import { Header } from "../components/Header";
import { Sidebar } from "../components/Sidebar";
import { useAgentPolling } from "../hooks/useAgentPolling";
import { useApi } from "../hooks/useApi";
import { useKillSwitchContext } from "../killSwitch";

// ── Layout constants ──────────────────────────────────────────────────────────
const NODE_W = 200;
const NODE_H = 96;
const H_GAP = 60; // horizontal gap between siblings
const V_GAP = 100; // vertical gap between depth levels
const PADDING = 40;

interface LayoutNode extends TopologyNode {
  x: number;
  y: number;
}

/**
 * Computes (x, y) for each node using a top-down tree layout.
 * Nodes at the same depth are spaced evenly. Each subtree is centred
 * over its children to avoid overlaps.
 */
function computeLayout(topology: SwarmTopology): LayoutNode[] {
  const { nodes, edges } = topology;
  if (nodes.length === 0) return [];

  // Build adjacency: parent → children
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const node of nodes) children.set(node.id, []);
  for (const edge of edges) {
    children.get(edge.source)?.push(edge.target);
    hasParent.add(edge.target);
  }

  // Roots: nodes with no parent in this topology
  const roots = nodes.filter((n) => !hasParent.has(n.id));

  // Measure subtree width (in node units) recursively
  const subtreeWidth = new Map<string, number>();
  function measureWidth(id: string): number {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      subtreeWidth.set(id, NODE_W);
      return NODE_W;
    }
    const total = kids.reduce((sum, kid) => sum + measureWidth(kid) + H_GAP, -H_GAP);
    subtreeWidth.set(id, total);
    return total;
  }
  for (const root of roots) measureWidth(root.id);

  // Assign positions
  const positions = new Map<string, { x: number; y: number }>();

  function place(id: string, cx: number, depth: number) {
    const y = PADDING + depth * (NODE_H + V_GAP);
    positions.set(id, { x: cx - NODE_W / 2, y });
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return;
    const totalW = kids.reduce((s, k) => s + (subtreeWidth.get(k) ?? NODE_W) + H_GAP, -H_GAP);
    let cursor = cx - totalW / 2;
    for (const kid of kids) {
      const kw = subtreeWidth.get(kid) ?? NODE_W;
      place(kid, cursor + kw / 2, depth + 1);
      cursor += kw + H_GAP;
    }
  }

  // Lay out roots side-by-side
  const rootsTotal = roots.reduce((s, r) => s + (subtreeWidth.get(r.id) ?? NODE_W) + H_GAP, -H_GAP);
  let rootCursor = PADDING + rootsTotal / 2;
  for (const root of roots) {
    const rw = subtreeWidth.get(root.id) ?? NODE_W;
    place(root.id, rootCursor - rootsTotal / 2 + rw / 2, 0);
    rootCursor += rw + H_GAP;
  }

  // Merge positions with node data; fall back to grid for disconnected nodes
  return nodes.map((n) => {
    const pos = positions.get(n.id);
    return { ...n, x: pos?.x ?? PADDING, y: pos?.y ?? PADDING } as LayoutNode;
  });
}

// ── Status colours ────────────────────────────────────────────────────────────
function statusColor(status: TopologyNode["status"]): { fill: string; stroke: string; text: string } {
  switch (status) {
    case "running":
      return { fill: "#1a3a2a", stroke: "#22c55e", text: "#86efac" };
    case "idle":
      return { fill: "#1c2a3a", stroke: "#3b82f6", text: "#93c5fd" };
    case "starting":
      return { fill: "#2a2a1a", stroke: "#eab308", text: "#fde047" };
    case "restored":
      return { fill: "#1c2a3a", stroke: "#6366f1", text: "#a5b4fc" };
    case "error":
      return { fill: "#3a1a1a", stroke: "#ef4444", text: "#fca5a5" };
    default:
      return { fill: "#1a1a1a", stroke: "#52525b", text: "#a1a1aa" };
  }
}

// ── Edge path (cubic bezier, top→bottom) ─────────────────────────────────────
function edgePath(sx: number, sy: number, tx: number, ty: number): string {
  const midY = (sy + ty) / 2;
  return `M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`;
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function Tooltip({ node }: { node: TopologyNode }) {
  const lines: string[] = [
    node.name,
    node.role ? `role: ${node.role}` : "",
    `model: ${node.model.split("-").slice(0, 3).join("-")}`,
    `depth: ${node.depth}`,
    `tokens: ${formatTokens(node.tokensUsed)} · cost: ${formatCost(node.estimatedCost)}`,
    node.currentTask ? node.currentTask.slice(0, 36) : "",
  ].filter(Boolean);

  const tw = 220;
  const th = lines.length * 16 + 16;
  const tx = NODE_W + 10;
  const ty = 0;

  return (
    <g pointerEvents="none">
      <rect x={tx} y={ty} width={tw} height={th} rx={6} fill="#18181b" stroke="#3f3f46" strokeWidth={1} />
      {lines.map((line, i) => (
        <text
          key={line}
          x={tx + 10}
          y={ty + 14 + i * 16}
          fontSize={10}
          fill={i === 0 ? "#f4f4f5" : "#a1a1aa"}
          fontFamily="monospace"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function GraphView() {
  const api = useApi();
  const { agents } = useAgentPolling();
  const killSwitch = useKillSwitchContext();

  const [topology, setTopology] = useState<SwarmTopology | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Pan + zoom state
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const dragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.fetchTopology();
      setTopology(data);
      setError(null);
    } catch {
      setError("Failed to load topology");
    }
  }, [api]);

  // Initial load + 5s polling
  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  // Pan handlers
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as SVGElement).closest("[data-node]")) return;
    dragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));
  }, []);

  const onMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Scroll to zoom
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setScale((s) => Math.min(3, Math.max(0.2, s * factor)));
  }, []);

  const resetView = useCallback(() => {
    setOffset({ x: 0, y: 0 });
    setScale(1);
  }, []);

  if (error) {
    return (
      <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
        <Header agentCount={agents.length} killSwitch={killSwitch} />
        <div className="flex-1 flex items-center justify-center text-zinc-400">{error}</div>
      </div>
    );
  }

  const layout = topology ? computeLayout(topology) : [];
  const nodeMap = new Map(layout.map((n) => [n.id, n]));

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      <Header agentCount={agents.length} killSwitch={killSwitch} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={null} />
        <div className="flex-1 relative overflow-hidden">
          {/* Toolbar */}
          <div className="absolute top-3 right-3 z-10 flex gap-2">
            <button
              type="button"
              onClick={resetView}
              className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-zinc-300 transition-colors"
            >
              Reset view
            </button>
            <button
              type="button"
              onClick={load}
              className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-zinc-300 transition-colors"
            >
              Refresh
            </button>
          </div>

          {/* Legend */}
          <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1.5 bg-zinc-900/80 border border-zinc-800 rounded-lg p-3 text-xs text-zinc-400">
            {(["running", "idle", "starting", "restored", "error"] as const).map((s) => {
              const c = statusColor(s);
              return (
                <div key={s} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm border" style={{ background: c.fill, borderColor: c.stroke }} />
                  <span className="capitalize">{s}</span>
                </div>
              );
            })}
          </div>

          {topology && layout.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm">
              No agents running
            </div>
          )}

          {/* SVG graph */}
          <svg
            ref={svgRef}
            className="w-full h-full cursor-grab active:cursor-grabbing select-none"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onWheel={onWheel}
          >
            <title>Agent dependency graph</title>
            <g transform={`translate(${offset.x},${offset.y}) scale(${scale})`}>
              {/* Edges */}
              {topology?.edges.map((edge) => {
                const s = nodeMap.get(edge.source);
                const t = nodeMap.get(edge.target);
                if (!s || !t) return null;
                const sx = s.x + NODE_W / 2;
                const sy = s.y + NODE_H;
                const tx = t.x + NODE_W / 2;
                const ty = t.y;
                return (
                  <path
                    key={`${edge.source}-${edge.target}`}
                    d={edgePath(sx, sy, tx, ty)}
                    fill="none"
                    stroke="#3f3f46"
                    strokeWidth={1.5}
                  />
                );
              })}

              {/* Nodes */}
              {layout.map((node) => {
                const c = statusColor(node.status);
                const isHovered = hoveredId === node.id;
                const label = node.name.length > 20 ? `${node.name.slice(0, 19)}…` : node.name;
                const taskLabel = node.currentTask
                  ? node.currentTask.length > 28
                    ? `${node.currentTask.slice(0, 27)}…`
                    : node.currentTask
                  : (node.role ?? node.status);

                return (
                  // biome-ignore lint/a11y/useSemanticElements: SVG <g> cannot be replaced with HTML <button>
                  <g
                    key={node.id}
                    data-node="true"
                    role="button"
                    tabIndex={0}
                    transform={`translate(${node.x},${node.y})`}
                    style={{ cursor: "pointer" }}
                    onClick={() => (window.location.href = `/agents/${node.id}/`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        window.location.href = `/agents/${node.id}/`;
                      }
                    }}
                    onMouseEnter={() => setHoveredId(node.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    {/* Node rect */}
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={8}
                      fill={c.fill}
                      stroke={isHovered ? c.text : c.stroke}
                      strokeWidth={isHovered ? 2 : 1.5}
                    />
                    {/* Status dot */}
                    <circle cx={NODE_W - 14} cy={14} r={4} fill={c.stroke} />
                    {/* Agent name */}
                    <text x={12} y={28} fontSize={12} fontWeight={600} fill={c.text} fontFamily="monospace">
                      {label}
                    </text>
                    {/* Task / role */}
                    <text x={12} y={48} fontSize={10} fill="#71717a" fontFamily="sans-serif">
                      {taskLabel}
                    </text>
                    {/* Cost / tokens */}
                    <text x={12} y={66} fontSize={9} fill="#52525b" fontFamily="monospace">
                      {formatTokens(node.tokensUsed)} tokens
                    </text>
                    <text x={12} y={82} fontSize={9} fill="#52525b" fontFamily="monospace">
                      {formatCost(node.estimatedCost)}
                    </text>
                  </g>
                );
              })}

              {/* Tooltips layer - rendered last to appear on top */}
              {hoveredId &&
                (() => {
                  const hoveredNode = layout.find((n) => n.id === hoveredId);
                  if (!hoveredNode) return null;
                  return (
                    <g transform={`translate(${hoveredNode.x},${hoveredNode.y})`}>
                      <Tooltip node={hoveredNode} />
                    </g>
                  );
                })()}
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}
