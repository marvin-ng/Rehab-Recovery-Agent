// Shape and helpers for the in-progress Log Session form.
//
// This state deliberately lives in App, NOT inside LogSession. Base UI's Tabs
// unmounts inactive TabsContent, so anything held in LogSession's own useState
// is destroyed the moment you switch to the Dashboard tab and back — silently
// wiping a part-completed session log. See PROJECT_STATUS.md (post-build bug).
import type { ProgramItem, Side } from "./types";

export type SideState = { completed: boolean; rawNote: string };
export type FormState = Record<string, Partial<Record<Side, SideState>>>;

export interface SessionFormState {
  sessionDate: string;
  pain: number;
  stiffness: number;
  confidence: number;
  // Whole-session note, not tied to any one exercise. Lives here (not in
  // LogSession) for the same reason as every other field: it must survive a
  // tab switch. Optional — an empty string means "nothing to add".
  generalNote: string;
  form: FormState;
}

export function sidesFor(item: ProgramItem): Side[] {
  return item.perSide ? ["left", "right"] : ["n-a"];
}

export function todayLocalISO(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}

// Every side of every active exercise starts not-completed with an empty note.
// Seeding all sides up front (rather than filling them in on first touch) is
// what makes an untouched side of a touched exercise persist as an explicit
// `completed: false` — the asymmetry logic reads both sides.
export function emptyForm(programItems: ProgramItem[]): FormState {
  const init: FormState = {};
  for (const item of programItems) {
    init[item.exerciseId] = {};
    for (const side of sidesFor(item)) {
      init[item.exerciseId][side] = { completed: false, rawNote: "" };
    }
  }
  return init;
}

export function emptySessionForm(programItems: ProgramItem[]): SessionFormState {
  return {
    sessionDate: todayLocalISO(),
    pain: 0,
    stiffness: 0,
    confidence: 5,
    generalNote: "",
    form: emptyForm(programItems),
  };
}

// Add rows for any exercise/side the program has gained, without disturbing
// anything already entered. Returns the identical object when nothing is
// missing, so calling it from an effect can't loop.
export function withProgramSeeded(
  state: SessionFormState,
  programItems: ProgramItem[]
): SessionFormState {
  let changed = false;
  const form: FormState = { ...state.form };

  for (const item of programItems) {
    const existing = form[item.exerciseId];
    const next = { ...existing };
    let exerciseChanged = !existing;

    for (const side of sidesFor(item)) {
      if (!next[side]) {
        next[side] = { completed: false, rawNote: "" };
        exerciseChanged = true;
      }
    }

    if (exerciseChanged) {
      form[item.exerciseId] = next;
      changed = true;
    }
  }

  return changed ? { ...state, form } : state;
}
