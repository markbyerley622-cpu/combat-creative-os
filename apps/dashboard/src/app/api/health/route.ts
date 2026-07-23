import { NextResponse } from 'next/server';

/**
 * Frontend-process liveness only ("is the dashboard's Next.js server up"),
 * not a control-plane endpoint — the dashboard has no business logic and no
 * DB/Temporal access (docs/architecture.md §2.1). Compare apps/api's /health,
 * which is the real control-plane liveness check.
 */
export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'dashboard',
    timestamp: new Date().toISOString(),
  });
}
