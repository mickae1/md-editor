// Images as HTML <img src alt width height> tags, with visual resizing.
import { Node, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection } from '@tiptap/pm/state'
import type { NodeView } from '@tiptap/pm/view'
import { api } from '../api'
import { ctx, type EditorHost } from '../context'
import { dirname, join, relative } from '../paths'
import { h } from '../ui/dom'
import { imageDialog, popupMenu, toast } from '../ui/dialogs'
import { icon } from '../ui/icons'
import { t } from '../i18n'

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/gif,image/webp'

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',', 2)[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

function naturalSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url) }
    img.onerror = () => { resolve({ width: 0, height: 0 }); URL.revokeObjectURL(url) }
    img.src = url
  })
}

/** Copies an image file into images/; returns src (relative to the document) and the original size. */
export async function uploadImageFile(file: File, host: EditorHost) {
  const [{ path }, size] = await Promise.all([api.uploadImage(file.name || 'image.png', await readAsBase64(file)), naturalSize(file)])
  return {
    src: relative(dirname(host.docPath), path),
    width: size.width ? String(size.width) : null,
    height: size.height ? String(size.height) : null,
  }
}

/** Native image file picker. */
function pickImageFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept: IMAGE_ACCEPT })
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}

const KNOWN = new Set(['src', 'alt', 'width', 'height', 'title'])

class ImageView implements NodeView {
  dom: HTMLElement
  img: HTMLImageElement
  handle: HTMLElement
  sizeLabel: HTMLElement
  constructor(private node: PMNode, private editor: Editor, private getPos: () => number | undefined, private host: EditorHost) {
    this.img = h('img', { draggable: false })
    this.handle = h('span', { class: 'img-handle', title: t('image.resize') })
    this.sizeLabel = h('span', { class: 'img-size' })
    this.dom = h('span', { class: 'img-wrap' }, this.img, this.handle, this.sizeLabel)
    this.handle.addEventListener('mousedown', e => this.startResize(e))
    this.dom.addEventListener('dblclick', () => this.edit())
    this.dom.addEventListener('contextmenu', e => this.menu(e))
    this.render()
  }

  render() {
    const { src, alt, width, height, title } = this.node.attrs
    const url = ctx.imageUrl(src, this.host)
    if (this.img.getAttribute('src') !== url) this.img.src = url
    this.img.alt = alt ?? ''
    this.img.title = title ?? ''
    for (const [k, v] of [['width', width], ['height', height]] as const) {
      if (v) this.img.setAttribute(k, v)
      else this.img.removeAttribute(k)
    }
    this.img.style.width = width ? `${width}px` : ''
    this.img.style.height = 'auto'
    this.img.classList.toggle('is-svg', /\.svg(\?|$)/i.test(src))
  }

  startResize(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = this.img.getBoundingClientRect().width
    const natural = this.img.naturalWidth && this.img.naturalHeight ? this.img.naturalHeight / this.img.naturalWidth : 0
    const w0 = Number(this.node.attrs.width), h0 = Number(this.node.attrs.height)
    const ratio = w0 && h0 ? h0 / w0 : natural || 1
    const maxW = (this.dom.closest('.ProseMirror') as HTMLElement | null)?.clientWidth ?? 4000
    let newW = startW
    this.dom.classList.add('resizing')
    const move = (ev: MouseEvent) => {
      newW = Math.max(16, Math.min(maxW * 2, Math.round(startW + ev.clientX - startX)))
      this.img.style.width = `${newW}px`
      this.sizeLabel.textContent = `${newW} x ${Math.round(newW * ratio)}`
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      this.dom.classList.remove('resizing')
      this.setAttrs({ width: String(newW), height: String(Math.round(newW * ratio)) })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  async edit() {
    const a = this.node.attrs
    const result = await imageDialog({ src: a.src, alt: a.alt, width: a.width, height: a.height, title: a.title, naturalWidth: this.img.naturalWidth, naturalHeight: this.img.naturalHeight })
    if (result) this.setAttrs({ ...result })
  }

  /** Right-click menu: properties, quick sizes, replace, path. */
  menu(e: MouseEvent) {
    e.preventDefault()
    const pos = this.getPos()
    if (pos !== undefined) this.editor.view.dispatch(this.editor.state.tr.setSelection(NodeSelection.create(this.editor.state.doc, pos)))
    const { src, width, height } = this.node.attrs
    const nw = this.img.naturalWidth, nh = this.img.naturalHeight
    const pageW = (this.dom.closest('.ProseMirror') as HTMLElement | null)?.clientWidth ?? 0
    const ratio = Number(width) && Number(height) ? Number(height) / Number(width) : nw ? nh / nw : 0
    const scaled = (f: number) => nw ? { width: String(Math.round(nw * f)), height: String(Math.round(nh * f)) } : null
    const size = (label: string, attrs: { width: string; height: string } | null) => ({
      label: attrs ? `${label} (${attrs.width} x ${attrs.height})` : label,
      icon: icon('image', 14),
      disabled: !attrs || (attrs.width === width && attrs.height === height),
      action: () => attrs && this.setAttrs(attrs),
    })
    const fit = pageW && ratio && (Number(width) || nw) > pageW
      ? { width: String(pageW), height: String(Math.round(pageW * ratio)) } : null
    const docPath = this.host.docPath
    popupMenu(e.clientX, e.clientY, [
      { label: t('image.properties'), icon: icon('pencil', 14), action: () => this.edit() },
      'sep',
      size(t('image.originalSize'), scaled(1)),
      size(t('image.halfSize'), scaled(0.5)),
      ...(fit ? [size(t('image.fitWidth'), fit)] : []),
      { label: t('image.removeSize'), icon: icon('x', 14), disabled: !width && !height, action: () => this.setAttrs({ width: null, height: null }) },
      'sep',
      { label: t('image.replace'), icon: icon('folderOpen', 14), action: () => this.replace() },
      { label: t('image.open'), icon: icon('external', 14), disabled: !src, action: () => window.open(ctx.imageUrl(src, this.host), '_blank') },
      { label: t('image.copyPath'), icon: icon('clipboard', 14), disabled: !src, action: () => navigator.clipboard.writeText(/^[a-z]+:/i.test(src) ? src : join(dirname(docPath), decodeURI(src))) },
      'sep',
      { label: t('image.delete'), icon: icon('trash', 14), action: () => this.remove() },
    ])
  }

  /** Replaces the file, keeping the alt text and the displayed width. */
  async replace() {
    const file = await pickImageFile()
    if (!file) return
    try {
      const up = await uploadImageFile(file, this.host)
      const w = Number(this.node.attrs.width), nw = Number(up.width), nh = Number(up.height)
      const dims = w && nw && nh ? { width: String(w), height: String(Math.round(w * nh / nw)) } : { width: up.width, height: up.height }
      this.setAttrs({ src: up.src, ...dims })
    } catch (err) {
      toast(t('image.replaceFailed', { error: (err as Error).message }), 'error')
    }
  }

  remove() {
    const pos = this.getPos()
    if (pos === undefined) return
    this.editor.view.dispatch(this.editor.state.tr.delete(pos, pos + this.node.nodeSize))
  }

  setAttrs(attrs: Record<string, unknown>) {
    const pos = this.getPos()
    if (pos === undefined) return
    this.editor.view.dispatch(this.editor.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...attrs }))
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }
  selectNode() { this.dom.classList.add('selected') }
  deselectNode() { this.dom.classList.remove('selected') }
  stopEvent(e: Event) { return e.target === this.handle }
  ignoreMutation() { return true }
}

export function createImage(host: EditorHost) {
  return Node.create({
    name: 'image',
    group: 'inline',
    inline: true,
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        src: { default: '' },
        alt: { default: '' },
        width: { default: null },
        height: { default: null },
        title: { default: null },
        // Extra attributes (class, style...) kept as is.
        extra: {
          default: '',
          parseHTML: el => [...el.attributes].filter(a => !KNOWN.has(a.name)).map(a => `${a.name}="${a.value.replace(/"/g, '&quot;')}"`).join(' '),
          renderHTML: () => ({}),
        },
      }
    },
    parseHTML() { return [{ tag: 'img[src]' }] },
    renderHTML({ node }) {
      const { src, alt, width, height, title } = node.attrs
      return ['img', { src, alt, width, height, title }]
    },
    addNodeView() { return ({ node, editor, getPos }) => new ImageView(node, editor, getPos, host) },
  })
}
