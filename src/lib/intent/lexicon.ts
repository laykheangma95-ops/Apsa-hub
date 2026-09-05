/**
 * Cambodia-first commerce lexicon.
 *
 * Entries are matched against the NORMALIZED message (see `normalize.ts`), so
 * every literal here is lowercase, uses Arabic digits, and uses single spaces.
 *
 * This is deliberately organised as token/pattern groups rather than one flat
 * dictionary of whole sentences: Khmer chat has no canonical spelling, so the
 * engine must compose meaning from small reusable parts. Adding a new
 * romanization or a new colour is a one-line change here — no engine change.
 */
import type { SignalKind } from "./types";

export interface LexiconEntry {
  /** literal in normalized form */
  match: string;
  kinds: SignalKind[];
  /** canonical value: colour slug, size label, quantity, or unit slug */
  value?: string | number;
  /**
   * Khmer has no word spacing, so very short Khmer literals (e.g. "ស" = white)
   * would match inside longer words. When set, the literal is only accepted if
   * what follows is not a Khmer letter, or is itself the start of another
   * lexicon entry.
   */
  strictKhmerBoundary?: boolean;
  /** relative strength inside its category; defaults to 1 */
  weight?: number;
}

const e = (
  match: string,
  kinds: SignalKind[],
  extra: Omit<LexiconEntry, "match" | "kinds"> = {},
): LexiconEntry => ({ match, kinds, ...extra });

// ── Politeness / conversational particles ────────────────────────────────────
// §Cambodian conversation particles: these must never change the detected
// business intent.
const PARTICLES: LexiconEntry[] = [
  "បងអើយ",
  "បងចា",
  "បងបាទ",
  "បង",
  "អូន",
  "អើយ",
  "អរគុណ",
  "សូម",
  "ណា",
  "bong",
  "bg",
  "oun",
  "akun",
  "orkun",
  "thanks",
  "thank you",
  "thx",
  "pls",
  "please",
  "hello",
  "hi",
  "sousdey",
  "សួស្តី",
  "ជម្រាបសួរ",
  "tv",
].map((m) => e(m, ["particle"]));

// Interrogative tails. "អត់" and "ទេ" turn a statement into a question; alone
// they are never a negation.
const QUESTION_MARKERS: LexiconEntry[] = [
  "អត់",
  "ទេ",
  "ដែរ",
  "ម៉េច",
  "អីខ្លះ",
  "អី",
  "អ្វី",
  "ot",
  "te",
  "der",
].map((m) => e(m, ["question"]));

// ── §1 Purchase / order intent ───────────────────────────────────────────────
const PURCHASE: LexiconEntry[] = [
  "ចង់បាន",
  "ចង់ទិញ",
  "ចង់កម្ម៉ង់",
  "ចង់កម្មង់",
  "កម្ម៉ង់",
  "កម្មង់",
  "យក",
  "ទិញ",
  "ផ្ញើមក",
  "ទុកឲ្យ",
  "ទុកឱ្យ",
  "យកឲ្យ",
  "យកឱ្យ",
  "បានយក",
  "ចាសយក",
  "order",
  "buy",
  "purchase",
  // romanized Khmer
  "yk",
  "yok",
  "jong ban",
  "jongban",
  "chong ban",
  "chongban",
  "komong",
  "kamong",
  "komang",
  "phnherv mok",
  "phner mok",
].map((m) => e(m, ["purchase"]));

// "ផ្ញើ" / "send" only means "order" when nothing in the message points at an
// address; the engine decides (see detect.ts).
const SEND_REQUESTS: LexiconEntry[] = ["ផ្ញើ", "send", "phnherv"].map((m) =>
  e(m, ["send_request"]),
);

// §1 Repeat purchase
const REPEAT: LexiconEntry[] = [
  "ដដែល",
  "អាដដែល",
  "ដូចមុន",
  "ដូចលើកមុន",
  "លើកមុន",
  "ម៉ូតមុន",
  "អាមុននោះ",
  "អាមុន",
  "ដែលទិញមុន",
  "ដែលយកមុន",
  "អាដែលទិញមុន",
  "អាដែលខ្ញុំទិញមុន",
  "same as before",
  "same as last time",
  "same as last",
  "same one",
  "same",
  "old order",
  "repeat order",
  "repeat",
  "usual",
  "doch mun",
  "dach mun",
  "dauch mun",
  "doch mon",
].map((m) => e(m, ["repeat"]));

// §1 Lower-confidence interest — never enough for an order on its own.
const INTEREST: LexiconEntry[] = [
  "ស្អាត",
  "ចូលចិត្ត",
  "អេម",
  "មើលទៅល្អ",
  "ល្អ",
  "ចង់មើល",
  "cute",
  "nice",
  "pretty",
  "beautiful",
  "love it",
  "like it",
  "lovely",
  "sa'at",
  "saat",
  "chol chet",
].map((m) => e(m, ["interest"]));

// ── §2 Stock / availability ──────────────────────────────────────────────────
const STOCK: LexiconEntry[] = [
  "នៅមានអត់",
  "នៅមានទេ",
  "នៅមានរបស់",
  "នៅមាន",
  "មានអត់",
  "មានទេ",
  "មាននៅ",
  "នៅសល់អត់",
  "នៅសល់ទេ",
  "នៅសល់ប៉ុន្មាន",
  "នៅសល់",
  "សល់ប៉ុន្មាន",
  "សល់",
  "អស់នៅ",
  "អស់ហើយ",
  "មានស្តុកអត់",
  "មានស្តុកទេ",
  "ស្តុកនៅមាន",
  "ស្តុក",
  "មានរបស់",
  "មានទំនិញ",
  "មានប៉ុន្មាន",
  "stock",
  "in stock",
  "available",
  "availability",
  "restock",
  "ready stock",
  "sold out",
  "mean ot",
  "mien ot",
  "mean te",
  "nov mean ot",
  "nov mean",
  "mean ort",
].map((m) => e(m, ["stock"]));

// Weak stock words: present in many sentences, so they must not outweigh a
// price or delivery question.
const WEAK_STOCK: LexiconEntry[] = ["មាន", "អស់", "mean"].map((m) =>
  e(m, ["stock"], { weight: 0.4 }),
);

// ── §7 Price ─────────────────────────────────────────────────────────────────
const PRICE: LexiconEntry[] = [
  "ថ្លៃប៉ុន្មាន",
  "តម្លៃប៉ុន្មាន",
  "ប៉ុន្មាន",
  "ថ្លៃ",
  "តម្លៃ",
  "price",
  "how much",
  "howmuch",
  "hm",
  "cost",
  "ponman",
  "punman",
  "tlai",
  "thlai",
].map((m) => e(m, ["price"]));

const DISCOUNT: LexiconEntry[] = [
  "បញ្ចុះតម្លៃ",
  "បញ្ចុះ",
  "ចុះបាន",
  "ចុះតម្លៃ",
  "ថោក",
  "discount",
  "promotion",
  "promo",
  "sale",
  "voucher",
].map((m) => e(m, ["discount"]));

const CURRENCY: LexiconEntry[] = ["$", "ដុល្លារ", "usd", "riel", "រៀល", "khr", "%"].map((m) =>
  e(m, ["currency"]),
);

// ── §8 Delivery ──────────────────────────────────────────────────────────────
const DELIVERY: LexiconEntry[] = [
  "សេវាដឹក",
  "ដឹកមក",
  "ដឹកទៅ",
  "ដឹកបាន",
  "ដឹក",
  "ផ្ញើបាន",
  "ថ្ងៃណាបាន",
  "ដល់ពេលណា",
  "ប៉ុន្មានថ្ងៃ",
  "ថ្ងៃនេះដល់",
  "delivery",
  "deliver",
  "shipping",
  "ship",
  "express",
  "courier",
  "dek ban ot",
  "dek ban",
  "dek",
].map((m) => e(m, ["delivery"]));

const DELIVERY_FREE: LexiconEntry[] = [
  "free delivery",
  "free ship",
  "free shipping",
  "ហ្វ្រីដឹក",
  "ដឹក free",
  "ឥតគិតថ្លៃ",
].map((m) => e(m, ["delivery", "delivery_free"]));

// ── §9 Address / location ────────────────────────────────────────────────────
const ADDRESS: LexiconEntry[] = [
  "អាសយដ្ឋាន",
  "ទីតាំង",
  "ទីនេះ",
  "សង្កាត់",
  "ខណ្ឌ",
  "ភូមិ",
  "ឃុំ",
  "ស្រុក",
  "ខេត្ត",
  "ភ្នំពេញ",
  "សៀមរាប",
  "បាត់ដំបង",
  "កំពត",
  "location",
  "address",
  "pin",
  "map",
  "phnom penh",
  "siem reap",
  "battambang",
  "pp",
  "tk",
  "bkk",
  "sen sok",
  "toul kork",
  "chroy changvar",
].map((m) => e(m, ["address"]));

const ADDRESS_MARKERS: LexiconEntry[] = [
  "ផ្លូវ",
  "ផ្ទះលេខ",
  "ផ្ទះ",
  "street",
  "st",
  "house",
  "borey",
  "បុរី",
].map((m) => e(m, ["address", "address_marker"]));

// ── §10 Phone / contact ──────────────────────────────────────────────────────
const PHONE_MARKERS: LexiconEntry[] = [
  "នេះលេខខ្ញុំ",
  "លេខខ្ញុំ",
  "លេខទូរស័ព្ទ",
  "ទូរស័ព្ទ",
  "លេខនេះ",
  "tel",
  "telephone",
  "phone",
  "contact",
  "call",
  "whatsapp",
  "telegram number",
].map((m) => e(m, ["phone", "phone_marker"]));

// ── §11 Confirmation ─────────────────────────────────────────────────────────
const CONFIRM: LexiconEntry[] = [
  "បានបង",
  "បានចា",
  "បានៗ",
  "បាន",
  "យល់ព្រម",
  "ចាស",
  "ចា",
  "បាទ",
  "ត្រូវហើយ",
  "ហ្នឹងហើយ",
  "អូខេបង",
  "អូខេ",
  "យកហើយ",
  "ok",
  "okay",
  "oke",
  "yes",
  "yep",
  "correct",
  "right",
  "deal",
  "confirm",
  "sure",
  "agree",
  "ban bong",
  "ban cha",
  "chas",
  "cha",
  "baat",
].map((m) => e(m, ["confirm"]));

// "អាហ្នឹង" / "យកហ្នឹង" confirm *and* point at something.
const CONFIRM_REFS: LexiconEntry[] = ["អាហ្នឹង", "យកហ្នឹង", "ហ្នឹង"].map((m) =>
  e(m, ["confirm", "product_ref"]),
);

// ── §12 Negation / change of mind ────────────────────────────────────────────
const NEGATE: LexiconEntry[] = [
  "អត់យកទេ",
  "អត់យក",
  "មិនយក",
  "លែងយក",
  "មិនចង់បានទេ",
  "មិនចង់បាន",
  "អត់ចង់បាន",
  "មិនចង់",
  "អត់កម្ម៉ង់",
  "អត់កម្មង់",
  "មិនកម្ម៉ង់",
  "មិន",
  "cancel",
  "no thanks",
  "not now",
  "nope",
  "ot yk",
  "ot yok",
  "min yk",
  "min yok",
].map((m) => e(m, ["negate"]));

const HESITATE: LexiconEntry[] = [
  "ឈប់សិន",
  "ចាំសិន",
  "ចាំមើលសិន",
  "មិនទាន់យក",
  "មិនទាន់",
  "អត់ទាន់",
  "គិតសិន",
  "សួរមើលសិន",
  "សួរប្តីសិន",
  "សួរសិន",
  "មើលសិន",
  "ចាំបន្តិច",
  "wait",
  "later",
  "maybe",
  "thinking",
  "cham sin",
  "chaam sin",
  "kit sin",
].map((m) => e(m, ["hesitate"]));

// "សិន" ("… first / for now") turns a look into a maybe — but only when the
// customer did not also state a purchase verb ("យកមួយសិន" is still an order).
const WEAK_HESITATE: LexiconEntry[] = [e("សិន", ["hesitate"], { weight: 0.5 })];

// "not that one" is a correction, not a cancellation — it should update the
// pending suggestion rather than clear it (§12).
const CHANGE: LexiconEntry[] = [
  "មិនមែនអានេះ",
  "មិនមែន",
  "អត់អា",
  "ប្តូរទៅ",
  "ប្ដូរទៅ",
  "ប្តូរ",
  "ប្ដូរ",
  "តែមួយវិញ",
  "វិញ",
  "change color",
  "change colour",
  "change size",
  "change to",
  "wrong one",
  "not this",
  "instead",
].map((m) => e(m, ["change"]));

// ── §6 Photo requests (interest, never an order) ─────────────────────────────
const PHOTO_REQUEST: LexiconEntry[] = [
  "ផ្ញើរូបមើល",
  "ផ្ញើរូប",
  "សូមរូប",
  "មើលរូប",
  "send photo",
  "send pic",
  "send picture",
].map((m) => e(m, ["photo_request"]));

// ── §6 Product references ────────────────────────────────────────────────────
const PRODUCT_REFS: LexiconEntry[] = [
  "អានេះ",
  "មួយនេះ",
  "ម៉ូតអានេះ",
  "ម៉ូតនេះ",
  "អាដែលផុស",
  "អាដែល post",
  "អាក្នុងរូប",
  "មួយក្នុងរូប",
  "ក្នុងរូប",
  "អាខាងឆ្វេង",
  "អាខាងស្តាំ",
  "ខាងឆ្វេង",
  "ខាងស្តាំ",
  "this one",
  "that one",
  "this item",
  "anih",
  "a nih",
].map((m) => e(m, ["product_ref"]));

const WEAK_PRODUCT_REFS: LexiconEntry[] = ["នេះ", "nih"].map((m) =>
  e(m, ["product_ref"], { weight: 0.5 }),
);

// "អាខ្មៅ" — a product reference that also names a colour.
const COLOR_REF_PAIRS: [string, string][] = [
  ["អាខ្មៅ", "black"],
  ["អាស", "white"],
  ["អាខៀវ", "blue"],
  ["អាក្រហម", "red"],
  ["the black one", "black"],
  ["the white one", "white"],
];

const COLOR_REFS: LexiconEntry[] = COLOR_REF_PAIRS.map(([m, v]) =>
  e(m, ["product_ref", "color"], { value: v, strictKhmerBoundary: true }),
);

const IMAGE_MARKERS: LexiconEntry[] = ["រូបទី", "រូបភាពទី", "pic", "pics", "photo", "image"].map(
  (m) => e(m, ["product_ref", "image_marker"]),
);

const IMAGE_ORDINAL_PAIRS: [string, number][] = [
  ["first one", 1],
  ["second one", 2],
  ["third one", 3],
];

const IMAGE_ORDINALS: LexiconEntry[] = IMAGE_ORDINAL_PAIRS.map(([m, v]) =>
  e(m, ["product_ref", "image_index"], { value: v }),
);

// ── §5 Colours ───────────────────────────────────────────────────────────────
const COLOR_PAIRS: [string, string, boolean?][] = [
  ["ខ្មៅ", "black"],
  ["ស", "white", true],
  ["ក្រហម", "red"],
  ["ខៀវ", "blue"],
  ["បៃតង", "green"],
  ["លឿង", "yellow"],
  ["ផ្កាឈូក", "pink"],
  ["ប្រផេះ", "grey"],
  ["ត្នោត", "brown"],
  ["ស្វាយ", "purple"],
  ["black", "black"],
  ["kmao", "black"],
  ["khmao", "black"],
  ["white", "white"],
  ["red", "red"],
  ["blue", "blue"],
  ["green", "green"],
  ["pink", "pink"],
  ["grey", "grey"],
  ["gray", "grey"],
  ["brown", "brown"],
  ["cream", "cream"],
  ["beige", "beige"],
  ["navy", "navy"],
  ["nude", "nude"],
  ["purple", "purple"],
  ["yellow", "yellow"],
  ["orange", "orange"],
];

const COLORS: LexiconEntry[] = COLOR_PAIRS.map(([m, v, strict]) =>
  e(m, ["color"], { value: v, ...(strict === true ? { strictKhmerBoundary: true } : {}) }),
);

const COLOR_MARKERS: LexiconEntry[] = ["ពណ៌", "color", "colour"].map((m) => e(m, ["color_marker"]));

// ── §4 Sizes ─────────────────────────────────────────────────────────────────
const SIZE_PAIRS: [string, string][] = [
  ["xxxl", "XXXL"],
  ["xxl", "XXL"],
  ["xl", "XL"],
  ["xxs", "XXS"],
  ["xs", "XS"],
  ["s", "S"],
  ["m", "M"],
  ["l", "L"],
  ["free size", "FREE"],
  ["freesize", "FREE"],
  ["oversize", "OVERSIZE"],
  ["standard size", "STANDARD"],
  ["តូចជាងនេះ", "SMALLER"],
  ["ធំជាងនេះ", "BIGGER"],
  ["តូច", "SMALL"],
  ["មធ្យម", "MEDIUM"],
  ["ធំ", "LARGE"],
];

const SIZES: LexiconEntry[] = SIZE_PAIRS.map(([m, v]) =>
  e(m, ["size"], { value: v, strictKhmerBoundary: true }),
);

const SIZE_MARKERS: LexiconEntry[] = ["size", "លេខ", "ទំហំ"].map((m) => e(m, ["size_marker"]));

// ── §3 Quantities ────────────────────────────────────────────────────────────
const QUANTITY_WORDS: [string, number][] = [
  ["តែមួយ", 1],
  ["មួយ", 1],
  ["ពីរ", 2],
  ["បី", 3],
  ["បួន", 4],
  ["ប្រាំមួយ", 6],
  ["ប្រាំពីរ", 7],
  ["ប្រាំបី", 8],
  ["ប្រាំបួន", 9],
  ["ប្រាំ", 5],
  ["ដប់", 10],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["muy", 1],
  ["pi", 2],
];

const QUANTITIES: LexiconEntry[] = QUANTITY_WORDS.map(([m, v]) =>
  e(m, ["quantity"], { value: v, strictKhmerBoundary: true }),
);

const UNIT_PAIRS: [string, string][] = [
  ["ដុំ", "pcs"],
  ["កំប៉ុង", "can"],
  ["អាវ", "shirt"],
  ["គូ", "pair"],
  ["ប្រអប់", "box"],
  ["ដប", "bottle"],
  ["កេស", "case"],
  ["pcs", "pcs"],
  ["pc", "pcs"],
  ["pieces", "pcs"],
  ["piece", "pcs"],
  ["box", "box"],
  ["pairs", "pair"],
  ["pair", "pair"],
  ["set", "set"],
  ["sets", "set"],
];

const UNITS: LexiconEntry[] = UNIT_PAIRS.map(([m, v]) =>
  e(m, ["unit"], { value: v, strictKhmerBoundary: true }),
);

const QTY_MARKERS: LexiconEntry[] = ["ចំនួន", "qty", "quantity"].map((m) => e(m, ["qty_marker"]));

const MULTIPLIERS: LexiconEntry[] = ["x", "×"].map((m) => e(m, ["multiplier"]));

const TIME_MARKERS: LexiconEntry[] = [
  "ថ្ងៃនេះ",
  "ថ្ងៃ",
  "ស្អែក",
  "ម៉ោង",
  "today",
  "tomorrow",
  "day",
  "days",
  "hour",
  "hours",
  "week",
].map((m) => e(m, ["time_marker"]));

const SEPARATORS: LexiconEntry[] = [",", "និង", "and", "&", "plus"].map((m) => e(m, ["separator"]));

/** Every entry, in no particular order — the index resolves longest-match. */
export const LEXICON: LexiconEntry[] = [
  ...PARTICLES,
  ...QUESTION_MARKERS,
  ...PURCHASE,
  ...SEND_REQUESTS,
  ...REPEAT,
  ...INTEREST,
  ...STOCK,
  ...WEAK_STOCK,
  ...PRICE,
  ...DISCOUNT,
  ...CURRENCY,
  ...DELIVERY,
  ...DELIVERY_FREE,
  ...ADDRESS,
  ...ADDRESS_MARKERS,
  ...PHONE_MARKERS,
  ...CONFIRM,
  ...CONFIRM_REFS,
  ...NEGATE,
  ...HESITATE,
  ...WEAK_HESITATE,
  ...CHANGE,
  ...PHOTO_REQUEST,
  ...PRODUCT_REFS,
  ...WEAK_PRODUCT_REFS,
  ...COLOR_REFS,
  ...IMAGE_MARKERS,
  ...IMAGE_ORDINALS,
  ...COLORS,
  ...COLOR_MARKERS,
  ...SIZES,
  ...SIZE_MARKERS,
  ...QUANTITIES,
  ...UNITS,
  ...QTY_MARKERS,
  ...MULTIPLIERS,
  ...TIME_MARKERS,
  ...SEPARATORS,
];
