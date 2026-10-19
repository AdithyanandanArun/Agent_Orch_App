export interface RuntimeLike {
  isActive(sessionId: string): boolean;
}
