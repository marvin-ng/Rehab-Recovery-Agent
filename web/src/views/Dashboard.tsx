import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import type {
  Adherence,
  AsymmetryResult,
  Escalation,
  TrendMetric,
  RecentSession,
} from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const chartConfig = {
  painRating: { label: "Pain", color: "var(--series-pain)" },
  stiffnessRating: { label: "Stiffness", color: "var(--series-stiffness)" },
  confidenceRating: { label: "Confidence", color: "var(--series-confidence)" },
} satisfies ChartConfig;

export function Dashboard({
  adherence,
  asymmetryResults,
  escalations,
  trend,
  recentSessions,
}: {
  adherence: Adherence;
  asymmetryResults: AsymmetryResult[];
  escalations: Escalation[];
  trend: TrendMetric[];
  recentSessions: RecentSession[];
}) {
  // Chart data in chronological order (recentSessions is newest-first).
  const chartData = useMemo(
    () =>
      [...recentSessions]
        .reverse()
        .map((s) => ({
          sessionDate: s.sessionDate,
          painRating: s.painRating,
          stiffnessRating: s.stiffnessRating,
          confidenceRating: s.confidenceRating,
        })),
    [recentSessions]
  );

  const flagged = asymmetryResults.filter((r) => r.status === "flagged");
  const hasAnyRealData = recentSessions.length > 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Adherence */}
      <Card>
        <CardHeader>
          <CardTitle>Weekly adherence</CardTitle>
          <CardDescription>Target: 3–4 sessions/week</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <span className="text-4xl font-semibold tabular-nums">
            {adherence.sessionCount}
          </span>
          <span className="text-muted-foreground">sessions in the last 7 days</span>
          <Badge
            className="ml-auto"
            variant={adherence.onTarget ? "default" : "secondary"}
          >
            {adherence.onTarget ? "On target" : "Below target"}
          </Badge>
        </CardContent>
      </Card>

      {/* Escalations — verbatim observation + question */}
      <Card>
        <CardHeader>
          <CardTitle>Flags to bring up with your physio</CardTitle>
        </CardHeader>
        <CardContent>
          {escalations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No flagged concerns.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {escalations.map((e, i) => (
                <li key={i} className="rounded-md border p-3 text-sm">
                  {/* Rendered verbatim — never restyled or paraphrased. */}
                  <p>{e.observation}</p>
                  <p className="mt-1 text-muted-foreground">{e.question}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Asymmetry */}
      <Card>
        <CardHeader>
          <CardTitle>Side asymmetry</CardTitle>
          <CardDescription>
            Single-leg exercises, moderate-or-higher instances over ~30 days
          </CardDescription>
        </CardHeader>
        <CardContent>
          {flagged.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {flagged.map((r) => (
                <li key={r.exerciseId} className="rounded-md border p-3 text-sm">
                  <span className="font-medium">{r.exerciseName}</span>:{" "}
                  <span className="capitalize">{r.side}</span> side flagged (
                  {r.side === "left" ? r.leftCount : r.rightCount} of{" "}
                  {r.side === "left" ? r.leftTotal : r.rightTotal})
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not enough data yet to compare sides — needs a few more logged
              sessions per side.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Trend chart + narratives */}
      <Card>
        <CardHeader>
          <CardTitle>Ratings over time</CardTitle>
          <CardDescription>Last two weeks vs the prior two</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {hasAnyRealData ? (
            <ChartContainer config={chartConfig} className="h-[260px] w-full">
              <LineChart data={chartData} margin={{ left: 4, right: 12, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="sessionDate"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  domain={[0, 10]}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Line
                  dataKey="painRating"
                  stroke="var(--color-painRating)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  connectNulls
                />
                <Line
                  dataKey="stiffnessRating"
                  stroke="var(--color-stiffnessRating)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  connectNulls
                />
                <Line
                  dataKey="confidenceRating"
                  stroke="var(--color-confidenceRating)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  connectNulls
                />
              </LineChart>
            </ChartContainer>
          ) : (
            <p className="text-sm text-muted-foreground">
              No sessions logged yet — the chart will fill in as you log.
            </p>
          )}
          <ul className="flex flex-col gap-1 text-sm">
            {trend.map((t) => (
              <li key={t.metric} className="text-muted-foreground">
                {t.direction === "insufficient_data"
                  ? `${chartConfig[t.metric].label}: not enough data yet to compare.`
                  : t.narrative}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Session history */}
      <Card>
        <CardHeader>
          <CardTitle>Session history</CardTitle>
        </CardHeader>
        <CardContent>
          {recentSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sessions in the last 60 days.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Pain</TableHead>
                    <TableHead className="text-right">Stiffness</TableHead>
                    <TableHead className="text-right">Confidence</TableHead>
                    <TableHead className="text-right">Done</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentSessions.map((s) => {
                    const notes = s.exercises
                      .flatMap((ex) =>
                        Object.entries(ex.sides)
                          .filter(([, v]) => v?.rawNote?.trim())
                          .map(([side, v]) =>
                            side === "n-a"
                              ? `${ex.exerciseId}: ${v!.rawNote}`
                              : `${ex.exerciseId} (${side}): ${v!.rawNote}`
                          )
                      )
                      .join(" · ");
                    const done = s.exercises.reduce(
                      (n, ex) =>
                        n +
                        Object.values(ex.sides).filter((v) => v?.completed).length,
                      0
                    );
                    return (
                      <TableRow key={s.sessionDate}>
                        <TableCell className="font-medium">{s.sessionDate}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {s.painRating}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {s.stiffnessRating}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {s.confidenceRating}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{done}</TableCell>
                        <TableCell className="max-w-xs truncate text-muted-foreground">
                          {notes || "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
