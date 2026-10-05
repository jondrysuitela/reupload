const KEYWORD_GROUPS = [
  { name: 'christian', weight: 25, terms: ['kristen', 'christian', 'rohani', 'spiritual'] },
  { name: 'jesus', weight: 24, terms: ['yesus kristus', 'yesus', 'jesus', 'christ'] },
  { name: 'god', weight: 18, terms: ['tuhan', 'god', 'lord'] },
  { name: 'bible', weight: 20, terms: ['alkitab', 'bible', 'ayat alkitab', 'firman tuhan'] },
  { name: 'sermon', weight: 18, terms: ['renungan', 'khotbah', 'sermon', 'devotional', 'firman'] },
  { name: 'prayer', weight: 16, terms: ['doa', 'prayer', 'pray'] },
  { name: 'testimony', weight: 14, terms: ['kesaksian', 'testimony', 'testimoni'] },
  { name: 'worship', weight: 16, terms: ['pujian', 'worship', 'lagu rohani', 'nyanyian rohani'] },
  { name: 'faith', weight: 16, terms: ['kasih karunia', 'karunia', 'faithfuel', 'iman kristen', 'faith', 'motivasi iman', 'penguatan iman', 'kehidupan orang percaya'] },
  { name: 'church', weight: 12, terms: ['gereja', 'church', 'pelayanan gereja', 'pemuda kristen', 'sekolah minggu'] },
  { name: 'family', weight: 10, terms: ['keluarga kristen', 'family'] },
  { name: 'encouragement', weight: 12, terms: ['encouragement', 'semangat', 'motivasi', 'penguatan'] },
];

function normalizeText(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
}

const PHRASE_BOOSTS = [
  { term: 'kasih karunia', weight: 38 },
  { term: 'faithfuel', weight: 30 },
  { term: 'yesus kristus', weight: 28 },
  { term: 'firman tuhan', weight: 26 },
  { term: 'renungan kristen', weight: 24 },
  { term: 'lagu rohani', weight: 22 },
  { term: 'doa kristen', weight: 24 },
  { term: 'worship', weight: 18 },
  { term: 'khotbah', weight: 18 },
  { term: 'iman kristen', weight: 22 },
  { term: 'doa', weight: 16 },
];

const CATEGORY_KEYWORDS = {
  DEVOTIONAL: ['kasih karunia', 'renungan', 'devotional', 'devotional', 'firmana', 'firman'],
  BIBLE: ['alkitab', 'ayat alkitab', 'bible', 'firman tuhan'],
  PRAYER: ['doa', 'prayer', 'pray', 'doa kristen'],
  SERMON: ['khotbah', 'sermon', 'renungan', 'firman'],
  WORSHIP: ['lagu rohani', 'pujian', 'worship', 'nyanyian rohani'],
  TESTIMONY: ['kesaksian', 'testimony', 'testimoni'],
  CHRISTIAN_MOTIVATION: ['motivasi iman', 'penguatan iman', 'faith', 'semangat', 'encouragement'],
  CHRISTIAN_EDUCATION: ['edukasi kristen', 'sekolah minggu', 'pemuda kristen', 'gereja'],
  CHURCH: ['gereja', 'pelayanan gereja', 'church'],
  YOUTH: ['pemuda kristen', 'youth'],
  SUNDAY_SCHOOL: ['sekolah minggu', 'sunday school'],
  FAMILY: ['keluarga kristen', 'family'],
  OTHER_CHRISTIAN: ['kristen', 'rohani', 'yesus', 'tuhan'],
};

export function scoreChristianContent({ title = '', description = '', author = '', username = '' } = {}) {
  const sourceText = normalizeText(`${title} ${description} ${author} ${username}`);
  const hits = [];
  let score = 0;

  for (const boost of PHRASE_BOOSTS) {
    if (sourceText.includes(boost.term)) {
      score += boost.weight;
      hits.push({ group: 'phrase', term: boost.term, weight: boost.weight });
    }
  }

  for (const group of KEYWORD_GROUPS) {
    const matches = group.terms.filter((term) => sourceText.includes(term));
    if (matches.length) {
      const matchedWeight = Math.min(matches.length, 2) * group.weight;
      score += matchedWeight;
      for (const term of matches.slice(0, 2)) {
        hits.push({ group: group.name, term, weight: group.weight });
      }
    }
  }

  const titleHits = normalizeText(title)
    .split(/\s+/)
    .filter((word) => word.length > 3 && ['kristen', 'yesus', 'tuhan', 'alkitab', 'khotbah', 'doa', 'worship', 'gereja', 'iman', 'rohani', 'firman', 'karunia', 'kasih', 'faithfuel'].includes(word));

  if (titleHits.length) {
    score += Math.min(titleHits.length * 6, 18);
  }

  const clampedScore = Math.min(Math.max(score, 0), 100);

  let subcategory = 'OTHER_CHRISTIAN';
  for (const [candidate, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => sourceText.includes(keyword))) {
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
  };
}
