export interface StreamSessionState {
  mode: "desktop" | "game";
  gameId?: number;
  pid?: number;
  windowHandle?: string;
}

let state: StreamSessionState = { mode: "desktop" };

export function getSessionState(): StreamSessionState {
  return state;
}

export function setSessionState(next: StreamSessionState): void {
  state = next;
}
