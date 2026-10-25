/**
 * Small in-memory BM25 for meeting text in Portuguese, English and Spanish.
 * Text is accent-folded and lower-cased, so "decisão", "Decisao" and "DECISÃO" are the same term.
 */

const STOPWORD_LIST = [
  // Portuguese
  "a", "ao", "aos", "aquela", "aquelas", "aquele", "aqueles", "aquilo", "as", "ate", "com", "como", "da", "das", "de", "dela", "delas",
  "dele", "deles", "depois", "do", "dos", "e", "ela", "elas", "ele", "eles", "em", "entre", "era", "eram", "essa", "essas", "esse", "esses",
  "esta", "estamos", "estao", "estas", "estava", "estavam", "este", "estes", "eu", "foi", "foram", "ha", "isso", "isto", "ja", "la", "lhe",
  "lhes", "mais", "mas", "me", "mesmo", "meu", "meus", "minha", "minhas", "muito", "na", "nao", "nas", "nem", "no", "nos", "nossa",
  "nossas", "nosso", "nossos", "num", "numa", "o", "os", "ou", "para", "pela", "pelas", "pelo", "pelos", "por", "pra", "qual", "quando",
  "que", "quem", "se", "sem", "ser", "seu", "seus", "so", "sua", "suas", "tambem", "te", "tem", "temos", "tenho", "ter", "teu", "tua",
  "um", "uma", "umas", "uns", "voce", "voces", "vai", "vou", "ne", "aqui", "ai", "entao", "tipo", "assim", "sobre", "sao", "seja",
  "estou", "tinha", "tava", "ta", "to", "gente",
  // English
  "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "could", "did", "do",
  "does", "for", "from", "had", "has", "have", "he", "her", "him", "his", "how", "if", "in", "into", "is", "it", "its", "just", "me",
  "my", "no", "not", "of", "on", "or", "our", "out", "she", "so", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "those", "to", "too", "up", "us", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your", "yeah", "okay", "ok",
  // Spanish
  "al", "algo", "como", "con", "del", "el", "ella", "ellas", "ellos", "en", "es", "esa", "esas", "ese", "eso", "esos", "esta", "estas",
  "este", "esto", "estos", "fue", "hay", "la", "las", "le", "les", "lo", "los", "mas", "mi", "mis", "muy", "nosotros", "nuestra",
  "nuestro", "para", "pero", "por", "porque", "que", "se", "si", "sin", "su", "sus", "tu", "tus", "un", "una", "unas", "unos", "usted",
  "ustedes", "y", "ya", "yo"
];

export const STOPWORDS: ReadonlySet<string> = new Set(STOPWORD_LIST);

/** NFD, no diacritics, lower case. */
export const foldText = (value: string): string => value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

const MAX_TOKENIZED_CHARACTERS = 200_000;

/** Search terms: `[a-z0-9]+` runs of at least two characters that are not stopwords. */
export const tokenize = (value: string): string[] => {
  const folded = foldText(value.length > MAX_TOKENIZED_CHARACTERS ? value.slice(0, MAX_TOKENIZED_CHARACTERS) : value);
  const terms: string[] = [];
  for (const match of folded.matchAll(/[a-z0-9]+/g)) {
    const term = match[0];
    if (term.length >= 2 && !STOPWORDS.has(term)) terms.push(term);
  }
  return terms;
};

export type Bm25Field = { text: string; weight: number };
export type Bm25Document = { fields: Bm25Field[] };
export type Bm25Hit = { index: number; score: number };

const K1 = 1.2;
const B = 0.75;

/**
 * BM25 with weighted fields folded into one bag of words (a light BM25F): a term in a field of
 * weight 2 counts as two occurrences. Build once, query many times.
 */
export class Bm25Index {
  private readonly postings = new Map<string, Array<[number, number]>>();
  private readonly lengths: Float64Array;
  private readonly averageLength: number;
  readonly size: number;

  constructor(documents: ReadonlyArray<Bm25Document>) {
    this.size = documents.length;
    this.lengths = new Float64Array(documents.length);
    let total = 0;
    documents.forEach((document, index) => {
      const frequencies = new Map<string, number>();
      let length = 0;
      for (const field of document.fields) {
        if (!(field.weight > 0) || !field.text) continue;
        for (const term of tokenize(field.text)) {
          frequencies.set(term, (frequencies.get(term) || 0) + field.weight);
          length += field.weight;
        }
      }
      this.lengths[index] = length;
      total += length;
      for (const [term, frequency] of frequencies) {
        let list = this.postings.get(term);
        if (!list) { list = []; this.postings.set(term, list); }
        list.push([index, frequency]);
      }
    });
    this.averageLength = documents.length ? total / documents.length || 1 : 1;
  }

  /** Ranked documents for a query; `accept` limits the candidates (for example to some recordings). */
  search(query: string, options: { limit?: number; accept?: (index: number) => boolean } = {}): Bm25Hit[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 10_000));
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !this.size) return [];
    const scores = new Map<number, number>();
    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (this.size - list.length + 0.5) / (list.length + 0.5));
      for (const [index, frequency] of list) {
        if (options.accept && !options.accept(index)) continue;
        const norm = K1 * (1 - B + (B * this.lengths[index]!) / this.averageLength);
        const gain = idf * ((frequency * (K1 + 1)) / (frequency + norm));
        scores.set(index, (scores.get(index) || 0) + gain);
      }
    }
    return [...scores.entries()]
      .map(([index, score]) => ({ index, score }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, limit);
  }
}
