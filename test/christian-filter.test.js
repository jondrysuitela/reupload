import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyContent, scoreChristianContent } from '../src/services/christian-filter.js';
import { shouldAllowPublish } from '../src/services/publisher.js';

// Metadata below was captured verbatim from the production TikTok source with
// yt-dlp --dump-single-json. Strings are kept byte-exact on purpose: the description
// of the target video embeds Unicode bidi control characters around the verse
// reference, so normalizeText has to survive that formatting for "matius" to match.
const TARGET_VIDEO_ID = '7655349848044080402';
const TARGET_TITLE = "“Berbahagialah orang yang dianiaya oleh sebab kebenaran, karena merek...";
const TARGET_DESCRIPTION = "“Berbahagialah orang yang dianiaya oleh sebab kebenaran, karena merekalah yang empunya Kerajaan Sorga. Berbahagialah kamu, jika karena Aku kamu dicela dan dianiaya dan kepadamu difitnahkan segala yang jahat. - Matius‬ ‭5‬:‭10‬-‭11‬ @FaithFuel ";
const TARGET_METADATA = {
  title: TARGET_TITLE,
  description: TARGET_DESCRIPTION,
  author: "wiwelgeng",
  username: "wiwelgeng",
};

// Real non-Christian metadata from the same account, so the negatives are not invented.
const NON_CHRISTEN_FIXTURES = [
  {
    video_id: '7684911335838141714',
    title: "Ada benernya juga si tukang servis, upgrade ke Lenovo Legion 5i = pay...",
    description: "Ada benernya juga si tukang servis, upgrade ke Lenovo Legion 5i = pay to win",
  },
  {
    video_id: '7680862775735930119',
    title: "Ternyata selama ini masalahnya.. saya sendiri🗿 @MyRepublic Indonesia ",
    description: "Ternyata selama ini masalahnya.. saya sendiri🗿 @MyRepublic Indonesia ",
  },
  {
    video_id: '7656836781807013127',
    title: "dulu aku suka pake kata-kata ini  biar keliatan berhikmat, padahal ka...",
    description: "dulu aku suka pake kata-kata ini  biar keliatan berhikmat, padahal kadang emang imanku aja ternyata yang kureng kuat🗿 @FaithFuel ",
  },
  {
    video_id: '7650155717168712981',
    title: "Tiap hari selalu ada topik baru😂🤍",
    description: "Tiap hari selalu ada topik baru😂🤍",
  },
];

test('regression: Matius 5:10-11 target video is recognized as APPROVED Christian content', () => {
  const result = scoreChristianContent(TARGET_METADATA);

  assert.equal(result.status, 'APPROVED');
  assert.ok(
    result.score >= 90,
    `expected christian_score >= 90 for ${TARGET_VIDEO_ID}, received ${result.score}`
  );
  assert.equal(result.filterReason, 'Konten sangat relevan dengan iman Kristen.');
});

test('regression: the target video is not hardcoded by video_id and scores from text alone', () => {
  const withoutHandle = scoreChristianContent({
    ...TARGET_METADATA,
    description: TARGET_DESCRIPTION.replace('@FaithFuel', ''),
  });
  const unrelatedAuthor = scoreChristianContent({
    ...TARGET_METADATA,
    author: 'chef_rehan',
    username: 'chef_rehan',
  });
  const bodyOnly = scoreChristianContent({
    title: TARGET_TITLE,
    description: TARGET_DESCRIPTION.replace('@FaithFuel', ''),
  });

  assert.equal(withoutHandle.status, 'APPROVED');
  assert.equal(unrelatedAuthor.status, 'APPROVED');
  assert.equal(bodyOnly.status, 'APPROVED');
});

test('regression: a single account handle cannot carry a video over the APPROVED threshold', () => {
  const handleOnly = scoreChristianContent({
    title: 'Video lucu parah',
    description: 'LMAO ini lucu bgt @FaithFuel',
    username: 'faithfuel',
  });

  assert.equal(handleOnly.status, 'SKIPPED');
  assert.ok(handleOnly.score < 90);
  assert.ok(handleOnly.score <= 24, `handle contribution must stay minimal, received ${handleOnly.score}`);
});

test('regression: real non-Christian videos from the source account stay SKIPPED', () => {
  for (const fixture of NON_CHRISTEN_FIXTURES) {
    const result = scoreChristianContent({
      title: fixture.title,
      description: fixture.description,
      author: 'wiwelgeng',
      username: 'wiwelgeng',
    });

    assert.equal(
      result.status,
      'SKIPPED',
      `expected SKIPPED for non-Christian video ${fixture.video_id}, received ${result.status} with score ${result.score}`
    );
    assert.ok(result.score < 90, `video ${fixture.video_id} must stay below the APPROVED gate`);
  }
});

test('regression: SKIPPED videos are still blocked by the publisher gate', () => {
  const blocked = shouldAllowPublish({
    job_id: 'job-skipped',
    filter_status: 'SKIPPED',
    status: 'SKIPPED',
  });

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.status, 'SKIPPED');
  assert.match(blocked.reason, /filtered out/i);
});

test('generic words standing alone do not create false positives', () => {
  for (const word of ['Kasih', 'Jalan', 'Kebenaran', 'Tuhan', 'Surga', 'Iman', 'Sorga']) {
    const result = scoreChristianContent({ title: word, description: word });

    assert.equal(
      result.status,
      'SKIPPED',
      `standalone generic word "${word}" must not be classified as Christian content`
    );
    assert.ok(result.score < 70);
  }
});

test('corroboration is required before generic terms contribute any score', () => {
  const uncorroborated = scoreChristianContent({
    title: 'Kasih dan kebenaran',
    description: 'Jalan menuju surga',
  });
  const corroborated = scoreChristianContent({
    title: 'Kasih karunia Tuhan',
    description: 'Renungan tentang kasih karunia',
  });

  assert.equal(uncorroborated.status, 'SKIPPED');
  assert.equal(corroborated.status, 'APPROVED');
});

test('an explicit Bible citation is decisive and reaches APPROVED', () => {
  const citations = [
    'Matius 5:10-11 tentang orang yang dianiaya demi kebenaran',
    'Markus 4:35 tentang mukjizat di atas laut',
    'Lukas 2:14 tentang kelahiran Tuhan',
    'Yohanes 3:16 tentang karunia keselamatan',
    'Roma 12:2 tentang pembaharuan budi',
    'Mazmur 37:24 tentang Tuhan menopang',
  ];

  for (const text of citations) {
    const result = scoreChristianContent({ title: text });
    assert.equal(
      result.status,
      'APPROVED',
      `expected the citation "${text}" to be decisive, received ${result.status} with score ${result.score}`
    );
    assert.ok(result.matches.some((match) => match.group === 'scripture_reference' && match.decisive));
  }
});

test('decisive vocabulary outside citations is also enough for APPROVED', () => {
  const decisiveTexts = [
    'Ayat Alkitab hari ini dari Roh Kudus',
    'Semua karena kasih karunia-Nya',
    'Haleluya! Glory to God',
  ];

  for (const text of decisiveTexts) {
    const result = scoreChristianContent({ title: text });
    assert.equal(
      result.status,
      'APPROVED',
      `expected "${text}" to be decisive, received ${result.status} with score ${result.score}`
    );
  }
});

test('a bare Bible book name or Christ mention stays conservative and never auto-approves', () => {
  // "Markus" is also a common personal name and "Yesus" alone carries no corroboration,
  // so neither may reach APPROVED without a citation or another strong signal.
  const conservativeTexts = [
    'Markus tentang mukjizat di atas laut',
    'Kesaksian dari pelayan Tuhan di sorga',
    'Yesus Kristus memberkati kita',
    'Tuhan kita setia',
  ];

  for (const text of conservativeTexts) {
    const result = scoreChristianContent({ title: text });
    assert.notEqual(
      result.status,
      'APPROVED',
      `expected "${text}" to stay below the APPROVED gate, received ${result.status} with score ${result.score}`
    );
  }
});

test('a term is never counted twice through both an anchor and a broader group', () => {
  const grace = scoreChristianContent({
    title: 'Kasih karunia',
    description: 'Kasih karunia Tuhan',
  });

  const matchedTerms = grace.matches.map((match) => match.term);
  assert.ok(matchedTerms.includes('kasih karunia'));
  assert.ok(
    !matchedTerms.includes('kasih'),
    'the generic term "kasih" must be suppressed when "kasih karunia" already matched'
  );
  assert.ok(
    !matchedTerms.includes('sorga'),
    'the generic term "sorga" must be suppressed when "kerajaan sorga" already matched'
  );
});

test('independent signal groups score higher than repeated matches within one group', () => {
  const oneGroupRepeated = scoreChristianContent({
    title: 'Doa doa doa',
    description: 'Doa dan doa lagi',
  });
  const multipleGroups = scoreChristianContent({
    title: 'Renungan dan kesaksian',
    description: 'Gereja dan pujian',
  });

  assert.ok(
    multipleGroups.score > oneGroupRepeated.score,
    `diverse signals (${multipleGroups.score}) must outscore one repeated group (${oneGroupRepeated.score})`
  );
});

test('classifyContent exposes the signals used for the decision', () => {
  const result = classifyContent(TARGET_METADATA);

  assert.equal(result.category, 'christian');
  assert.equal(result.status, 'APPROVED');
  assert.ok(result.score >= 90);
  assert.ok(result.signals.corroborated);
  assert.ok(result.signals.anchor_groups.includes('scripture_reference'));
  assert.ok(result.signals.diversity_groups >= 2);
});
