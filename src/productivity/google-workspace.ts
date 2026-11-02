import { randomUUID } from "node:crypto";
import { pick, record } from "./http.js";

type Call = (url: string, method: "GET" | "POST" | "PUT", body?: unknown, signal?: AbortSignal) => Promise<unknown>;
type Cell = string | number | boolean;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const endpoint = (service: "docs" | "sheets" | "slides", kind: string, id: string) => `https://${service}.googleapis.com/${service === "sheets" ? "v4" : "v1"}/${kind}/${encodeURIComponent(id)}`;

function chunk(content: string, offset: number, limit: number) {
  const chars = Array.from(content);
  return { content: chars.slice(offset, offset + limit).join(""), offset, total_characters: chars.length, next_offset: offset + limit < chars.length ? offset + limit : null };
}
function documentText(value: unknown): string {
  return array(value).map(value => {
    const element = record(value);
    return array(record(element.paragraph).elements).map(value => text(record(record(value).textRun).content)).join("")
      + array(record(element.table).tableRows).map(row => array(record(row).tableCells).map(cell => documentText(record(cell).content)).join("\t")).join("\n")
      + documentText(record(element.tableOfContents).content);
  }).join("");
}
function documentTabs(doc: Record<string, unknown>) {
  const tabs: Array<{ id: string; title: string; content: string }> = [];
  const visit = (values: unknown) => { for (const value of array(values)) {
    const tab = record(value), properties = record(tab.tabProperties);
    if (typeof properties.tabId === "string") tabs.push({ id: properties.tabId, title: text(properties.title), content: documentText(record(record(tab.documentTab).body).content) });
    visit(tab.childTabs);
  } };
  visit(doc.tabs);
  if (!tabs.length && doc.body) tabs.push({ id: "", title: "", content: documentText(record(doc.body).content) });
  return tabs;
}
function selected<T extends { id: string }>(items: T[], id?: string): T {
  const item = id === undefined ? items.length === 1 ? items[0] : undefined : items.find(item => item.id === id);
  if (!item) throw new Error("Google Drive: select an explicit tab/page ID from the latest read result");
  return item;
}
function revision(source: Record<string, unknown>, expected: string) {
  if (!expected || source.revisionId !== expected) throw new Error("Google Drive: document revision changed; read it again before editing");
}
function slideText(value: unknown): string {
  return array(value).map(value => {
    const element = record(value);
    const read = (value: unknown) => array(record(value).textElements).map(element => text(record(record(element).textRun).content)).join("");
    return read(record(element.shape).text)
      + array(record(element.table).tableRows).map(row => array(record(row).tableCells).map(cell => read(record(cell).text)).join("\t")).join("\n")
      + slideText(record(element.elementGroup).children);
  }).join("\n");
}

/** Require a finite, explicitly named sheet range. Never accept whole rows/columns or inferred tabs. */
export function sheetRange(range: string) {
  const match = /^(?:'(?:[^']|'')+'|[^'!:]+)!([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/.exec(range);
  if (!match) throw new Error("Google Drive: use a bounded A1 range including the sheet name, e.g. 'Sheet 1'!A1:C10");
  const column = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const rows = Number(match[4]) - Number(match[2]) + 1, columns = column(match[3]!) - column(match[1]!) + 1;
  if (rows < 1 || columns < 1 || rows * columns > 10_000 || Number(match[4]) > 10_000_000 || column(match[3]!) > 18_278)
    throw new Error("Google Drive: range must be ordered and contain at most 10,000 cells");
  return { rows, columns };
}
function normalizedValues(values: unknown): unknown[][] {
  const rows = array(values).map(value => {
    const cells = array(value).map(cell => cell ?? "");
    while (cells.length && cells.at(-1) === "") cells.pop();
    return cells;
  });
  while (rows.length && !rows.at(-1)!.length) rows.pop();
  return rows;
}

/** Fixed, targeted editing operations; raw supplier batch requests are never model input. */
export class GoogleWorkspaceEditor {
  constructor(private readonly call: Call) {}

  private async document(id: string, signal?: AbortSignal) {
    const doc = record(await this.call(`${endpoint("docs", "documents", id)}?includeTabsContent=true`, "GET", undefined, signal));
    if (typeof doc.documentId !== "string" || !documentTabs(doc).length) throw new Error("Google Drive: invalid Google Docs response");
    return doc;
  }
  async readDocument(id: string, tabId: string | undefined, offset: number, limit: number, signal?: AbortSignal) {
    const doc = await this.document(id, signal), tabs = documentTabs(doc);
    const chosen = tabId === undefined && tabs.length > 1 ? undefined : selected(tabs, tabId);
    return { status: "read", document_id: doc.documentId, title: doc.title, revision_id: doc.revisionId,
      tabs: tabs.map(({ id, title }) => ({ id, title })), ...(chosen ? { tab_id: chosen.id, ...chunk(chosen.content, offset, limit) } : { message: "Choose tab_id to read one document tab." }),
      content_scope: "Selected tab body text, including table text; excludes headers, footers, comments, images and formatting." };
  }
  async editDocument(id: string, input: { mode: "append_text" | "replace_text"; revision_id: string; tab_id?: string; content: string; find_text?: string }, signal?: AbortSignal) {
    const doc = await this.document(id, signal);
    revision(doc, input.revision_id);
    const tab = selected(documentTabs(doc), input.tab_id);
    if (input.mode === "replace_text" && (!input.find_text || !tab.content.includes(input.find_text))) throw new Error("Google Drive: exact text was not found in this tab; no change was sent");
    const request = input.mode === "append_text"
      ? { insertText: { text: input.content, endOfSegmentLocation: { ...(tab.id ? { tabId: tab.id } : {}) } } }
      : { replaceAllText: { containsText: { text: input.find_text, matchCase: true }, replaceText: input.content, ...(tab.id ? { tabsCriteria: { tabIds: [tab.id] } } : {}) } };
    const result = record(await this.call(`${endpoint("docs", "documents", id)}:batchUpdate`, "POST", { requests: [request], writeControl: { requiredRevisionId: input.revision_id } }, signal));
    return { status: "updated", document_id: id, tab_id: tab.id, revision_id: record(result.writeControl).requiredRevisionId,
      occurrences_changed: input.mode === "replace_text" ? record(record(array(result.replies)[0]).replaceAllText).occurrencesChanged : undefined };
  }

  async readSpreadsheet(id: string, signal?: AbortSignal) {
    const result = record(await this.call(`${endpoint("sheets", "spreadsheets", id)}?fields=spreadsheetId,properties(title),sheets(properties(sheetId,title,gridProperties))`, "GET", undefined, signal));
    if (typeof result.spreadsheetId !== "string" || !Array.isArray(result.sheets)) throw new Error("Google Drive: invalid Google Sheets response");
    return { status: "read", spreadsheet_id: result.spreadsheetId, title: record(result.properties).title,
      sheets: result.sheets.map(value => pick(record(value).properties, ["sheetId", "title", "gridProperties"])) };
  }
  async readSheet(id: string, range: string, signal?: AbortSignal) {
    sheetRange(range);
    const result = record(await this.call(`${endpoint("sheets", "spreadsheets", id)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMULA&dateTimeRenderOption=SERIAL_NUMBER`, "GET", undefined, signal));
    if (typeof result.range !== "string") throw new Error("Google Drive: invalid Google Sheets values response");
    return { status: "read", range: result.range, values: array(result.values), value_render_option: "FORMULA" };
  }
  async updateSheet(id: string, range: string, values: Cell[][], expected: Cell[][], interpretation: "RAW" | "USER_ENTERED", signal?: AbortSignal) {
    const size = sheetRange(range);
    if (values.length > size.rows || values.some(row => row.length > size.columns) || expected.length > size.rows || expected.some(row => row.length > size.columns))
      throw new Error("Google Drive: values exceed the explicitly selected range");
    const current = await this.readSheet(id, range, signal);
    if (JSON.stringify(normalizedValues(current.values)) !== JSON.stringify(normalizedValues(expected))) throw new Error("Google Drive: spreadsheet cells changed; read the range again before editing");
    const result = await this.call(`${endpoint("sheets", "spreadsheets", id)}/values/${encodeURIComponent(range)}?valueInputOption=${interpretation}`, "PUT", { range, majorDimension: "ROWS", values }, signal);
    return { status: "updated", ...pick(result, ["spreadsheetId", "updatedRange", "updatedRows", "updatedColumns", "updatedCells"]),
      concurrency: "Cells checked immediately before update; Sheets values API does not provide an atomic comparison." };
  }

  private async presentation(id: string, signal?: AbortSignal) {
    const result = record(await this.call(endpoint("slides", "presentations", id), "GET", undefined, signal));
    if (typeof result.presentationId !== "string" || result.slides !== undefined && !Array.isArray(result.slides)) throw new Error("Google Drive: invalid Google Slides response");
    return result;
  }
  async readPresentation(id: string, pageId: string | undefined, offset: number, limit: number, signal?: AbortSignal) {
    const result = await this.presentation(id, signal), slides = array(result.slides).map(record);
    const chosen = pageId === undefined && slides.length !== 1 ? undefined : selected(slides.map(slide => ({ id: text(slide.objectId), slide })), pageId);
    return { status: "read", presentation_id: id, title: result.title, revision_id: result.revisionId,
      pages: slides.map((slide, index) => ({ id: slide.objectId, number: index + 1 })),
      ...(chosen ? { page_id: chosen.id, ...chunk(slideText(chosen.slide.pageElements), offset, limit) } : { message: "Choose page_id to read one slide." }),
      content_scope: "Selected slide shape/table text; excludes images, charts, speaker notes and formatting." };
  }
  async editPresentation(id: string, input: { mode: "replace_text" | "append_slide"; revision_id: string; page_id?: string; content: string; find_text?: string }, signal?: AbortSignal) {
    const presentation = await this.presentation(id, signal);
    revision(presentation, input.revision_id);
    let requests: unknown[], pageId: string;
    if (input.mode === "replace_text") {
      const page = selected(array(presentation.slides).map(value => ({ id: text(record(value).objectId), value: record(value) })), input.page_id);
      if (!input.find_text || !slideText(page.value.pageElements).includes(input.find_text)) throw new Error("Google Drive: exact text was not found on this slide; no change was sent");
      pageId = page.id;
      requests = [{ replaceAllText: { containsText: { text: input.find_text, matchCase: true }, replaceText: input.content, pageObjectIds: [page.id] } }];
    } else {
      pageId = `zigent_slide_${randomUUID().replaceAll("-", "")}`;
      const shapeId = `zigent_text_${randomUUID().replaceAll("-", "")}`;
      requests = [{ createSlide: { objectId: pageId, slideLayoutReference: { predefinedLayout: "BLANK" } } },
        { createShape: { objectId: shapeId, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: pageId,
          size: { width: { magnitude: 620, unit: "PT" }, height: { magnitude: 300, unit: "PT" } },
          transform: { scaleX: 1, scaleY: 1, translateX: 40, translateY: 40, unit: "PT" } } } },
        { insertText: { objectId: shapeId, insertionIndex: 0, text: input.content } }];
    }
    const result = record(await this.call(`${endpoint("slides", "presentations", id)}:batchUpdate`, "POST", { requests, writeControl: { requiredRevisionId: input.revision_id } }, signal));
    return { status: "updated", presentation_id: id, page_id: pageId, revision_id: record(result.writeControl).requiredRevisionId,
      occurrences_changed: input.mode === "replace_text" ? record(record(array(result.replies)[0]).replaceAllText).occurrencesChanged : undefined };
  }
}
