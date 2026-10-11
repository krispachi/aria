export type NotificationMode = "once" | "minimal" | "full";

/** Only controls automatic informational messages; prompts and errors stay visible. */
export class NotificationPolicy {
  private shown = false;
  constructor(private state: { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }) {}
  async claim(mode: NotificationMode): Promise<boolean> {
    if (mode === "full") return true;
    if (this.shown || (mode === "once" && this.state.get<boolean>("ariaWelcomeShown"))) return false;
    this.shown = true;
    if (mode === "once") await this.state.update("ariaWelcomeShown", true);
    return true;
  }
}
