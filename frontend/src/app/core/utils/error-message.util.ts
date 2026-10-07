/** The message to show a person when an API call fails: the server's own sentence when it sent one. */
export function errorMessage(err: unknown): string {
  const e = err as { error?: { error?: string }; message?: string; status?: number };
  if (e?.status === 0) return 'Cannot reach the API. Is the backend running on port 4000?';
  return e?.error?.error || e?.message || 'Unexpected error';
}
