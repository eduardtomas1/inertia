export function controlHelperCensus(helpers, guardianChildCount) {
  const byGuardian = new Map();
  for (const helper of helpers) {
    const entry = byGuardian.get(helper.target) ?? { admission: [], release: [] };
    if (helper.action === "release") entry.release.push(helper);
    else entry.admission.push(helper);
    byGuardian.set(helper.target, entry);
  }
  let admission = 0;
  let release = 0;
  let handoffs = 0;
  const violations = [];
  for (const [target, entry] of byGuardian) {
    admission += entry.admission.length;
    release += entry.release.length;
    if (entry.release.length === 0) {
      if (entry.admission.length > 1) violations.push({ target, helpers: entry.admission });
      continue;
    }
    const children = guardianChildCount(target);
    const handoff = entry.admission.length === 1
      && entry.admission[0].action === "exec";
    if (
      entry.release.length > 1
      || children !== 0
      || (entry.admission.length > 0 && !handoff)
    ) {
      violations.push({
        target,
        children,
        helpers: [...entry.admission, ...entry.release],
      });
    } else if (handoff) {
      handoffs += 1;
    }
  }
  return { admission, release, handoffs, violations };
}
