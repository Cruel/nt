export class CliCommandUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliCommandUsageError';
  }
}
