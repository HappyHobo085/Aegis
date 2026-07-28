// src/autopilot/timeout.ts
// Adaptive timeout utility to reduce flakiness in tests under varying system load

export class AdaptiveTimeout {
  private static baseMultiplier = 1;

  /**
   * Set the load multiplier based on system conditions
   * @param multiplier - Values > 1 increase timeouts, values < 1 decrease them (clamped to >= 1)
   */
  static setLoadMultiplier(multiplier: number) {
    this.baseMultiplier = Math.max(1, multiplier);
  }

  /**
   * Get adaptive timeout in milliseconds
   * @param baseMs - Base timeout in milliseconds
   * @returns Adjusted timeout based on current system load
   */
  static ms(baseMs: number): number {
    return Math.floor(baseMs * this.baseMultiplier);
  }

  /** Default base timeout (8 seconds) */
  static readonly DEFAULT_BASE = 8000;

  /**
   * Execute a promise with adaptive timeout
   * @param promise - Promise to execute
   * @param baseMs - Base timeout in milliseconds (default: 8000)
   * @param message - Error message if timeout occurs
   * @returns Promise result or throws on timeout
   */
  static async withTimeout<T>(
    promise: Promise<T>,
    baseMs: number = this.DEFAULT_BASE,
    message: string = 'Operation timed out',
  ): Promise<T> {
    const timeoutMs = this.ms(baseMs);
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
    ]);
  }
}
