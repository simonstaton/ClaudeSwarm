"use client";

interface TreeNode<T = undefined> {
  name: string;
  fullPath: string;
  isFolder: boolean;
  children: TreeNode<T>[];
  data?: T;
}

export function buildTree<T>(items: Array<{ key: string; data?: T }>): TreeNode<T>[] {
  const root: TreeNode<T>[] = [];

  for (const item of items) {
    const parts = item.key.split("/");
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      let existing = currentLevel.find((n) => n.name === part && n.isFolder === !isLast);
      if (!existing) {
        existing = {
          name: part,
          fullPath: isLast ? item.key : parts.slice(0, i + 1).join("/"),
          isFolder: !isLast,
          children: [],
          data: isLast ? item.data : undefined,
        };
        currentLevel.push(existing);
      }
      if (!isLast) {
        currentLevel = existing.children;
      }
    }
  }

  const sortNodes = (nodes: TreeNode<T>[]) => {
    nodes.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.isFolder) sortNodes(node.children);
    }
  };
  sortNodes(root);

  return root;
}

export function allFolderPaths(keys: string[]): Set<string> {
  const folders = new Set<string>();
  for (const key of keys) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      folders.add(parts.slice(0, i).join("/"));
    }
  }
  return folders;
}

export function TreeList<T>({
  nodes,
  depth,
  selectedKey,
  expandedFolders,
  folderKeyPrefix,
  onToggleFolder,
  onSelectNode,
  renderActions,
}: {
  nodes: TreeNode<T>[];
  depth: number;
  selectedKey: string | null;
  expandedFolders: Set<string>;
  folderKeyPrefix?: string;
  onToggleFolder: (key: string) => void;
  onSelectNode: (node: TreeNode<T>) => void;
  renderActions?: (node: TreeNode<T>) => React.ReactNode;
}) {
  return (
    <>
      {nodes.map((node) => {
        const folderKey = folderKeyPrefix ? `${folderKeyPrefix}:${node.fullPath}` : node.fullPath;

        if (node.isFolder) {
          return (
            <div key={folderKey}>
              <button
                type="button"
                className="flex items-center w-full px-2 py-1.5 rounded text-sm text-zinc-400 hover:bg-zinc-800/50 cursor-pointer"
                style={{ paddingLeft: `${8 + depth * 12}px` }}
                onClick={() => onToggleFolder(folderKey)}
              >
                <span className="text-[10px] mr-1.5 w-3 inline-block">
                  {expandedFolders.has(folderKey) ? "\u25BC" : "\u25B6"}
                </span>
                <span className="truncate">{node.name}/</span>
              </button>
              {expandedFolders.has(folderKey) && (
                <TreeList
                  nodes={node.children}
                  depth={depth + 1}
                  selectedKey={selectedKey}
                  expandedFolders={expandedFolders}
                  folderKeyPrefix={folderKeyPrefix}
                  onToggleFolder={onToggleFolder}
                  onSelectNode={onSelectNode}
                  renderActions={renderActions}
                />
              )}
            </div>
          );
        }

        return (
          <button
            type="button"
            key={node.fullPath}
            className={`flex items-center justify-between w-full px-2 py-1.5 rounded text-sm cursor-pointer transition-colors group ${
              selectedKey === node.fullPath ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/50"
            }`}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            onClick={() => onSelectNode(node)}
          >
            <span className="truncate">{node.name}</span>
            {renderActions?.(node)}
          </button>
        );
      })}
    </>
  );
}
