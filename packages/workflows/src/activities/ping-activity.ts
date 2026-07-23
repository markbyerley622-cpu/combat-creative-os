/**
 * Activities are where all I/O happens (docs/architecture.md §1 dependency
 * direction rule). This one does no real I/O yet — it exists to prove the
 * worker/workflow/activity wiring end-to-end before any real activity
 * (DB writes, provider calls, ffmpeg) is implemented in a later milestone.
 */
export async function pingActivity(message: string): Promise<string> {
  return `pong:${message}`;
}
