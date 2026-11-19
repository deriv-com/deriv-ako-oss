// Release tag names: `<prefix><YYYYMMDD>_<n>`, such as production_v20261102_0.
// The date is when the release opens, so the tag names the build QA tested,
// not the day it was approved.

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function tagPattern(prefix) {
  return new RegExp(`^${escape(prefix)}(\\d{8})_(\\d+)$`);
}

export function dateStamp(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}

/** The next free tag for today, after every name already used by a tag, milestone or release. */
export function nextTag(prefix, taken, now = Date.now()) {
  const pattern = tagPattern(prefix);
  const today = dateStamp(now);
  let next = 0;
  for (const name of taken) {
    const match = String(name).match(pattern);
    if (match && match[1] === today) next = Math.max(next, Number(match[2]) + 1);
  }
  return `${prefix}${today}_${next}`;
}

/** The newest release tag with this prefix, or null. */
export function latestTag(prefix, tags, { before } = {}) {
  const pattern = tagPattern(prefix);
  const order = (name) => {
    const [, date, n] = name.match(pattern);
    return [Number(date), Number(n)];
  };
  const ranked = tags
    .filter((t) => pattern.test(t) && t !== before)
    .sort((a, b) => {
      const [da, na] = order(a);
      const [db, nb] = order(b);
      return db - da || nb - na;
    });
  if (!before || !pattern.test(before)) return ranked[0] ?? null;
  const [bd, bn] = order(before);
  return ranked.find((t) => {
    const [d, n] = order(t);
    return d < bd || (d === bd && n < bn);
  }) ?? null;
}
