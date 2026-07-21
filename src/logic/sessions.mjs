// Shared session-shape predicates. The definition of a "performed instance" is
// the denominator for BOTH the asymmetry counts and the escalation counts, so
// it lives here once — a single completed-flag rule that can't drift between
// the two paths if the shape or the rule ever changes.

// True only when this side of an exercise was actually performed. A logged-but-
// skipped side (present in completedExercises but completed:false) is not a
// "time performed" and must never count toward a denominator.
export function isPerformed(sideObj) {
  return Boolean(sideObj) && sideObj.completed === true;
}
