// Link mark that remembers how the link was written: Markdown [text](href),
// autolink <href> or HTML <a href>, so that it is saved in the same form.
import Link from '@tiptap/extension-link'

export const LinkWithFormat = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      /** null (Markdown), 'auto' (<href>) or 'html' (<a href="...">). */
      format: {
        default: null,
        parseHTML: el => el.getAttribute('data-link-format'),
        renderHTML: attrs => (attrs.format ? { 'data-link-format': attrs.format } : {}),
      },
      /** Original opening tag of an HTML link (other attributes kept as is). */
      html: {
        default: null,
        parseHTML: el => el.getAttribute('data-html-tag'),
        renderHTML: () => ({}),
      },
    }
  },
}).configure({ openOnClick: false, autolink: false, linkOnPaste: true, HTMLAttributes: { rel: null, target: null } })
