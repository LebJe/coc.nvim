'use strict'
import { CompletionItem, CompletionItemKind, CompletionItemLabelDetails, CompletionItemTag, InsertReplaceEdit, InsertTextFormat, Range } from 'vscode-languageserver-types'
import { InsertChange } from '../events'
import Document from '../model/document'
import { SnippetParser } from '../snippets/parser'
import sources from './sources'
import { CompleteDoneItem, CompleteOption, DurationCompleteItem, ExtendedCompleteItem, ISource, ItemDefaults } from './types'
import { isFalsyOrEmpty, toArray } from '../util/array'
import { CharCode } from '../util/charCode'
import * as Is from '../util/is'
import { LRUCache } from '../util/map'
import { unidecode } from '../util/node'
import { toObject } from '../util/object'
import { byteIndex, byteSlice, toText } from '../util/string'

type MruItem = Pick<Readonly<DurationCompleteItem>, 'kind' | 'filterText' | 'source'>
type PartialOption = Pick<CompleteOption, 'col' | 'colnr' | 'line' | 'position'>
export type OptionForWord = Pick<Readonly<CompleteOption>, 'line' | 'position'>

export enum Selection {
  First = 'first',
  RecentlyUsed = 'recentlyUsed',
  RecentlyUsedByPrefix = 'recentlyUsedByPrefix'
}

const INVALID_WORD_CHARS = [CharCode.LineFeed, CharCode.CarriageReturn]
const DollarSign = '$'
const QuestionMark = '?'
const MAX_CODE_POINT = 1114111
const MAX_MRU_ITEMS = 100
const DEFAULT_HL_GROUP = 'CocSymbolDefault'

export interface ConvertOption {
  readonly source: string
  readonly priority: number
  readonly range: Range
  readonly itemDefaults?: ItemDefaults
  readonly asciiMatch?: boolean
}

const highlightsMap = {
  [CompletionItemKind.Text]: 'CocSymbolText',
  [CompletionItemKind.Method]: 'CocSymbolMethod',
  [CompletionItemKind.Function]: 'CocSymbolFunction',
  [CompletionItemKind.Constructor]: 'CocSymbolConstructor',
  [CompletionItemKind.Field]: 'CocSymbolField',
  [CompletionItemKind.Variable]: 'CocSymbolVariable',
  [CompletionItemKind.Class]: 'CocSymbolClass',
  [CompletionItemKind.Interface]: 'CocSymbolInterface',
  [CompletionItemKind.Module]: 'CocSymbolModule',
  [CompletionItemKind.Property]: 'CocSymbolProperty',
  [CompletionItemKind.Unit]: 'CocSymbolUnit',
  [CompletionItemKind.Value]: 'CocSymbolValue',
  [CompletionItemKind.Enum]: 'CocSymbolEnum',
  [CompletionItemKind.Keyword]: 'CocSymbolKeyword',
  [CompletionItemKind.Snippet]: 'CocSymbolSnippet',
  [CompletionItemKind.Color]: 'CocSymbolColor',
  [CompletionItemKind.File]: 'CocSymbolFile',
  [CompletionItemKind.Reference]: 'CocSymbolReference',
  [CompletionItemKind.Folder]: 'CocSymbolFolder',
  [CompletionItemKind.EnumMember]: 'CocSymbolEnumMember',
  [CompletionItemKind.Constant]: 'CocSymbolConstant',
  [CompletionItemKind.Struct]: 'CocSymbolStruct',
  [CompletionItemKind.Event]: 'CocSymbolEvent',
  [CompletionItemKind.Operator]: 'CocSymbolOperator',
  [CompletionItemKind.TypeParameter]: 'CocSymbolTypeParameter',
}

export function getKindText(kind: string | CompletionItemKind, kindMap: Map<CompletionItemKind, string>, defaultKindText: string): string {
  return Is.number(kind) ? kindMap.get(kind) ?? defaultKindText : kind
}

export function getKindHighlight(kind: string | number): string {
  return Is.number(kind) ? highlightsMap[kind] ?? DEFAULT_HL_GROUP : DEFAULT_HL_GROUP
}

export function getResumeInput(option: PartialOption, pretext: string): string {
  const { line, position } = option
  const cursor = position.character
  const pl = pretext.length
  if (pl < cursor) return null
  for (let i = 0; i < pl; i++) {
    if (i < cursor) {
      // should not change content before cursor.
      if (pretext.charCodeAt(i) !== line.charCodeAt(i)) {
        return null
      }
      // should not have white space.
    } else if (pretext.charCodeAt(i) === CharCode.Space) {
      return null
    }
  }
  return byteSlice(pretext, option.col)
}

export function checkIgnoreRegexps(ignoreRegexps: ReadonlyArray<string>, input: string): boolean {
  if (!ignoreRegexps || ignoreRegexps.length == 0 || input.length == 0) return false
  return ignoreRegexps.some(regexp => {
    try {
      return new RegExp(regexp).test(input)
    } catch (e) {
      return false
    }
  })
}

export function createKindMap(labels: { [key: string]: string }): Map<CompletionItemKind, string> {
  return new Map([
    [CompletionItemKind.Text, labels['text'] ?? 'v'],
    [CompletionItemKind.Method, labels['method'] ?? 'f'],
    [CompletionItemKind.Function, labels['function'] ?? 'f'],
    [CompletionItemKind.Constructor, typeof labels['constructor'] == 'function' ? 'f' : labels['con' + 'structor'] ?? ''],
    [CompletionItemKind.Field, labels['field'] ?? 'm'],
    [CompletionItemKind.Variable, labels['variable'] ?? 'v'],
    [CompletionItemKind.Class, labels['class'] ?? 'C'],
    [CompletionItemKind.Interface, labels['interface'] ?? 'I'],
    [CompletionItemKind.Module, labels['module'] ?? 'M'],
    [CompletionItemKind.Property, labels['property'] ?? 'm'],
    [CompletionItemKind.Unit, labels['unit'] ?? 'U'],
    [CompletionItemKind.Value, labels['value'] ?? 'v'],
    [CompletionItemKind.Enum, labels['enum'] ?? 'E'],
    [CompletionItemKind.Keyword, labels['keyword'] ?? 'k'],
    [CompletionItemKind.Snippet, labels['snippet'] ?? 'S'],
    [CompletionItemKind.Color, labels['color'] ?? 'v'],
    [CompletionItemKind.File, labels['file'] ?? 'F'],
    [CompletionItemKind.Reference, labels['reference'] ?? 'r'],
    [CompletionItemKind.Folder, labels['folder'] ?? 'F'],
    [CompletionItemKind.EnumMember, labels['enumMember'] ?? 'm'],
    [CompletionItemKind.Constant, labels['constant'] ?? 'v'],
    [CompletionItemKind.Struct, labels['struct'] ?? 'S'],
    [CompletionItemKind.Event, labels['event'] ?? 'E'],
    [CompletionItemKind.Operator, labels['operator'] ?? 'O'],
    [CompletionItemKind.TypeParameter, labels['typeParameter'] ?? 'T'],
  ])
}

export function indentChanged(event: { word: string } | undefined, cursor: [number, number, string], line: string): boolean {
  if (!event) return false
  let pre = byteSlice(cursor[2], 0, cursor[1] - 1)
  if (pre.endsWith(event.word) && pre.match(/^\s*/)[0] != line.match(/^\s*/)[0]) {
    return true
  }
  return false
}

export function toCompleteDoneItem(item: DurationCompleteItem | undefined): CompleteDoneItem | {} {
  if (!item) return {}
  return {
    word: item.word,
    abbr: item.abbr,
    kind: item.kind,
    source: item.source,
    isSnippet: item.isSnippet === true,
    menu: item.menu ?? `[${item.source}]`,
    user_data: Is.string(item.user_data) ? item.user_data : `${item.source}:${item.index}`
  }
}

export function shouldStop(bufnr: number, pretext: string, info: InsertChange, option: Pick<CompleteOption, 'bufnr' | 'linenr' | 'line' | 'colnr'>): boolean {
  let { pre } = info
  if (pre.length === 0 || pre[pre.length - 1] === ' ' || pre.length < pretext.length) return true
  if (option.bufnr != bufnr) return true
  let text = byteSlice(option.line, 0, option.colnr - 1)
  if (option.linenr != info.lnum || !pre.startsWith(text)) return true
  return false
}

export function getInput(document: Document, pre: string, asciiCharactersOnly: boolean): string {
  let len = 0
  for (let i = pre.length - 1; i >= 0; i--) {
    let ch = pre[i]
    let word = document.isWord(ch) && (asciiCharactersOnly ? ch.charCodeAt(0) < 255 : true)
    if (word) {
      len += 1
    } else {
      break
    }
  }
  return len == 0 ? '' : pre.slice(-len)
}

export function getSources(option: CompleteOption): ISource[] {
  let { source } = option
  if (source) return toArray(sources.getSource(source))
  return sources.getCompleteSources(option)
}

export function shouldIndent(indentkeys: string, pretext: string): boolean {
  if (!indentkeys || pretext.trim().includes(' ')) return false
  for (let part of indentkeys.split(',')) {
    if (part.indexOf('=') > -1) {
      let [pre, post] = part.split('=')
      let word = post.startsWith('~') ? post.slice(1) : post
      if (pretext.length < word.length ||
        (pretext.length > word.length && !/^\s/.test(pretext.slice(-word.length - 1)))) {
        continue
      }
      let matched = post.startsWith('~') ? pretext.toLowerCase().endsWith(word) : pretext.endsWith(word)
      if (!matched) {
        continue
      }
      if (pre == '') return true
      if (pre == '0' && /^\s*$/.test(pretext.slice(0, pretext.length - word.length))) {
        return true
      }
    }
  }
  return false
}

export function highlightOffert<T extends { filterText: string, abbr: string }>(pre: number, item: T): number {
  let { filterText, abbr } = item
  let idx = abbr.indexOf(filterText)
  if (idx == -1) return -1
  let n = idx == 0 ? 0 : byteIndex(abbr, idx)
  return pre + n
}

export function emptLabelDetails(labelDetails: CompletionItemLabelDetails): boolean {
  if (!labelDetails) return true
  return !labelDetails.detail && !labelDetails.description
}

export function isSnippetItem(item: CompletionItem, itemDefaults: ItemDefaults): boolean {
  let insertTextFormat = item.insertTextFormat ?? itemDefaults.insertTextFormat
  return insertTextFormat === InsertTextFormat.Snippet
}

/**
 * Snippet or have additionalTextEdits
 */
export function hasAction(item: CompletionItem, itemDefaults: ItemDefaults) {
  return isSnippetItem(item, itemDefaults) || !isFalsyOrEmpty(item.additionalTextEdits)
}

function toValidWord(snippet: string, excludes: number[]): string {
  for (let i = 0; i < snippet.length; i++) {
    let code = snippet.charCodeAt(i)
    if (excludes.includes(code)) {
      return snippet.slice(0, i)
    }
  }
  return snippet
}

function snippetToWord(text: string, kind: CompletionItemKind | undefined): string {
  if (kind === CompletionItemKind.Function || kind === CompletionItemKind.Method) {
    text = text.replace(/\(.+/, '')
  }
  if (!text.includes(DollarSign)) return text
  return toValidWord((new SnippetParser()).text(text), INVALID_WORD_CHARS)
}

/**
 * Get the word to insert, it's the word to insert from range or input start position,
 * may not the actual word to insert
 */
export function getWord(item: CompletionItem, itemDefaults: ItemDefaults): string {
  let { label, data, kind } = item
  if (data && Is.string(data.word)) return data.word
  let textToInsert = item.textEdit ? item.textEdit.newText : item.insertText
  if (!Is.string(textToInsert)) return label
  return isSnippetItem(item, itemDefaults) ? snippetToWord(textToInsert, kind) : toValidWord(textToInsert, INVALID_WORD_CHARS)
}

export function getReplaceRange(item: CompletionItem, itemDefaults: ItemDefaults, character?: number): Range | undefined {
  let range: Range | undefined
  if (item.textEdit) {
    range = InsertReplaceEdit.is(item.textEdit) ? item.textEdit.replace : item.textEdit.range
  } else if (itemDefaults.editRange) {
    range = Range.is(itemDefaults.editRange) ? itemDefaults.editRange : itemDefaults.editRange.replace
  }
  // start character must contains character for completion
  if (range && Is.number(character) && range.start.character > character) range.start.character = character
  return range
}

export class Converter {
  // cache the sliced text
  private previousCache: Map<number, string> = new Map()
  private postCache: Map<number, string> = new Map()
  // cursor position
  private character: number
  public minCharacter = Number.MAX_SAFE_INTEGER
  private inputLen: number
  constructor(
    // input start character index
    private readonly inputStart: number,
    private readonly option: ConvertOption,
    private readonly opt: OptionForWord
  ) {
    this.character = opt.position.character
    this.inputLen = opt.position.character - inputStart
  }

  /**
   * Text before input to replace
   */
  public getPrevious(character: number): string {
    if (this.previousCache.has(character)) return this.previousCache.get(character)
    let prev = this.opt.line.slice(character, this.inputStart)
    this.previousCache.set(character, prev)
    return prev
  }

  /**
   * Text after cursor to replace
   */
  public getAfter(character: number): string {
    if (this.postCache.has(character)) return this.postCache.get(character)
    let text = this.opt.line.slice(this.character, character)
    this.postCache.set(character, text)
    return text
  }

  /**
   * Exclude follow characters to replace from end of word
   */
  public fixFollow(word: string, isSnippet: boolean, endCharacter: number): string {
    if (isSnippet || endCharacter <= this.character) return word
    let toReplace = this.getAfter(endCharacter)
    if (word.length - this.inputLen > toReplace.length && word.endsWith(toReplace)) {
      return word.slice(0, - toReplace.length)
    }
    return word
  }

  /**
   * Better filter text with prefix before input removed if exists.
   */
  private getDelta(filterText: string, character: number): number {
    if (character < this.inputStart) {
      let prev = this.getPrevious(character)
      if (filterText.startsWith(prev)) return prev.length
    }
    return 0
  }

  public convertToDurationItem(item: ExtendedCompleteItem | CompletionItem, index: number): DurationCompleteItem {
    if (Is.isCompletionItem(item)) {
      return this.convertLspCompleteItem(item, index)
    }
    return this.convertVimCompleteItem(item, index)
  }

  private convertVimCompleteItem(item: ExtendedCompleteItem, index: number): DurationCompleteItem {
    const { option } = this
    const { range, asciiMatch, source, priority } = option
    const word = toText(item.word)
    const character = range.start.character
    this.minCharacter = Math.min(this.minCharacter, character)
    let filterText = item.filterText ?? word
    filterText = asciiMatch ? unidecode(filterText) : filterText, character
    const delta = this.getDelta(filterText, character)
    return {
      word: this.fixFollow(word, item.isSnippet, range.end.character),
      abbr: item.abbr ?? word,
      filterText,
      delta,
      character,
      source,
      priority,
      index,
      dup: item.dup === 1,
      menu: item.menu,
      kind: item.kind,
      info: item.info,
      isSnippet: !!item.isSnippet,
      insertText: item.insertText,
      preselect: item.preselect,
      sortText: item.sortText,
      documentation: item.documentation,
      deprecated: item.deprecated,
      detail: item.detail,
      labelDetails: item.labelDetails,
      user_data: item.user_data
    }
  }

  private convertLspCompleteItem(item: CompletionItem, index: number): DurationCompleteItem {
    const { option, inputStart } = this
    const { source, priority } = option
    const label = item.label.trim()
    const itemDefaults = toObject(option.itemDefaults) as ItemDefaults
    const word = getWord(item, itemDefaults)
    const range = getReplaceRange(item, itemDefaults, inputStart) ?? option.range
    const character = range.start.character
    const data = toObject(item.data)
    const filterText = item.filterText ?? item.label
    const delta = this.getDelta(filterText, character)
    let obj: DurationCompleteItem = {
      // the word to be insert from it's own character.
      word: this.fixFollow(word, isSnippetItem(item, itemDefaults), range.end.character),
      abbr: label,
      character,
      delta,
      kind: item.kind,
      detail: item.detail,
      sortText: item.sortText,
      filterText,
      preselect: item.preselect === true,
      deprecated: item.deprecated === true || item.tags?.includes(CompletionItemTag.Deprecated),
      isSnippet: hasAction(item, itemDefaults),
      index,
      source,
      priority,
      dup: data.dup !== 0
    }
    this.minCharacter = Math.min(this.minCharacter, character)
    if (data.optional && !obj.abbr.endsWith(QuestionMark)) obj.abbr += QuestionMark
    if (!emptLabelDetails(item.labelDetails)) obj.labelDetails = item.labelDetails
    if (Is.number(item['score']) && !obj.sortText) obj.sortText = String.fromCodePoint(MAX_CODE_POINT - Math.round(item['score']))
    return obj
  }
}

function toItemKey(item: MruItem): string {
  let label = item.filterText
  let source = item.source
  let kind = item.kind ?? ''
  return `${label}|${source}|${kind}`
}

export class MruLoader {
  private max = 0
  private items: LRUCache<string, number> = new LRUCache(MAX_MRU_ITEMS)
  private itemsNoPrefex: LRUCache<string, number> = new LRUCache(MAX_MRU_ITEMS)

  public getScore(input: string, item: MruItem, selection: Selection): number {
    let key = toItemKey(item)
    if (input.length == 0) return this.itemsNoPrefex.get(key) ?? -1
    if (selection === Selection.RecentlyUsedByPrefix) key = `${input}|${key}`
    let map = selection === Selection.RecentlyUsed ? this.itemsNoPrefex : this.items
    return map.get(key) ?? -1
  }

  public add(prefix: string, item: MruItem): void {
    if (!Is.number(item.kind)) return
    let key = toItemKey(item)
    if (!item.filterText.startsWith(prefix)) {
      prefix = ''
    }
    let line = `${prefix}|${key}`
    this.items.set(line, this.max)
    this.itemsNoPrefex.set(key, this.max)
    this.max += 1
  }

  public clear(): void {
    this.max = 0
    this.items.clear()
    this.itemsNoPrefex.clear()
  }
}
