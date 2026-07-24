import { useCallback, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { AuthGate } from "@/components/AuthGate";
import { LogSession } from "@/views/LogSession";
import { Dashboard } from "@/views/Dashboard";
import {
  fetchDashboard,
  getApiKey,
  clearApiKey,
  UnauthorizedError,
} from "@/lib/api";
import type { DashboardPayload } from "@/lib/types";
import {
  emptySessionForm,
  withProgramSeeded,
  type SessionFormState,
} from "@/lib/session-form";

export default function App() {
  const [hasKey, setHasKey] = useState<boolean>(() => Boolean(getApiKey()));
  const [authError, setAuthError] = useState<string | undefined>();
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  // The in-progress session log. Held HERE, above <Tabs>, because Base UI
  // unmounts inactive TabsContent — state inside LogSession is destroyed on
  // every tab switch. Cleared only after a successful submit.
  const [sessionForm, setSessionForm] = useState<SessionFormState>(() =>
    emptySessionForm([])
  );

  // Seed rows for the real program once it loads (and for anything the physio
  // adds later) without touching what has already been entered.
  useEffect(() => {
    if (!data) return;
    setSessionForm((prev) => withProgramSeeded(prev, data.programItems));
  }, [data]);

  // Any 401 anywhere funnels here: drop the key, re-show the gate with an error.
  const handleUnauthorized = useCallback(() => {
    clearApiKey();
    setData(null);
    setHasKey(false);
    setAuthError("That access key was rejected. Please try again.");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      setData(await fetchDashboard());
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setLoadError(err instanceof Error ? err.message : "Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, [handleUnauthorized]);

  useEffect(() => {
    if (hasKey) load();
  }, [hasKey, load]);

  if (!hasKey) {
    return (
      <>
        <AuthGate
          error={authError}
          onUnlock={() => {
            setAuthError(undefined);
            setHasKey(true);
          }}
        />
        <Toaster />
      </>
    );
  }

  return (
    <div className="min-h-svh bg-background">
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Rehab Recovery</h1>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearApiKey();
              setData(null);
              setHasKey(false);
            }}
          >
            Lock
          </Button>
        </header>

        <Tabs defaultValue="dashboard">
          <TabsList className="mb-6">
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="log">Log Session</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard">
            {loading && !data ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : loadError ? (
              <p className="text-sm text-destructive">{loadError}</p>
            ) : data ? (
              <Dashboard
                adherence={data.adherence}
                asymmetryResults={data.asymmetryResults}
                escalations={data.escalations}
                trend={data.trend}
                recentSessions={data.recentSessions}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="log">
            {data ? (
              <LogSession
                programItems={data.programItems}
                value={sessionForm}
                onChange={setSessionForm}
                onSubmitted={() => setSessionForm(emptySessionForm(data.programItems))}
                onUnauthorized={handleUnauthorized}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Loading program…</p>
            )}
          </TabsContent>
        </Tabs>
      </div>
      <Toaster />
    </div>
  );
}
