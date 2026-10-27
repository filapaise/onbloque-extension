export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString('fr-FR');
  }
}

export function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = ts - Date.now();
  if (diff <= 5_000) return 'Maintenant';
  const s = Math.round(diff / 1000);
  if (s < 60) return `dans ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `dans ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `dans ${h} h`;
  return fmtTime(ts);
}
