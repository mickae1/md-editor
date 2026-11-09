import {
  createElement, type IconNode,
  Bold, Italic, Code, List, ListOrdered, Link, Anchor, Image, Table, SquareCode, Info, Pencil, ClipboardList,
  Flame, Check, CircleHelp, AlertTriangle, X, Zap, Bug, FlaskConical, Quote, Puzzle, Scissors, Undo2, Redo2,
  Pilcrow, Minus, FileCode, FolderOpen, Settings, Search, Link2Off, Play, Sun, Moon, Save, FileText, ChevronRight,
  ChevronDown, ExternalLink, Trash2, Plus, Indent, Outdent, Columns3, Rows3, PanelRight, PanelLeft, FileDiff,
  Braces, GripVertical, Folder, PanelTop, ChevronsDownUp, Unlink, ListTree, Eye, Globe,
  BookOpen, ArrowUp, ArrowDown, Copy, RefreshCw, ListX, FilePlus, FileX,
} from 'lucide'
import { t } from '../i18n'

const ICONS = {
  bold: Bold, italic: Italic, code: Code, list: List, listOrdered: ListOrdered, link: Link, unlink: Unlink,
  anchor: Anchor, image: Image, table: Table, codeBlock: SquareCode, info: Info, pencil: Pencil,
  clipboard: ClipboardList, flame: Flame, check: Check, help: CircleHelp, warning: AlertTriangle, x: X, zap: Zap,
  bug: Bug, flask: FlaskConical, quote: Quote, puzzle: Puzzle, scissors: Scissors, undo: Undo2, redo: Redo2,
  paragraph: Pilcrow, hr: Minus, raw: FileCode, folderOpen: FolderOpen, folder: Folder, settings: Settings,
  search: Search, brokenLink: Link2Off, play: Play, sun: Sun, moon: Moon, save: Save, file: FileText,
  chevronRight: ChevronRight, chevronDown: ChevronDown, external: ExternalLink, trash: Trash2, plus: Plus,
  indent: Indent, outdent: Outdent, columns: Columns3, rows: Rows3, panelRight: PanelRight, panelLeft: PanelLeft,
  diff: FileDiff, braces: Braces, grip: GripVertical, tabs: PanelTop, details: ChevronsDownUp, tree: ListTree,
  eye: Eye, globe: Globe, book: BookOpen, arrowUp: ArrowUp, arrowDown: ArrowDown, copy: Copy, refresh: RefreshCw,
  listRemove: ListX, filePlus: FilePlus, fileX: FileX,
} satisfies Record<string, IconNode>

export type IconName = keyof typeof ICONS

export function icon(name: IconName, size = 16): SVGElement {
  const el = createElement(ICONS[name])
  el.setAttribute('width', String(size))
  el.setAttribute('height', String(size))
  el.setAttribute('aria-hidden', 'true')
  el.classList.add('icon')
  return el
}

/** Material for MkDocs admonition types (with aliases). */
export const ADMONITION_TYPES: { kind: string; label: string; icon: IconName; aliases: string[] }[] = [
  { kind: 'note', label: t('icons.admonitionNote'), icon: 'pencil', aliases: ['seealso'] },
  { kind: 'abstract', label: t('icons.admonitionAbstract'), icon: 'clipboard', aliases: ['summary', 'tldr'] },
  { kind: 'info', label: t('icons.admonitionInfo'), icon: 'info', aliases: ['todo'] },
  { kind: 'tip', label: t('icons.admonitionTip'), icon: 'flame', aliases: ['hint', 'important'] },
  { kind: 'success', label: t('icons.admonitionSuccess'), icon: 'check', aliases: ['check', 'done'] },
  { kind: 'question', label: t('icons.admonitionQuestion'), icon: 'help', aliases: ['help', 'faq'] },
  { kind: 'warning', label: t('icons.admonitionWarning'), icon: 'warning', aliases: ['caution', 'attention'] },
  { kind: 'failure', label: t('icons.admonitionFailure'), icon: 'x', aliases: ['fail', 'missing'] },
  { kind: 'danger', label: t('icons.admonitionDanger'), icon: 'zap', aliases: ['error'] },
  { kind: 'bug', label: t('icons.admonitionBug'), icon: 'bug', aliases: [] },
  { kind: 'example', label: t('icons.admonitionExample'), icon: 'flask', aliases: [] },
  { kind: 'quote', label: t('icons.admonitionQuote'), icon: 'quote', aliases: ['cite'] },
]

export function admonitionType(kind: string) {
  const k = kind.toLowerCase()
  return ADMONITION_TYPES.find(a => a.kind === k || a.aliases.includes(k)) ?? ADMONITION_TYPES[0]
}
