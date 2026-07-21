// Shapes returned by rehab-dashboard-data (see src/dashboard-data/handler.mjs)
// and consumed by rehab-log-session. Kept in sync with the backend by hand.

export type Side = "left" | "right" | "n-a";

export interface ProgramItem {
  exerciseId: string;
  name: string;
  section: string;
  targetSets: string;
  targetReps: string;
  perSide: boolean;
  cues?: string;
  status: string;
}

export interface Adherence {
  sessionCount: number;
  onTarget: boolean;
}

export interface AsymmetryResult {
  exerciseId: string;
  exerciseName: string;
  leftCount: number;
  rightCount: number;
  leftTotal: number;
  rightTotal: number;
  status: "insufficient_data" | "no_pattern" | "flagged";
  side?: "left" | "right";
  symptomType?: string;
}

export interface Escalation {
  type: "symptom_flag" | "asymmetry";
  exerciseId: string;
  side: Side;
  observation: string;
  question: string;
}

export interface TrendMetric {
  metric: "painRating" | "stiffnessRating" | "confidenceRating";
  direction: "improving" | "worsening" | "plateauing" | "insufficient_data";
  recentAvg?: number;
  priorAvg?: number;
  delta?: number;
  narrative: string;
}

export interface SessionTag {
  symptomType?: string;
  severity?: string;
  flagForReview?: boolean;
}

export interface RecentSessionSide {
  completed: boolean;
  rawNote: string;
  tags: SessionTag[];
}

export interface RecentSession {
  sessionDate: string;
  painRating: number;
  stiffnessRating: number;
  confidenceRating: number;
  exercises: Array<{
    exerciseId: string;
    sides: Partial<Record<Side, RecentSessionSide>>;
  }>;
}

export interface DashboardPayload {
  asOfDate: string;
  adherence: Adherence;
  asymmetryResults: AsymmetryResult[];
  escalations: Escalation[];
  trend: TrendMetric[];
  recentSessions: RecentSession[];
  programItems: ProgramItem[];
}

// --- Log-session request shape ---
export interface LogSessionSide {
  completed: boolean;
  rawNote?: string;
}

export interface LogSessionExercise {
  exerciseId: string;
  sides: Partial<Record<Side, LogSessionSide>>;
}

export interface LogSessionRequest {
  sessionDate: string;
  completedExercises: LogSessionExercise[];
  painRating: number;
  stiffnessRating: number;
  confidenceRating: number;
}
