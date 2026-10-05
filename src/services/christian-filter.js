// Terms that are unambiguously Christian on their own. A decisive term in the body text
// is sufficient evidence, so it floors the score at the APPROVED threshold. Deliberately
// excludes ambiguous words such as "tuhan", "god", "doa", "iman", "sorga" or "kasih",
// which are only counted once other signals corroborate them.
//
// "yesus", "jesus", "kristus" and "christ" are intentionally NOT decisive: naming
// Christ alone must not auto-approve a video, because automation-pipeline.test.js
// requires "Yesus Kristus memberkati" + "iman" to stay REVIEW and never publish.
// They contribute weight and rely on corroboration instead.
const DECISIVE_TERMS = [
  'injil',
  'alkitab',
  'bible',
  'roh kudus',
  'holy spirit',
  'kasih karunia',
  'kerajaan sorga',
  'aleluya',
  'haleluya',
  'alleluia',
  'lagu rohani',
  'nyanyian rohani',
  'firman tuhan',
  'firman alleys',
  'ayat alkitab',
  'glory to god',
  'kemuliaan bagi tuhan',
];

const SCRIPTURE_ANCHORS = [
  { term: 'injil', weight: 26 },
  { term: 'alkitab', weight: 26 },
  { term: 'bible', weight: 26 },
  { term: 'firman', weight: 20 },
  { term: 'kasih karunia', weight: 24 },
  { term: 'kerajaan sorga', weight: 24 },
  { term: 'kerajaan surga', weight: 24 },
  { term: 'roh kudus', weight: 24 },
  { term: 'holy spirit', weight: 24 },
  { term: 'firman tuhan', weight: 24 },
  { term: 'ayat alkitab', weight: 24 },
  { term: 'kemuliaan bagi tuhan', weight: 24 },
  { term: 'glory to god', weight: 24 },
  { term: 'aleluya', weight: 24 },
  { term: 'haleluya', weight: 24 },
  { term: 'alleluia', weight: 24 },
];

// Indonesian and English names of the Bible books. These contribute weight, but they are
// not decisive on their own because several of them are also common personal names
// ("daniel", "yohanes", "amos"). They only become decisive through the verse-reference
// pattern below, which requires an explicit chapter/verse number.
const BIBLE_BOOKS = [
  'kejadian', 'keluaran', 'levitikus', 'bilangan', 'ulangan', 'yosua', 'hakim', 'rut',
  'samuel', 'kings', 'kronik', 'ezra', 'nehemia', 'ester', 'ayub', 'mazmur', 'tapuk',
  'kidung', 'kidung agung', 'pengkhydah', 'ratapan', 'yesaya', 'yeremia', 'yehezkiel',
  'daniel', 'hosea', 'yoel', 'amos', 'obadia', 'yunus', 'mikha', 'nahum', 'habakuk',
  'zefanya', 'haggai', 'zakharia', 'malakia', 'matta', 'kisah', 'roma', 'korintus',
  'galatia', 'efesus', 'filipi', 'kolose', 'tesalonika', 'timotius', 'titus', 'filemon',
  'ibrani', 'yakobus', 'petrus', 'yudas', 'wahyu', 'matius', 'mateus', 'markus', 'lukas',
  'yohanes', 'john', 'exodus', 'genesis', 'psalms', 'proverbs', 'revelation',
];

const GOSPEL_BOOKS = [
  { term: 'matius', weight: 24 },
  { term: 'mateus', weight: 24 },
  { term: 'markus', weight: 24 },
  { term: 'lukas', weight: 24 },
  { term: 'yohanes', weight: 24 },
];

const SIGNAL_GROUPS = [
  {
    name: 'person_christ',
    terms: [
      { term: 'yesus', weight: 24 },
      { term: 'jesus', weight: 24 },
      { term: 'kristus', weight: 24 },
      { term: 'christ', weight: 24 },
    ],
  },
  {
    name: 'deity',
    terms: [
      { term: 'tuhan', weight: 14 },
      { term: 'god', weight: 12 },
      { term: 'lord', weight: 12 },
    ],
  },
  {
    name: 'devotional',
    terms: [
      { term: 'renungan', weight: 24 },
      { term: 'khotbah', weight: 24 },
      { term: 'sermon', weight: 24 },
      { term: 'devotional', weight: 24 },
    ],
  },
  {
    name: 'prayer',
    terms: [
      { term: 'doa', weight: 22 },
      { term: 'prayer', weight: 22 },
      { term: 'pray', weight: 14 },
    ],
  },
  {
    name: 'worship',
    terms: [
      { term: 'worship', weight: 24 },
      { term: 'pujian', weight: 18 },
      { term: 'lagu rohani', weight: 24 },
      { term: 'nyanyian rohani', weight: 24 },
    ],
  },
  {
    name: 'church',
    terms: [
      { term: 'gereja', weight: 18 },
      { term: 'church', weight: 18 },
      { term: 'pelayanan gereja', weight: 22 },
      { term: 'pemuda kristen', weight: 22 },
      { term: 'sekolah minggu', weight: 22 },
    ],
  },
  {
    name: 'testimony',
    terms: [
      { term: 'kesaksian', weight: 20 },
      { term: 'testimony', weight: 20 },
      { term: 'testimoni', weight: 20 },
    ],
  },
  {
    name: 'christian_identity',
    terms: [
      { term: 'kristen', weight: 24 },
      { term: 'christian', weight: 24 },
      { term: 'rohani', weight: 16 },
      { term: 'iman', weight: 16 },
      { term: 'kehidupan orang percaya', weight: 22 },
    ],
  },
  {
    name: 'martyrdom',
    terms: [
      { term: 'dianiaya', weight: 12 },
      { term: 'dicela', weight: 12 },
      { term: 'martir', weight: 14 },
    ],
  },
  {
    name: 'generic_terms',
    corroboratedOnly: true,
    terms: [
      { term: 'kasih', weight: 8 },
      { term: 'kebenaran', weight: 8 },
      { term: 'jalan', weight: 8 },
      { term: 'surga', weight: 8 },
      { term: 'sorga', weight: 8 },
      { term: 'keluarga', weight: 8 },
      { term: 'motivasi', weight: 8 },
      { term: 'semangat', weight: 8 },
      { term: 'encouragement', weight: 8 },
      { term: 'kekal', weight: 8 },
    ],
  },
];

const HANDLE_TERMS = [
  { term: 'faithfuel', weight: 8 },
  { term: 'firman kristen', weight: 8 },
];

const SCRIPTURE_REFERENCE_PATTERN = new RegExp(
  `\\b(?:${BIBLE_BOOKS.join('|')})\\s+\\d{1,3}`,
  'g'
);

const DIVERSITY_WEIGHT = 14;
const DIVERSITY_MIN_GROUPS = 2;
const DIVERSITY_MAX_BONUS = 42;
const DECISIVE_FLOOR = 90;
const TITLE_SIGNAL_WORDS = [
  'matius',
  'mateus',
  'markus',
  'lukas',
  'yohanes',
  'injil',
  'alkitab',
  'bible',
  'firman',
  'renungan',
  'khotbah',
  'sermon',
  'kristen',
  'yesus',
  'jesus',
  'kristus',
  'christ',
  'tuhan',
  'iman',
  'rohani',
  'doa',
  'gereja',
  'kesaksian',
  'kasih',
  'karunia',
  'worship',
  'pujian',
  'haleluya',
  'aleluya',
];
const TITLE_MAX_BOOST = 12;
const GENERIC_GROUP = 'generic_terms';
const CORROBORATION_CAP = 60;
const ATTRIBUTION_FACTOR = 0.4;
const ATTRIBUTION_MAX_TOTAL = 12;
const GENERIC_WITHOUT_CORROBORATION_CAP = 24;

const CATEGORY_KEYWORDS = {
  BIBLE: ['alkitab', 'bible', 'injil', 'matius', 'mateus', 'markus', 'lukas', 'yohanes', 'ayat', 'firman tuhan'],
  DEVOTIONAL: ['kasih karunia', 'renungan', 'devotional', 'firman', 'ayat alkitab'],
  PRAYER: ['doa', 'prayer', 'pray', 'doa kristen'],
  SERMON: ['khotbah', 'sermon', 'renungan', 'firman'],
  WORSHIP: ['lagu rohani', 'pujian', 'worship', 'nyanyian rohani'],
  TESTIMONY: ['kesaksian', 'testimony', 'testimoni'],
  CHRISTIAN_MOTIVATION: ['motivasi iman', 'penguatan iman', 'faith', 'semangat', 'encouragement', 'daniaya'],
  CHRISTIAN_EDUCATION: ['edukasi kristen', 'sekolah minggu', 'pemuda kristen'],
  CHURCH: ['gereja', 'pelayanan gereja', 'church'],
  YOUTH: ['pemuda kristen', 'youth'],
  SUNDAY_SCHOOL: ['sekolah minggu', 'sunday school'],
  FAMILY: ['keluarga kristen', 'family'],
  OTHER_CHRISTIAN: ['kristen', 'rohani', 'yesus', 'tuhan', 'kristus'],
};

function normalizeText(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
}

function collectTerms(text) {
  const hits = [];
  const push = (group, term, weight, decisive = false) => {
    hits.push({ group, term, weight, decisive });
  };

  for (const anchor of SCRIPTURE_ANCHORS) {
    if (text.includes(anchor.term)) {
      push('scripture_anchor', anchor.term, anchor.weight, DECISIVE_TERMS.includes(anchor.term));
    }
  }

  for (const book of GOSPEL_BOOKS) {
    if (text.includes(book.term)) {
      push('gospel_book', book.term, book.weight, false);
    }
  }

  const references = new Set();
  for (const match of text.matchAll(SCRIPTURE_REFERENCE_PATTERN)) {
    const reference = match[0].replace(/\s+/g, ' ');
    if (references.has(reference)) continue;
    references.add(reference);
    push('scripture_reference', reference, 28, true);
  }

  for (const group of SIGNAL_GROUPS) {
    for (const entry of group.terms) {
      if (text.includes(entry.term)) {
        push(group.name, entry.term, entry.weight, DECISIVE_TERMS.includes(entry.term));
      }
    }
  }

  for (const handle of HANDLE_TERMS) {
    if (text.includes(handle.term)) {
      push('handle', handle.term, handle.weight, false);
    }
  }

  return hits;
}

function dropContainedTerms(hits) {
  const byLength = [...hits].sort((a, b) => b.term.length - a.term.length);
  const kept = [];
  const consumedTerms = [];

  for (const hit of byLength) {
    const suppressing = consumedTerms.find(
      (longer) =>
        longer.term.includes(hit.term) &&
        (longer.group === hit.group || hit.group === GENERIC_GROUP)
    );
    if (suppressing) continue;
    kept.push(hit);
    consumedTerms.push(hit);
  }

  return kept;
}

function sumGroupWeight(hits, group) {
  return hits
    .filter((hit) => hit.group === group)
    .slice(0, 2)
    .reduce((total, hit) => total + hit.weight, 0);
}

export function scoreChristianContent({ title = '', description = '', author = '', username = '' } = {}) {
  const bodyText = normalizeText(`${title} ${description}`);
  const attributionText = normalizeText(`${author} ${username}`);

  const bodyHits = dropContainedTerms(collectTerms(bodyText));
  const attributionHits = dropContainedTerms(collectTerms(attributionText))
    .map((hit) => ({ ...hit, weight: Math.round(hit.weight * ATTRIBUTION_FACTOR) }))
    .slice(0, 2);

  const hits = [...bodyHits, ...attributionHits];

  const anchorGroups = new Set(
    hits.filter((hit) => ['scripture_anchor', 'gospel_book', 'scripture_reference'].includes(hit.group)).map((hit) => hit.group)
  );
  const strongGroups = new Set(
    hits.filter((hit) => hit.group !== GENERIC_GROUP && hit.group !== 'handle').map((hit) => hit.group)
  );

  const isCorroborated = anchorGroups.size > 0 || strongGroups.size >= 2;
  const genericHits = hits.filter((hit) => hit.group === GENERIC_GROUP);
  const countedHits = hits.filter((hit) => {
    if (hit.group !== GENERIC_GROUP) return true;
    return isCorroborated;
  });

  let score = 0;
  const perGroup = new Map();
  for (const hit of countedHits) {
    if (!perGroup.has(hit.group)) perGroup.set(hit.group, []);
    perGroup.get(hit.group).push(hit);
  }
  for (const groupHits of perGroup.values()) {
    score += sumGroupWeight(groupHits, groupHits[0].group);
  }

  const attributionTotal = attributionHits.reduce((total, hit) => total + hit.weight, 0);
  const appliedAttribution = Math.min(attributionTotal, ATTRIBUTION_MAX_TOTAL);
  score -= attributionTotal - appliedAttribution;

  const diversityGroups = new Set(
    countedHits.filter((hit) => hit.group !== 'handle').map((hit) => hit.group)
  );
  const diversityBonus = Math.min(
    Math.max(diversityGroups.size - DIVERSITY_MIN_GROUPS, 0) * DIVERSITY_WEIGHT,
    DIVERSITY_MAX_BONUS
  );
  score += diversityBonus;

  let titleBoost = 0;
  const titleWords = new Set(normalizeText(title).split(/\s+/).filter((word) => word.length > 2));
  for (const word of titleWords) {
    if (TITLE_SIGNAL_WORDS.includes(word)) titleBoost += 6;
  }
  titleBoost = Math.min(titleBoost, TITLE_MAX_BOOST);
  score += titleBoost;

  let clampedScore = Math.min(Math.max(Math.round(score), 0), 100);

  if (!isCorroborated) {
    clampedScore = Math.min(clampedScore, CORROBORATION_CAP);
  }
  if (anchorGroups.size === 0 && genericHits.length > 0 && strongGroups.size === 0) {
    clampedScore = Math.min(clampedScore, GENERIC_WITHOUT_CORROBORATION_CAP);
  }

  // A decisive term is corroboration on its own, so it is applied after the caps above.
  const hasDecisiveSignal = bodyHits.some((hit) => hit.decisive);
  if (hasDecisiveSignal) {
    clampedScore = Math.max(clampedScore, DECISIVE_FLOOR);
  }

  let subcategory = 'OTHER_CHRISTIAN';
  for (const [candidate, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => bodyText.includes(keyword))) {
      subcategory = candidate;
      break;
    }
  }

  let status = 'SKIPPED';
  let reason = 'Tidak ada sinyal konten Kristen yang cukup kuat.';

  if (clampedScore >= 90) {
    status = 'APPROVED';
    reason = 'Konten sangat relevan dengan iman Kristen.';
  } else if (clampedScore >= 70) {
    status = 'REVIEW';
    reason = 'Konten relevan, tetapi memerlukan penilaian manusia untuk kepercayaan.';
  } else if (clampedScore > 0) {
    reason = 'Konten tidak menunjukkan relevansi kristiani yang cukup.';
  }

  return {
    score: clampedScore,
    status,
    category: 'christian',
    subcategory,
    filterReason: reason,
    matches: hits,
    signals: {
      corroborated: isCorroborated,
      anchor_groups: [...anchorGroups],
      strong_groups: [...strongGroups],
      diversity_groups: diversityGroups.size,
      diversity_bonus: diversityBonus,
      title_boost: titleBoost,
      attribution_weight: Math.min(attributionTotal, ATTRIBUTION_MAX_TOTAL),
      decisive_terms: bodyHits.filter((hit) => hit.decisive).map((hit) => hit.term),
    },
  };
}

export function classifyContent(metadata = {}) {
  const result = scoreChristianContent(metadata);

  return {
    category: result.category,
    subcategory: result.subcategory,
    score: result.score,
    status: result.status,
    filter_reason: result.filterReason,
    matches: result.matches,
    signals: result.signals,
  };
}