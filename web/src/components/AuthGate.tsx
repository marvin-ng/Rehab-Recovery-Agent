import { useState } from "react";
import { setApiKey } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// The entry screen. Until a key is stored, this is the ONLY thing that renders.
// `error` is shown when a prior key was rejected with 401.
export function AuthGate({
  onUnlock,
  error,
}: {
  onUnlock: () => void;
  error?: string;
}) {
  const [value, setValue] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setApiKey(trimmed);
    onUnlock();
  }

  return (
    <div className="min-h-svh flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Enter access key</CardTitle>
          <CardDescription>
            This dashboard is private. Paste your access key to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="apikey">Access key</Label>
              <Input
                id="apikey"
                type="password"
                autoComplete="off"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="x-api-key"
              />
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
            <Button type="submit" disabled={!value.trim()}>
              Unlock
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
