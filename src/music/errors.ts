export class MusicError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class MusicBackendError extends MusicError {}
export class MusicBackendUnavailableError extends MusicBackendError {}
export class MusicLibraryError extends MusicError {}
