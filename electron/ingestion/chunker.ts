// Chunker semântico (Semana 7). Funções PURAS: sem I/O, determinísticas, testáveis.
// Vale para QUALQUER idioma da Wikipedia (decisão do humano): nada aqui supõe pt/en.
//
// Heurística de seções — derivada da inspeção de artigos reais do dataset `wikimedia/wikipedia`
// (snapshot 20231101, `simple` e `pt`; ver docs/roadmap/reports/week-07.md). O texto não traz
// marcação de seção: os títulos são linhas soltas. Uma linha é TÍTULO quando:
//   1. não começa com espaço (no dataset, itens de lista começam com " ");
//   2. a linha anterior está em branco (ou é outro título, no caso de subseção);
//   3. tem até 80 caracteres e até 10 palavras (depois do trim);
//   4. não termina em pontuação de frase/enumeração, de qualquer escrita (. : ; ? ! , 。 ！ ？ ، ؟ । …);
//   5. existe conteúdo depois dela no artigo.
// Na 1ª linha só vale título de apêndice (uma 1ª linha curta é quase sempre o começo da introdução).
// Títulos consecutivos (seção vazia seguida de subseção) viram um rótulo só: "História › Origem".
//
// Apêndices: ficam no fim do artigo (Ver também, Referências, Ligações externas…) e depois deles o
// dataset traz linhas soltas de navbox/categorias. A partir do PRIMEIRO título de apêndice, o resto do
// artigo é descartado. Os títulos vêm de `DROP_SECTIONS` (pt/en, conferidos nos dados; o inglês vale
// para todos os idiomas) e, para os demais idiomas, de `learnAppendixTitles` sobre uma amostra.
// Artigos SEM apêndice terminam direto nas linhas de categoria: o bloco final de linhas com forma de
// título e sem fim de frase no meio é descartado.
// Restos de wikitext (~0,9% dos artigos `pt`, ~0,2% dos `simple`): blocos `{{…}}` balanceados, linhas
// de tabela ("|", "{|") e marcas de negrito/itálico ('' e ''') são removidos.
//
// Divisão: seção → parágrafos (linhas de uma lista ficam no mesmo parágrafo) → chunks de até
// `maxTokens`, agrupando parágrafos inteiros. Parágrafo grande demais → frases (Intl.Segmenter do
// idioma, com abreviações e iniciais protegidas); frase grande demais → palavras (Intl.Segmenter, que
// também separa chinês/japonês/tailandês, sem espaços). Chunk menor que `minTokens` é fundido ao
// vizinho da mesma seção. Overlap: as últimas `overlapSentences` frases do chunk anterior da MESMA
// seção, até OVERLAP_MAX_TOKENS, para nunca passar do limite de 512 tokens do e5.
import type { ChunkMetadata } from "../../shared/chunk";
import type { WikiArticle } from "./parquet-reader";

export interface ChunkerOptions {
  /** Default 350 (estimado), sempre < 512 do e5. */
  maxTokens: number;
  /** Default 50: chunks menores são fundidos ao vizinho da mesma seção. */
  minTokens: number;
  /** Default 1 (máx. 2). */
  overlapSentences: number;
  /** Default: `defaultEstimateTokens` (por escrita). A ingestão pode passar o tokenizer real do e5. */
  estimateTokens?: (s: string) => number;
  /** Títulos de apêndice (comparação sem maiúsculas/acentos/espaços extras). Default: por idioma. */
  dropSections?: readonly string[];
}

export interface ChunkMeta {
  /** Código do idioma no dataset (ex.: "pt", "simple", "zh", "zh-min-nan"). */
  language: string;
  source: "wikipedia";
  dataset_version: string;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = { maxTokens: 350, minTokens: 50, overlapSentences: 1 };

/** Limite do multilingual-e5-small: acima disso o texto é truncado sem aviso. */
export const E5_MAX_TOKENS = 512;
/** Teto do overlap (estimado): com maxTokens 350, um chunk fica em no máximo ~451 < 512. */
export const OVERLAP_MAX_TOKENS = 100;

/** Apêndices conferidos nos dados (pt: 20231101.pt; en: 20231101.simple). */
export const DROP_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  pt: [
    "Referências",
    "Referências bibliográficas",
    "Notas",
    "Notas e referências",
    "Ligações externas",
    "Ver também",
    "Bibliografia",
    "Leitura adicional",
    "Leituras adicionais",
    "Fontes",
    "Galeria",
    "Galeria de imagens",
  ],
  en: [
    "References",
    "Notes",
    "Footnotes",
    "Citations",
    "Sources",
    "See also",
    "Related pages",
    "External links",
    "Other websites",
    "Further reading",
    "Bibliography",
    "Gallery",
  ],
};

/** Apêndices do idioma + aprendidos + os em inglês (artigos traduzidos às vezes mantêm "References"). */
const dropForCache = new Map<string, readonly string[]>();
export function dropSectionsFor(language: string, learned: readonly string[] = []): readonly string[] {
  const key = `${language}\u0000${learned.join("\u0000")}`;
  let list = dropForCache.get(key);
  if (!list) {
    const own = DROP_SECTIONS[language === "simple" ? "en" : language] ?? [];
    dropForCache.set(key, (list = Object.freeze([...new Set([...own, ...learned, ...DROP_SECTIONS.en])])));
  }
  return list;
}

const MAX_HEADING_CHARS = 80;
const MAX_HEADING_WORDS = 10;
const SECTION_SEPARATOR = " › ";
const TABLE_MARKUP = /^\s*(\{\||\|)/;
/** Pontuação final de frase/enumeração em várias escritas (latina, CJK, árabe, devanágari, etíope…). */
const FINAL_PUNCTUATION = /[.:;?!,。．！？：；，、؟؛،۔।॥።…]$/u;
/** Fim de frase no MEIO da linha (latina com espaço depois; CJK/árabe/devanágari sem precisar de espaço). */
const MID_SENTENCE_END = /[.!?…]\s|[。！？؟।။።]./u;

// ---- tokens ------------------------------------------------------------------------------------

/**
 * Estimativa conservadora de tokens do e5 por escrita (medido com o tokenizer real; ver relatório):
 * CJK ~1,7–1,9 caracteres/token → 0,75 por caractere; hebraico ~2,7 → 0,4; dígitos ~2,4 → 0,45;
 * demais escritas (latina, cirílica, árabe, devanágari, grega, tailandesa) ~3,6–4,9 → 1/3,5.
 * Faixas de código em vez de regex Unicode: é chamada milhões de vezes na ingestão.
 */
export function defaultEstimateTokens(s: string): number {
  let dense = 0;
  let hebrew = 0;
  let digits = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      if (c >= 0x30 && c <= 0x39) digits++;
      else other++;
    } else if (c >= 0x0590 && c <= 0x05ff) {
      hebrew++;
    } else if (
      (c >= 0x1100 && c <= 0x11ff) || // Hangul Jamo
      (c >= 0x3000 && c <= 0x9fff) || // pontuação CJK, kana, Hangul compat., CJK ext. A, Han
      (c >= 0xac00 && c <= 0xd7af) || // Hangul
      (c >= 0xf900 && c <= 0xfaff) || // Han de compatibilidade
      (c >= 0xff00 && c <= 0xffef) // formas de largura total
    ) {
      dense++;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // Par substituto: Han das extensões B+ (planos 2/3) conta como denso; o resto, como outro.
      const plane = ((c - 0xd800) >> 6) + 1;
      if (plane === 2 || plane === 3) dense++;
      else other++;
      i++;
    } else {
      other++;
    }
  }
  return Math.ceil(dense * 0.75 + hebrew * 0.4 + digits * 0.45 + other / 3.5);
}

// ---- segmentação (Intl.Segmenter, qualquer idioma) -----------------------------------------------

const segmenters = new Map<string, { sentence: Intl.Segmenter; word: Intl.Segmenter }>();

/** Locale ICU para o código do dataset: "simple" → "en"; tag inválida ("zh-min-nan") → idioma-base → padrão. */
function segmenterFor(language: string) {
  let cached = segmenters.get(language);
  if (cached) return cached;
  const candidates = [language === "simple" ? "en" : language, language.split("-")[0], undefined];
  for (const locale of candidates) {
    try {
      cached = {
        sentence: new Intl.Segmenter(locale, { granularity: "sentence" }),
        word: new Intl.Segmenter(locale, { granularity: "word" }),
      };
      break;
    } catch {
      // tag inválida para o ICU: tenta a próxima
    }
  }
  segmenters.set(language, cached!);
  return cached!;
}

/** Abreviações (pt/en) que o ICU trata como fim de frase. Iniciais de uma letra ("J.") também. */
const ABBREVIATIONS = new Set(["sr", "sra", "dr", "dra", "st", "mr", "mrs", "ms", "prof", "etc", "vs", "jr", "no", "nº", "p", "pp", "c", "ca", "séc", "sec", "fig", "vol", "ed", "op", "cit", "e.g", "i.e", "a.c", "d.c"]);

function endsWithAbbreviation(segment: string): boolean {
  const lastWord = /(\S+)\.$/.exec(segment.trimEnd())?.[1]?.replace(/^[("“]/, "").toLowerCase() ?? "";
  return ABBREVIATIONS.has(lastWord) || /^\p{L}$/u.test(lastWord);
}

/** Frases do parágrafo. Quebras de linha (itens de lista) também separam. */
export function splitSentences(paragraph: string, language = "en"): string[] {
  const { sentence } = segmenterFor(language);
  const sentences: string[] = [];
  for (const line of paragraph.split("\n")) {
    let pending = "";
    for (const { segment } of sentence.segment(line)) {
      pending += segment;
      if (!endsWithAbbreviation(pending)) {
        if (pending.trim()) sentences.push(pending.trim());
        pending = "";
      }
    }
    if (pending.trim()) sentences.push(pending.trim());
  }
  return sentences;
}

/** Junta frases: sem espaço depois de pontuação CJK (o chinês/japonês não separa frases com espaço). */
function joinSentences(parts: string[]): string {
  return parts.reduce((text, part) => (!text ? part : /[。！？」』）]$/u.test(text) ? text + part : `${text} ${part}`), "");
}

/** Último recurso: frase maior que o limite → pedaços por palavras (segmentação do idioma; funciona sem espaços). */
function splitWords(sentence: string, maxTokens: number, estimate: (s: string) => number, language: string): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const { segment } of segmenterFor(language).word.segment(sentence)) {
    if (current.trim() && estimate(current + segment) > maxTokens) {
      pieces.push(current.trim());
      current = "";
    }
    // Um "segmento" maior que o limite (ex.: sequência sem quebras): fatia por caracteres.
    if (estimate(segment) > maxTokens) {
      for (const ch of segment) {
        if (current && estimate(current + ch) > maxTokens) {
          pieces.push(current.trim());
          current = "";
        }
        current += ch;
      }
      continue;
    }
    current += segment;
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

// ---- seções ------------------------------------------------------------------------------------

/** Remove blocos `{{…}}` balanceados (aninhados, multilinha). Sem fechamento: mantém o texto. */
export function stripTemplates(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    if (open < 0) break;
    let depth = 0;
    let j = open;
    let close = -1;
    while (j < text.length - 1) {
      if (text.startsWith("{{", j)) {
        depth++;
        j += 2;
      } else if (text.startsWith("}}", j)) {
        depth--;
        j += 2;
        if (depth === 0) {
          close = j;
          break;
        }
      } else {
        j++;
      }
    }
    if (close < 0) break; // desbalanceado: não arrisca apagar o resto do artigo
    out += text.slice(i, open);
    i = close;
  }
  return out + text.slice(i);
}

/** Para comparar títulos: minúsculas, sem diacríticos latinos, espaços normalizados. */
export function normalizeTitle(title: string): string {
  return title.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isHeadingShape(line: string): boolean {
  if (line.length === 0 || /^\s/.test(line)) return false;
  const text = line.trim();
  if (!text || text.length > MAX_HEADING_CHARS) return false;
  if (text.split(/\s+/).length > MAX_HEADING_WORDS) return false;
  return !FINAL_PUNCTUATION.test(text);
}

export interface Section {
  title: string | null;
  paragraphs: string[];
}

/** Separa o artigo em seções (título + parágrafos), já sem os apêndices. */
/** Conjunto normalizado por lista de apêndices (a mesma lista serve a milhares de artigos). */
const dropSetCache = new WeakMap<readonly string[], Set<string>>();
function dropSetOf(dropSections: readonly string[]): Set<string> {
  let set = dropSetCache.get(dropSections);
  if (!set) dropSetCache.set(dropSections, (set = new Set(dropSections.map(normalizeTitle))));
  return set;
}

export function splitSections(text: string, dropSections: readonly string[]): Section[] {
  const drop = dropSetOf(dropSections);
  const lines = stripTemplates(text)
    .replace(/'{2,}/g, "") // negrito/itálico de wikitext: '' e '''
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => (TABLE_MARKUP.test(l) ? "" : l));
  // Categorias/navbox no fim: corta o bloco final de linhas com forma de título e sem fim de frase no meio.
  let end = lines.length;
  const isCategoryLine = (l: string) => isHeadingShape(l) && !MID_SENTENCE_END.test(l);
  while (end > 0 && (lines[end - 1].trim() === "" || isCategoryLine(lines[end - 1]))) end--;
  lines.length = end;

  const sections: Section[] = [{ title: null, paragraphs: [] }];
  let paragraph: string[] = [];
  let headingRun: string[] = []; // títulos consecutivos ainda sem conteúdo
  let previousBlank = true;

  const flushParagraph = () => {
    const joined = paragraph.map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
    if (joined) sections[sections.length - 1].paragraphs.push(joined);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      flushParagraph();
      previousBlank = true;
      continue;
    }
    const afterHeading = headingRun.length > 0 && paragraph.length === 0;
    const firstLineOk = i > 0 || drop.has(normalizeTitle(line));
    // Depois do corte do fim, a última linha é conteúdo: há conteúdo após `i` se `i` não for a última.
    const hasContentAfter = i < lines.length - 1;
    if ((previousBlank || afterHeading) && firstLineOk && isHeadingShape(line) && hasContentAfter) {
      flushParagraph();
      const title = line.trim();
      if (drop.has(normalizeTitle(title))) break; // apêndice: o resto do artigo é descartado
      headingRun = afterHeading ? [...headingRun, title] : [title];
      const label = headingRun.slice(-2).join(SECTION_SEPARATOR);
      const current = sections[sections.length - 1];
      // Seção ainda vazia (subtítulo logo abaixo do título): só atualiza o rótulo.
      if (afterHeading && current.paragraphs.length === 0) current.title = label;
      else sections.push({ title: label, paragraphs: [] });
      previousBlank = false;
      continue;
    }
    headingRun = [];
    paragraph.push(line);
    previousBlank = false;
  }
  flushParagraph();
  return sections.filter((s) => s.paragraphs.length > 0);
}

// ---- apêndices aprendidos (qualquer idioma) --------------------------------------------------------

/** Parágrafo de prosa: até 2 linhas, ≥ 120 caracteres e algum fim de frase (listas e citações não contam). */
function hasProse(section: Section): boolean {
  return section.paragraphs.some((p) => p.split("\n").length <= 2 && p.length >= 120 && /[.!?。！？؟।]/u.test(p));
}

export interface LearnAppendixOptions {
  /** Fração mínima de artigos em que o título aparece no fim sem prosa (default 0,02 = 2%). */
  minShare?: number;
  /** Em quantas das ocorrências o título precisa estar no fim e sem prosa (default 0,9). */
  minTrailingRatio?: number;
  /** Mínimo absoluto de ocorrências (default 10). */
  minCount?: number;
}

/**
 * Descobre os títulos de apêndice de um idioma a partir de uma amostra de artigos: títulos FREQUENTES
 * que quase sempre aparecem no bloco final de seções sem prosa. Limiar alto de propósito: é melhor
 * deixar passar um apêndice raro (vira um chunk de lista) do que descartar conteúdo ("Discografia").
 */
export function learnAppendixTitles(texts: Iterable<string>, opts: LearnAppendixOptions = {}): string[] {
  const { minShare = 0.02, minTrailingRatio = 0.9, minCount = 10 } = opts;
  const total = new Map<string, number>();
  const trailing = new Map<string, number>();
  const display = new Map<string, string>();
  let articles = 0;
  for (const text of texts) {
    articles++;
    const sections = splitSections(text, []);
    const titles = sections.map((s) => (s.title ?? "").split(SECTION_SEPARATOR));
    let firstTrailing = sections.length;
    while (firstTrailing > 1 && !hasProse(sections[firstTrailing - 1])) firstTrailing--;
    sections.forEach((_, i) => {
      for (const title of titles[i]) {
        if (!title) continue;
        const key = normalizeTitle(title);
        display.set(key, display.get(key) ?? title);
        total.set(key, (total.get(key) ?? 0) + 1);
        if (i >= firstTrailing) trailing.set(key, (trailing.get(key) ?? 0) + 1);
      }
    });
  }
  const threshold = Math.max(minCount, minShare * articles);
  return [...trailing]
    .filter(([key, n]) => n >= threshold && n / total.get(key)! >= minTrailingRatio)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => display.get(key)!);
}

// ---- chunks ------------------------------------------------------------------------------------

/** Pedaços de no máximo `maxTokens`: o parágrafo inteiro, ou suas frases, ou pedaços de frase. */
function units(paragraph: string, maxTokens: number, estimate: (s: string) => number, language: string): string[] {
  if (estimate(paragraph) <= maxTokens) return [paragraph];
  return splitSentences(paragraph, language).flatMap((sentence) =>
    estimate(sentence) <= maxTokens ? [sentence] : splitWords(sentence, maxTokens, estimate, language),
  );
}

/**
 * Agrupa os parágrafos de UMA seção em chunks de até `maxTokens` (sem overlap ainda). Os tokens são
 * somados por pedaço (+1 por separador) em vez de reestimar o texto acumulado a cada passo.
 */
function groupSection(paragraphs: string[], maxTokens: number, minTokens: number, estimate: (s: string) => number, language: string): string[] {
  const chunks: Array<{ text: string; tokens: number }> = [];
  let current = "";
  let currentTokens = 0;
  const append = (piece: string, newParagraph: boolean) => {
    const pieceTokens = estimate(piece);
    if (current && currentTokens + 1 + pieceTokens > maxTokens) {
      chunks.push({ text: current, tokens: currentTokens });
      current = "";
      currentTokens = 0;
    }
    if (!current) {
      current = piece;
      currentTokens = pieceTokens;
      return;
    }
    current = newParagraph ? `${current}\n\n${piece}` : joinSentences([current, piece]);
    currentTokens += 1 + pieceTokens;
  };
  for (const paragraph of paragraphs) {
    units(paragraph, maxTokens, estimate, language).forEach((unit, i) => append(unit, i === 0));
  }
  if (current) chunks.push({ text: current, tokens: currentTokens });

  // Fusão de pequenos: com o anterior, se couber.
  const merged: Array<{ text: string; tokens: number }> = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    const small = chunk.tokens < minTokens || (previous !== undefined && previous.tokens < minTokens);
    if (previous && small && previous.tokens + 1 + chunk.tokens <= maxTokens) {
      merged[merged.length - 1] = { text: `${previous.text}\n\n${chunk.text}`, tokens: previous.tokens + 1 + chunk.tokens };
    } else {
      merged.push(chunk);
    }
  }
  return merged.map((c) => c.text);
}

/** Últimas `n` frases do chunk anterior, reduzindo para 1 (ou nenhuma) se passarem de OVERLAP_MAX_TOKENS. */
function overlapTail(previous: string, n: number, estimate: (s: string) => number, language: string): string {
  const sentences = splitSentences(previous, language);
  for (let k = n; k > 0; k--) {
    const tail = joinSentences(sentences.slice(-k));
    if (estimate(tail) <= OVERLAP_MAX_TOKENS) return tail;
  }
  return "";
}

/** Chunks do artigo com todos os metadados. Determinística: mesma entrada → mesma saída (e mesmos ids). */
export function chunkArticle(article: WikiArticle, meta: ChunkMeta, opts: ChunkerOptions = DEFAULT_CHUNKER_OPTIONS): ChunkMetadata[] {
  const estimate = opts.estimateTokens ?? defaultEstimateTokens;
  const overlapSentences = Math.min(2, Math.max(0, Math.floor(opts.overlapSentences)));
  if (!(opts.maxTokens > 0 && opts.maxTokens < E5_MAX_TOKENS)) throw new Error(`maxTokens deve ficar entre 1 e ${E5_MAX_TOKENS - 1}.`);
  if (opts.minTokens < 0 || opts.minTokens >= opts.maxTokens) throw new Error("minTokens deve ser menor que maxTokens.");
  const dropSections = opts.dropSections ?? dropSectionsFor(meta.language);

  const chunks: ChunkMetadata[] = [];
  for (const section of splitSections(article.text ?? "", dropSections)) {
    const groups = groupSection(section.paragraphs, opts.maxTokens, opts.minTokens, estimate, meta.language);
    groups.forEach((text, i) => {
      // Overlap: últimas frases do chunk anterior DESTA seção (nunca atravessa seções).
      const tail = i > 0 && overlapSentences > 0 ? overlapTail(groups[i - 1], overlapSentences, estimate, meta.language) : "";
      const withOverlap = tail && !text.startsWith(tail) ? `${tail}\n\n${text}` : text;
      chunks.push({
        chunk_id: `${meta.source}:${meta.language}:${article.id}:${String(chunks.length).padStart(4, "0")}`,
        document_id: article.id,
        document_title: article.title,
        section: section.title,
        text: withOverlap,
        language: meta.language,
        source: meta.source,
        dataset_version: meta.dataset_version,
        url: article.url,
      });
    });
  }
  return chunks;
}
