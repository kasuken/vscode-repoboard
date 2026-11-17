import type { Collection, Project, ProjectMeta, SortMode, ViewMode } from '../domain/model';
import type { RemoteOp } from '../services/git';

/** Project as the webview sees it. Metadata is sent separately, keyed by project id. */
export interface ProjectView extends Project {
  displayPath: string;
  isCurrent: boolean;
}

export interface BoardSettings {
  openInNewWindow: boolean;
  defaultView: ViewMode;
  defaultSort: SortMode;
  hasScanRoots: boolean;
  isMac: boolean;
}

export interface BoardState {
  projects: ProjectView[];
  collections: Collection[];
  meta: Record<string, ProjectMeta>;
  busy: string[];
  settings: BoardSettings;
  canAddCurrent: boolean;
  scanning: boolean;
  gitAvailable: boolean;
}

export type HostMessage =
  | { type: 'state'; state: BoardState }
  | { type: 'meta'; id: string; meta: ProjectMeta }
  | { type: 'busy'; id: string; busy: boolean }
  | { type: 'scanning'; scanning: boolean }
  | { type: 'edit'; id: string }
  | { type: 'focusSearch' }
  | { type: 'toast'; text: string; kind: 'info' | 'error' };

export interface ProjectEdit {
  name: string;
  description: string;
  icon: string;
  color: string;
  collectionId: string | null;
  tags: string;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'open'; id: string; newWindow: boolean }
  | { type: 'terminal'; id: string }
  | { type: 'reveal'; id: string }
  | { type: 'openRemote'; id: string }
  | { type: 'copyPath'; id: string }
  | { type: 'pin'; id: string; pinned: boolean }
  | { type: 'saveProject'; id: string; edit: ProjectEdit }
  | { type: 'removeProject'; id: string }
  | { type: 'moveProject'; id: string; collectionId: string | null; index: number }
  | { type: 'saveCollection'; id?: string; name: string; color?: string }
  | { type: 'removeCollection'; id: string }
  | { type: 'moveCollection'; id: string; index: number }
  | { type: 'collapse'; id: string; collapsed: boolean }
  | { type: 'git'; id: string; op: RemoteOp }
  | { type: 'refresh'; id?: string }
  | { type: 'addCurrent' }
  | { type: 'addFolder' }
  | { type: 'scan' }
  | { type: 'addScanRoot' }
  | { type: 'fetchAll' }
  | { type: 'pullAll' }
  | { type: 'openSettings' };
