import { useMemo, useState } from "react";
import { toast } from "sonner";
import { submitSession, UnauthorizedError } from "@/lib/api";
import type {
  ProgramItem,
  LogSessionExercise,
  LogSessionSide,
  Side,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Per-side entry state: whether it was completed and the free-text note.
type SideState = { completed: boolean; rawNote: string };
type FormState = Record<string, Partial<Record<Side, SideState>>>;

function sidesFor(item: ProgramItem): Side[] {
  return item.perSide ? ["left", "right"] : ["n-a"];
}

function todayLocalISO(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}

export function LogSession({
  programItems,
  onUnauthorized,
}: {
  programItems: ProgramItem[];
  onUnauthorized: () => void;
}) {
  const [sessionDate, setSessionDate] = useState(todayLocalISO());
  const [pain, setPain] = useState(0);
  const [stiffness, setStiffness] = useState(0);
  const [confidence, setConfidence] = useState(5);
  const [submitting, setSubmitting] = useState(false);

  // Group active exercises by section, preserving order of first appearance.
  const sections = useMemo(() => {
    const map = new Map<string, ProgramItem[]>();
    for (const item of programItems) {
      if (!map.has(item.section)) map.set(item.section, []);
      map.get(item.section)!.push(item);
    }
    return [...map.entries()];
  }, [programItems]);

  // Initialise every side to not-completed / empty note.
  const [form, setForm] = useState<FormState>(() => {
    const init: FormState = {};
    for (const item of programItems) {
      init[item.exerciseId] = {};
      for (const side of sidesFor(item)) {
        init[item.exerciseId][side] = { completed: false, rawNote: "" };
      }
    }
    return init;
  });

  function updateSide(exerciseId: string, side: Side, patch: Partial<SideState>) {
    setForm((prev) => ({
      ...prev,
      [exerciseId]: {
        ...prev[exerciseId],
        [side]: { ...prev[exerciseId]?.[side], ...patch } as SideState,
      },
    }));
  }

  async function handleSubmit() {
    // Only include exercises where at least one side was touched (completed or
    // has a note) — a fully-untouched exercise isn't part of this session log.
    const completedExercises: LogSessionExercise[] = [];
    for (const item of programItems) {
      const sides: Partial<Record<Side, LogSessionSide>> = {};
      let include = false;
      for (const side of sidesFor(item)) {
        const s = form[item.exerciseId]?.[side];
        if (!s) continue;
        const note = s.rawNote.trim();
        if (s.completed || note) include = true;
        sides[side] = { completed: s.completed, rawNote: note };
      }
      if (include) completedExercises.push({ exerciseId: item.exerciseId, sides });
    }

    if (completedExercises.length === 0) {
      toast.error("Nothing to log — check at least one exercise or add a note.");
      return;
    }

    setSubmitting(true);
    try {
      await submitSession({
        sessionDate,
        completedExercises,
        painRating: pain,
        stiffnessRating: stiffness,
        confidenceRating: confidence,
      });
      toast.success("Session logged.");
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      toast.error(err instanceof Error ? err.message : "Failed to log session.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Session date</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            type="date"
            value={sessionDate}
            max={todayLocalISO()}
            onChange={(e) => setSessionDate(e.target.value)}
            className="w-48"
          />
        </CardContent>
      </Card>

      {sections.map(([section, items]) => (
        <Card key={section}>
          <CardHeader>
            <CardTitle>{section}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {items.map((item) => (
              <div key={item.exerciseId} className="flex flex-col gap-3">
                <div>
                  <div className="font-medium">{item.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {item.targetSets} × {item.targetReps}
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {sidesFor(item).map((side) => {
                    const s = form[item.exerciseId]?.[side];
                    const cbId = `${item.exerciseId}-${side}`;
                    return (
                      <div
                        key={side}
                        className="flex flex-col gap-2 rounded-md border p-3"
                      >
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={cbId}
                            checked={s?.completed ?? false}
                            onCheckedChange={(v) =>
                              updateSide(item.exerciseId, side, {
                                completed: v === true,
                              })
                            }
                          />
                          <Label htmlFor={cbId} className="capitalize">
                            {side === "n-a" ? "Completed" : `${side} completed`}
                          </Label>
                        </div>
                        <Textarea
                          placeholder="Notes (pain, stiffness, how it felt)…"
                          value={s?.rawNote ?? ""}
                          onChange={(e) =>
                            updateSide(item.exerciseId, side, {
                              rawNote: e.target.value,
                            })
                          }
                          rows={2}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>How did it feel? (0–10)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-8">
          <RatingSlider label="Pain" value={pain} onChange={setPain} />
          <RatingSlider label="Stiffness" value={stiffness} onChange={setStiffness} />
          <RatingSlider label="Confidence" value={confidence} onChange={setConfidence} />
        </CardContent>
      </Card>

      <Button size="lg" onClick={handleSubmit} disabled={submitting}>
        {submitting ? "Logging…" : "Log session"}
      </Button>
    </div>
  );
}

function RatingSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-sm tabular-nums text-muted-foreground">{value}</span>
      </div>
      <Slider
        min={0}
        max={10}
        step={1}
        value={[value]}
        onValueChange={(v: number | readonly number[]) =>
          onChange(Array.isArray(v) ? v[0] : (v as number))
        }
      />
    </div>
  );
}
