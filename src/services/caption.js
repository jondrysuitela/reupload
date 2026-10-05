export function generateCaption({ title = '', author = '', source = '', category = 'christian', score } = {}) {
  const cleanTitle = String(title || '').trim();
  const safeTitle = cleanTitle.length > 120 ? `${cleanTitle.slice(0, 117)}...` : cleanTitle;
  const opening = safeTitle ? `${safeTitle}\n\n` : '';
  const sourceName = source || author;
  const footer = '\n\nSemua karena kasih karunia-Nya. 🙏✨\n\n#JemaatGPMSuli #Renungan #ImanKristen';

  if (category !== 'christian' || (Number.isFinite(Number(score)) && Number(score) < 90)) {
    return `Konten ini tidak memenuhi kriteria untuk dipublikasikan sebagai materi rohani Kristen.\n\n#JemaatGPMSuli`;
  }

  return `${opening}Semoga renungan ini menguatkan iman dan membawa kedamaian dalam hati. ${sourceName ? `\n\nSumber: @${String(sourceName).replace(/^@/, '')}` : ''}${footer}`;
}

export function getDefaultTags() {
  return ['#JemaatGPMSuli', '#Renungan', '#ImanKristen', '#FirmanTuhan'];
}
