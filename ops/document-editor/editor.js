import MarkdownIt from 'markdown-it';
import { Schema, Slice } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema as commonmark, MarkdownParser, MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands, exitCode, toggleMark } from 'prosemirror-commands';
import { splitListItem, sinkListItem, liftListItem } from 'prosemirror-schema-list';
import { inputRules, wrappingInputRule, textblockTypeInputRule, smartQuotes, emDash, ellipsis, undoInputRule } from 'prosemirror-inputrules';
import { tableNodes, tableEditing, goToNextCell } from 'prosemirror-tables';

// HTML is always text. Pasted DOM uses the schema, never arbitrary attributes.
const safeLink = value => /^(https?:|mailto:)/i.test(value || '') || /^(\/|#)/.test(value || '') && !/^\/\//.test(value);
const safeImage = value => /^\/(?!\/)/.test(value || '');
let nodes = commonmark.spec.nodes.update('list_item', {
  ...commonmark.spec.nodes.get('list_item'),
  attrs: { checked: { default: null } },
  parseDOM: [{ tag: 'li', getAttrs: dom => ({ checked: dom.hasAttribute('data-checked') ? dom.getAttribute('data-checked') === 'true' : null }) }],
  toDOM: node => ['li', node.attrs.checked === null ? {} : { 'data-checked': String(node.attrs.checked) }, 0]
}).addBefore('hard_break', 'soft_break', {
  inline: true, group: 'inline', selectable: false,
  parseDOM: [{ tag: 'br[data-soft-break]' }], toDOM: () => ['br', { 'data-soft-break': '' }]
}).update('image', {
  ...commonmark.spec.nodes.get('image'),
  parseDOM: [{ tag: 'img[src]', getAttrs: dom => safeImage(dom.getAttribute('src')) ? { src: dom.getAttribute('src'), alt: dom.getAttribute('alt'), title: dom.getAttribute('title') } : false }],
  toDOM: node => safeImage(node.attrs.src) ? ['img', node.attrs] : ['span', { 'data-image-src': node.attrs.src }, node.attrs.alt || '图片']
}).append(tableNodes({ tableGroup: 'block', cellContent: 'paragraph+', cellAttributes: {
  align: { default: null, getFromDOM: dom => dom.getAttribute('align'), setDOMAttr: (value, attrs) => { if (value) attrs.align = value; } }
} }));
const marks = commonmark.spec.marks.update('link', {
  ...commonmark.spec.marks.get('link'),
  parseDOM: [{ tag: 'a[href]', getAttrs: dom => safeLink(dom.getAttribute('href')) ? { href: dom.getAttribute('href'), title: dom.getAttribute('title') } : false }],
  toDOM: mark => ['a', safeLink(mark.attrs.href) ? { ...mark.attrs, rel: 'noopener noreferrer' } : {}, 0]
}).addToEnd('strike', { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] });
export const schema = new Schema({ nodes, marks });

const tokenizer = new MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough']);
tokenizer.core.ruler.after('inline', 'document-structure', state => {
  const tokens = [];
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    // GFM task state belongs to its list item, never to a removable DOM checkbox.
    if (token.type === 'list_item_open') {
      const inline = state.tokens[i + 2];
      const task = state.tokens[i + 1]?.type === 'paragraph_open' && /^\[([ xX])\] /.exec(inline?.children?.[0]?.content || '');
      if (task) { token.attrSet('checked', task[1] === ' ' ? 'false' : 'true'); inline.children[0].content = inline.children[0].content.slice(task[0].length); }
    }
    if (token.type === 'th_close' || token.type === 'td_close') tokens.push(new state.Token('paragraph_close', 'p', -1));
    tokens.push(token);
    if (token.type === 'th_open' || token.type === 'td_open') tokens.push(new state.Token('paragraph_open', 'p', 1));
  }
  state.tokens = tokens;
});
export const parser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  list_item: { block: 'list_item', getAttrs: token => ({ checked: token.attrGet('checked') === null ? null : token.attrGet('checked') === 'true' }) },
  softbreak: { node: 'soft_break' }, s: { mark: 'strike' },
  table: { block: 'table' }, thead: { ignore: true }, tbody: { ignore: true }, tr: { block: 'table_row' },
  th: { block: 'table_header', getAttrs: token => ({ align: /text-align:(left|center|right)/.exec(token.attrGet('style') || '')?.[1] || null }) },
  td: { block: 'table_cell', getAttrs: token => ({ align: /text-align:(left|center|right)/.exec(token.attrGet('style') || '')?.[1] || null }) }
});
export const serializer = new MarkdownSerializer({
  ...defaultMarkdownSerializer.nodes,
  bullet_list: (state, node) => state.renderList(node, '  ', () => '- '),
  list_item(state, node) {
    if (node.attrs.checked !== null) state.write(node.attrs.checked ? '[x] ' : '[ ] ');
    state.renderContent(node);
  },
  soft_break: state => state.write('\n'),
  table(state, node) {
    const rows = [];
    node.forEach(row => {
      const cells = [];
      row.forEach(cell => cells.push(serializer.serialize(cell).replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
      rows.push(`| ${cells.join(' | ')} |`);
    });
    const aligns = [];
    node.firstChild.forEach(cell => aligns.push(cell.attrs.align === 'center' ? ':---:' : cell.attrs.align === 'right' ? '---:' : cell.attrs.align === 'left' ? ':---' : '---'));
    rows.splice(1, 0, `| ${aligns.join(' | ')} |`);
    state.write(rows.join('\n')); state.closeBlock(node);
  }
}, { ...defaultMarkdownSerializer.marks, strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true } });

// Memory records use a stricter list format: even an empty continuation line
// needs two spaces so the server can distinguish it from a record separator.
export function serializeDocument(doc, memory = false) {
  if (!memory || [...Array(doc.childCount)].some((_, i) => doc.child(i).type.name !== 'bullet_list')) return serializer.serialize(doc);
  const records = [];
  doc.forEach(list => list.forEach(item => {
    const task = item.attrs.checked === null ? '' : item.attrs.checked ? '[x] ' : '[ ] ';
    records.push(`- ${task}${serializer.serialize(item).replace(/\n/g, '\n  ')}`);
  }));
  return records.join('\n\n') + (records.length ? '\n' : '');
}

export function create({ mount, content, onChange, memory = false }) {
  let original = content, originalDoc = parser.parse(content);
  const keys = {
    'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo, Backspace: undoInputRule,
    'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em), 'Mod-`': toggleMark(schema.marks.code),
    Enter: splitListItem(schema.nodes.list_item),
    Tab: chainCommands(goToNextCell(1), sinkListItem(schema.nodes.list_item)),
    'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(schema.nodes.list_item)),
    'Shift-Enter': chainCommands(exitCode, (state, dispatch) => {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.soft_break.create()).scrollIntoView()); return true;
    })
  };
  const rules = inputRules({ rules: [
    ...smartQuotes, emDash, ellipsis,
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, match => ({ order: +match[1] }), (match, node) => node.childCount + node.attrs.order === +match[1]),
    textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, match => ({ level: match[1].length })),
    textblockTypeInputRule(/^```([\w+-]*)\s$/, schema.nodes.code_block, match => ({ params: match[1] }))
  ] });
  const plugins = [rules, keymap(keys), keymap(baseKeymap), history(), tableEditing()];
  const view = new EditorView(mount, {
    state: EditorState.create({ doc: originalDoc, plugins }),
    attributes: { class: 'document-workspace-paper message-text', role: 'textbox', tabindex: '0', 'aria-label': '文档内容', 'aria-multiline': 'true', 'data-native-selection': '', spellcheck: 'false' },
    dispatchTransaction(transaction) {
      view.updateState(view.state.apply(transaction));
      if (transaction.docChanged) onChange(view.state.doc.eq(originalDoc) ? original : serializeDocument(view.state.doc, memory));
    },
    // Paste Markdown as rendered blocks, with undo handled by the same editor.
    clipboardTextParser: text => Slice.maxOpen(parser.parse(text).content),
    handleDOMEvents: { click: (_view, event) => { if (event.target.closest('a')) { event.preventDefault(); return true; } return false; } }
  });
  return {
    setContent(value) {
      const doc = parser.parse(value); original = value; originalDoc = doc;
      if (!doc.eq(view.state.doc)) view.updateState(EditorState.create({ doc, plugins }));
    },
    setEditable: editable => view.setProps({ editable: () => editable }),
    destroy: () => view.destroy()
  };
}
