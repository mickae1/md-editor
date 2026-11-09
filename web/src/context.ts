// Services shared between the UI and the editor extensions.
// Filled in at startup by main.ts (avoids circular dependencies).
import type { Editor } from '@tiptap/core'
import type { SnippetStore } from './snippets/store'

export interface ProjectFile { path: string; kind: 'topic' | 'snippet'; mtime: number }

export interface ProjectInfo {
  root: string
  name: string
  mkdocs: string | null
  snippetDir: string
  snippetDirAbs: string
  basePath: string
  basePathAbs: string
  detectedBasePath: string | null
  files: ProjectFile[]
  images: string[]
  usage: Record<string, string[]>
  broken: { file: string; line: number; target: string; type: 'link' | 'snippet' }[]
  themeCss: string[]
  /** Material color scheme names from mkdocs.yml (theme.palette), used by the project CSS. */
  colorSchemes: { dark: string; light: string }
  /** .md files linked/included by no file (topics: also absent from the table of contents). */
  orphans: { file: string; type: 'topic' | 'snippet' }[]
  /** Table of contents (Maps/table_of_contents.xml), relative to the root; null if none. */
  tocFile: string | null
  tocFileAbs: string | null
}

export interface TocNode {
  /** Index path among node children ("0", "0.2.1"); changes after every edit. */
  id: string
  tag: 'topicref' | 'topichead'
  caption: string
  /** Topic ID (file name without .md), or null for a section without page. */
  href: string | null
  /** .md path relative to the root, or null. */
  file: string | null
  exists: boolean
  attrs: Record<string, string>
  children: TocNode[]
}

export interface TocState {
  /** null when the folder has no table of contents. */
  path: string | null
  abs: string | null
  mtime: number | null
  tree: TocNode[]
  /** Topics (relative .md paths) that are not in the table of contents. */
  orphans: string[]
  /** Number of nodes whose file does not exist. */
  broken: number
}

export type TocPosition = 'before' | 'after' | 'inside'

/** One edit of the table of contents (POST /api/toc/edit). Ids come from the last TocState. */
export type TocEdit =
  | { op: 'move'; id: string; target: string; position: TocPosition }
  | { op: 'rename'; id: string; caption: string }
  | { op: 'add'; target: string | null; position: TocPosition; caption: string; href: string; create: boolean }
  | { op: 'duplicate'; id: string; caption: string; href: string }
  | { op: 'remove' | 'delete'; id: string; keepChildren: boolean }

export interface EditorHost {
  /** Path of the file that relative paths (images, links) are based on. */
  docPath: string
  /** Chain of enclosing snippets (circular inclusion detection). */
  ancestors: string[]
}

interface Ctx {
  project: ProjectInfo | null
  snippets: SnippetStore
  activeEditor: Editor | null
  openFile: (path: string, anchor?: string) => void
  setActiveEditor: (editor: Editor) => void
  onEditorChange: () => void
  imageUrl: (src: string, host: EditorHost) => string
  /** Project path of a file included via --8<-- "src". */
  includePath: (src: string) => string
  /** Value to write in --8<-- "..." for a project path. */
  includeSrc: (path: string) => string
  fileExists: (path: string) => boolean
  usageOf: (path: string) => string[]
  /** Shows the topics that use a snippet. */
  editSnippetLabel?: (path: string) => void
  reloadProject?: () => Promise<void>
  setProject?: (info: ProjectInfo | null, keepTabs?: boolean) => Promise<void>
}

export const ctx = {} as Ctx
