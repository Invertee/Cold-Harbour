export function localParts(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23', weekday:'short' }).formatToParts(date).filter(p => p.type !== 'literal').map(p=>[p.type,p.value]));
}
export function localDate(date, timezone) { const p = localParts(date,timezone); return `${p.year}-${p.month}-${p.day}`; }
export function dayStart(day, timezone) {
  const target = Date.parse(`${day}T00:00:00Z`);
  let guess = target;
  for (let i=0;i<4;i++) {
    const p = localParts(new Date(guess),timezone);
    const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    const diff = target-represented;
    guess += diff;
    if (!diff) break;
  }
  return guess;
}
export function shiftDay(day, amount) { return new Date(Date.parse(`${day}T12:00:00Z`) + amount*86400000).toISOString().slice(0,10); }
export function periodRange(period, now, timezone) {
  const today = localDate(new Date(now),timezone);
  const day = period === 'yesterday' ? shiftDay(today,-1) : period === 'week' ? shiftDay(today,-6) : today;
  return { start: dayStart(day,timezone), end: period === 'yesterday' ? dayStart(today,timezone) : now, dayEnd:dayStart(shiftDay(today,1),timezone), day, today };
}
