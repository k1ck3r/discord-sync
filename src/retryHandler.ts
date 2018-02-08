export class RetryHandler {
    private maxDelay = 20 * 1000;
    private baseDelay = 3 * 1000;
    private retries = 0;
    private timeout: NodeJS.Timer;

    public retry(callback: () => void): void {
        this.timeout = setTimeout(
            callback,
            // tslint:disable-next-line no-bitwise
            Math.min(this.maxDelay, (1 << this.retries++) * this.baseDelay),
        );
    }

    public reset(): void {
        clearTimeout(this.timeout);
        this.retries = 0;
    }
}
