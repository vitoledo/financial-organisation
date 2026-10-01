export interface Heartbeat {
  status: string;
  finishedAt: string;
  error?: string;
  [key: string]: unknown;
}

export function evaluateHealth(input: {
  notionBeat: Heartbeat | null;
  sheetsBeat: Heartbeat | null;
  sheetsEnabled: boolean;
  staleHours: number;
  now: number;
}): string[];
