import * as vscode from 'vscode';
import type { Store } from '../store/store';
import type { ConceptKind, RepoMap } from '../store/types';

type Node =
  | { type: 'root'; id: 'stale' | 'overview' | 'areas' | 'flows' | 'concepts' | 'glossary' | 'conventions' }
  | { type: 'kind'; kind: ConceptKind }
  | { type: 'item'; item: vscode.TreeItem };

const KIND_LABEL: Record<ConceptKind, string> = {
  architecture: 'Architecture',
  pattern: 'Patterns',
  library: 'Libraries',
  language: 'Language features',
  domain: 'Domain',
  tooling: 'Tooling',
};

/** The codelearn sidebar: the repo's areas, flows, concepts, business terms and conventions. */
export class MapTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private changedFiles = new Set<string>();

  constructor(private readonly store: Store) {
    store.onDidChange(() => this.changed.fire());
  }

  /** Files that differ from the map, from the check on startup (no AI involved). */
  setChanged(files: Set<string>): void {
    this.changedFiles = new Set(files);
    this.changed.fire();
  }

  /** Remembers edits since the map was built, to suggest an update. */
  noteChanged(file: string): void {
    const before = this.changedFiles.size;
    this.changedFiles.add(file);
    if (before === 0) this.changed.fire();
  }

  get changedCount(): number {
    return this.changedFiles.size;
  }

  private builtFrom: RepoMap['builtFrom'];

  /** " from main @ a1b2c3d", or "" when the map doesn't know. */
  private builtFromText(): string {
    const b = this.builtFrom;
    if (!b?.branch && !b?.commit) return '';
    return ` from ${[b.branch, b.commit?.slice(0, 7)].filter(Boolean).join(' @ ')}`;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.type === 'item') return n.item;
    if (n.type === 'kind') return collapsed(KIND_LABEL[n.kind]);
    switch (n.id) {
      case 'stale': {
        const count = this.changedFiles.size;
        const item = new vscode.TreeItem(`${count} ${count === 1 ? 'file' : 'files'} changed: update the map`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.yellow'));
        item.command = { command: 'codelearn.updateMap', title: 'Update map' };
        item.tooltip = new vscode.MarkdownString(
          `${count} files differ from when the map was built${this.builtFromText()}.\n\n` +
            'Click to update: codelearn shows how many AI requests it will make before sending anything.',
        );
        return item;
      }
      case 'overview': {
        const item = new vscode.TreeItem('Overview', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('home');
        item.command = { command: 'codelearn.openMapItem', title: 'Open', arguments: ['overview', ''] };
        item.description = this.builtFromText().replace(/^ from /, '');
        return item;
      }
      case 'areas':
        return collapsed('Areas', 'folder-library');
      case 'flows':
        return collapsed('Flows', 'debug-alt', vscode.TreeItemCollapsibleState.Expanded);
      case 'concepts':
        return collapsed('Concepts', 'mortar-board');
      case 'glossary':
        return collapsed('Business terms', 'book');
      case 'conventions':
        return collapsed('Conventions', 'law');
    }
  }

  async getChildren(n?: Node): Promise<Node[]> {
    const map = await this.store.getMap();
    this.builtFrom = map?.builtFrom;
    if (!map) return [];
    if (!n) {
      const roots: Node[] = [
        ...(this.changedFiles.size ? [{ type: 'root', id: 'stale' } as const] : []),
        { type: 'root', id: 'overview' },
        { type: 'root', id: 'flows' },
        { type: 'root', id: 'areas' },
        { type: 'root', id: 'concepts' },
      ];
      if (map.glossary.length) roots.push({ type: 'root', id: 'glossary' });
      if (map.conventions.length) roots.push({ type: 'root', id: 'conventions' });
      return roots;
    }
    if (n.type === 'root') return this.rootChildren(map, n.id);
    if (n.type === 'kind') {
      return map.concepts
        .filter((c) => c.kind === n.kind)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => {
          const status = this.store.getStatus(c.name);
          const item = new vscode.TreeItem(c.name);
          item.description = status === 'known' ? 'known' : status === 'learning' ? 'learning' : '';
          item.tooltip = c.summary;
          item.iconPath = new vscode.ThemeIcon(status === 'known' ? 'pass-filled' : status === 'learning' ? 'circle-large-filled' : 'circle-large-outline');
          item.command = { command: 'codelearn.openLesson', title: 'Open lesson', arguments: [c.id] };
          return { type: 'item', item };
        });
    }
    return [];
  }

  private rootChildren(map: RepoMap, id: string): Node[] {
    const item = (label: string, args: [string, string], icon: string, tooltip?: string, contextValue?: string): Node => {
      const t = new vscode.TreeItem(label);
      t.iconPath = new vscode.ThemeIcon(icon);
      t.tooltip = tooltip;
      t.contextValue = contextValue;
      t.command = { command: 'codelearn.openMapItem', title: 'Open', arguments: args };
      return { type: 'item', item: t };
    };
    switch (id) {
      case 'areas':
        return map.areas.map((a) => item(a.name, ['area', a.id], 'folder', a.summary));
      case 'flows':
        return map.flows.map((f) => {
          const node = item(f.name, ['flow', f.id], 'arrow-right', f.summary, 'flow');
          (node as { item: vscode.TreeItem }).item.id = `flow:${f.id}`;
          return node;
        });
      case 'concepts': {
        const kinds = [...new Set(map.concepts.map((c) => c.kind))];
        const order = Object.keys(KIND_LABEL) as ConceptKind[];
        return kinds.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((kind) => ({ type: 'kind', kind }));
      }
      case 'glossary':
        return map.glossary.map((g) => item(g.term, ['term', g.term], 'symbol-key', g.meaning));
      case 'conventions':
        return map.conventions.map((c, i) =>
          item(c.rule, ['convention', String(i)], c.status === 'confirmed' ? 'pass' : c.status === 'contradicted' ? 'warning' : 'question', `From ${c.source}`),
        );
    }
    return [];
  }
}

function collapsed(label: string, icon?: string, state = vscode.TreeItemCollapsibleState.Collapsed): vscode.TreeItem {
  const item = new vscode.TreeItem(label, state);
  if (icon) item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}
